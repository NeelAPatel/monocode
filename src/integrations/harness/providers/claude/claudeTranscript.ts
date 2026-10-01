import type { Block } from "../../../../features/sessions/model/session";
import {
  asRecord,
  assistantMessageId,
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolUses,
  previewFromTool,
  stringField,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolTitle,
  turnMetricsFromResult,
} from "./claudeProtocol";
import {
  clipToolDetail,
  recordStartedAt,
  transcriptTurnModel,
  type TranscriptSummary,
} from "../../externalTranscript";

/** What Claude writes into the user turn when the person stops it. */
const INTERRUPT_PREFIX = "[Request interrupted by user";

/** Model id Claude writes on replies it generated itself, such as errors. */
const SYNTHETIC_MODEL = "<synthetic>";

/** The usage counts `turnMetricsFromResult` reads. */
const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

const COMPACTED_TEXT = "Context compacted";

/** One prompt and everything after it, until the next prompt. */
type OpenTurn = {
  user: Block;
  lastAt?: number;
  /** Claude's own measure of the turn, when it wrote one. */
  durationMs?: number;
  model?: string;
  /** Per API message; its records repeat the usage, the last one is final. */
  usage: Map<string, Record<string, unknown>>;
};

/**
 * Rebuild a read-only transcript from a Claude session file written outside
 * MonoCode. Records arrive in file order, already limited to conversation
 * records by the host. Claude stores one content block per assistant record,
 * so consecutive records that share a message id are one reply.
 */
export function claudeTranscriptToBlocks(
  records: Record<string, unknown>[],
): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<
    string,
    { block: Block; name: string; input: Record<string, unknown> }
  >();
  let turn: OpenTurn | null = null;
  for (let index = 0; index < records.length; index++) {
    const rec = records[index];
    const type = stringField(rec, "type");
    if (type === "assistant") {
      const messageId = assistantMessageId(rec);
      const group = [rec];
      while (
        messageId &&
        stringField(records[index + 1], "type") === "assistant" &&
        assistantMessageId(records[index + 1]) === messageId
      ) {
        group.push(records[++index]);
      }
      group.sort((a, b) => blockIndex(a) - blockIndex(b));
      for (const part of group) {
        appendAssistantPart(blocks, tools, part, messageId);
        if (turn) noteRecord(turn, part, messageId);
      }
      continue;
    }
    if (type === "system") {
      if (
        turn &&
        stringField(rec, "subtype") === "turn_duration" &&
        typeof rec.durationMs === "number"
      ) {
        turn.durationMs = rec.durationMs;
      }
      continue;
    }
    if (type !== "user") continue;
    if (rec.isCompactSummary === true) {
      // The summary that replaces the history is model-facing.
      if (blocks[blocks.length - 1]?.text !== COMPACTED_TEXT) {
        blocks.push({
          id: stringField(rec, "uuid") ?? `compacted-${index}`,
          role: "system",
          text: COMPACTED_TEXT,
        });
      }
      continue;
    }
    for (const result of toolResultsFromUserMessage(rec)) {
      const tool = tools.get(result.toolUseId);
      if (!tool?.block.tool) continue;
      const detail = clipToolDetail(result.text);
      tool.block.tool.status = result.isError ? "failed" : "completed";
      tool.block.tool.detail = detail || undefined;
      tool.block.tool.preview = previewFromTool(tool.name, tool.input, detail);
    }
    const prompt = claudePromptText(rec);
    // Tool results are the agent's work too; the next prompt is not.
    if (prompt === null && turn) noteRecord(turn, rec);
    if (prompt !== null) {
      if (turn) closeTurn(turn);
      const user: Block = {
        id: stringField(rec, "uuid") ?? `user-${index}`,
        role: "user",
        text: prompt,
        ...recordStartedAt(rec),
      };
      blocks.push(user);
      turn = { user, usage: new Map() };
    }
  }
  if (turn) closeTurn(turn);
  return blocks;
}

function noteRecord(
  turn: OpenTurn,
  rec: Record<string, unknown>,
  messageId?: string,
): void {
  const at = recordStartedAt(rec).startedAt;
  if (at != null) turn.lastAt = Math.max(turn.lastAt ?? at, at);
  if (stringField(rec, "type") !== "assistant") return;
  const message = asRecord(rec.message);
  const model = stringField(message, "model");
  if (model && model !== SYNTHETIC_MODEL) turn.model = model;
  const usage = asRecord(message?.usage);
  const key = messageId ?? stringField(rec, "uuid");
  if (usage && key) turn.usage.set(key, usage);
}

/**
 * Give the prompt the footer fields a MonoCode turn has: how long the agent
 * worked (prompt to last record), the model, and the summed token usage.
 */
function closeTurn(turn: OpenTurn): void {
  const { user } = turn;
  if (turn.durationMs != null) {
    user.durationMs = turn.durationMs;
  } else if (user.startedAt != null && turn.lastAt != null) {
    user.durationMs = Math.max(0, turn.lastAt - user.startedAt);
  }
  if (turn.model) user.turnModel = transcriptTurnModel("claude", turn.model);
  const total: Record<string, number> = {};
  for (const usage of turn.usage.values()) {
    for (const key of USAGE_KEYS) {
      const value = usage[key];
      if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
    }
  }
  const metrics = turnMetricsFromResult({ usage: total });
  if (metrics) user.turnMetrics = metrics;
}

/** The model and effort the chat last ran with. */
export function claudeTranscriptSummary(
  records: Record<string, unknown>[],
): TranscriptSummary {
  const summary: TranscriptSummary = {};
  for (const rec of records) {
    if (stringField(rec, "type") !== "assistant") continue;
    const model = stringField(asRecord(rec.message), "model");
    if (model && model !== SYNTHETIC_MODEL) summary.model = model;
    const effort = stringField(rec, "effort");
    if (effort) summary.effort = effort;
  }
  return summary;
}

function appendAssistantPart(
  blocks: Block[],
  tools: Map<
    string,
    { block: Block; name: string; input: Record<string, unknown> }
  >,
  rec: Record<string, unknown>,
  messageId: string | undefined,
): void {
  const uuid = stringField(rec, "uuid") ?? `${messageId}-${blocks.length}`;
  for (const text of assistantThinkingBlocks(rec)) {
    blocks.push({ id: `${uuid}-reasoning`, role: "reasoning", text });
  }
  for (const text of assistantTextBlocks(rec)) {
    const last = blocks[blocks.length - 1];
    // Split text parts of one reply read as one message.
    if (
      last?.role === "assistant" &&
      messageId &&
      last.id.startsWith(`${messageId}:`)
    ) {
      last.text = `${last.text}\n\n${text}`;
      continue;
    }
    blocks.push({
      id: `${messageId ?? uuid}:${uuid}`,
      role: "assistant",
      text,
    });
  }
  for (const use of assistantToolUses(rec)) {
    const block: Block = {
      id: use.id,
      role: "tool",
      text: "",
      tool: {
        callId: use.id,
        title: toolTitle(use.name, use.input),
        kind: toolKindFromName(use.name),
        // A call with no recorded result was cut off when the session ended.
        status: "cancelled",
        preview: previewFromTool(use.name, use.input),
      },
    };
    tools.set(use.id, { block, name: use.name, input: use.input });
    blocks.push(block);
  }
}

/**
 * What a person typed. Tool results, injected context, and harness
 * notifications share the `user` record type and are left out. The host's
 * `claude_prompt_text` applies the same rule when titling the session.
 */
export function claudePromptText(rec: Record<string, unknown>): string | null {
  if (
    stringField(rec, "type") !== "user" ||
    rec.isMeta === true ||
    rec.isSidechain === true ||
    rec.isCompactSummary === true ||
    rec.toolUseResult !== undefined
  ) {
    return null;
  }
  const originKind = stringField(asRecord(rec.origin), "kind");
  if (originKind && originKind !== "human") return null;
  const human = originKind === "human";
  const content = asRecord(rec.message)?.content;
  let text = "";
  let images = 0;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const row = asRecord(block);
      const kind = stringField(row, "type");
      if (kind === "text" && typeof row?.text === "string")
        parts.push(row.text);
      else if (kind === "image") images++;
      else if (kind === "tool_result") return null;
    }
    text = parts.join("\n");
  }
  text = text.trim();
  if (text.startsWith(INTERRUPT_PREFIX) || text.includes("<local-command-")) {
    return null;
  }
  // A slash command, skill, or plugin skill reads as the person typed it.
  // Built-in commands such as `/compact` echo the same tags without a human
  // origin, alongside the bare command, and are not prompts.
  const command = tagText(text, "command-name");
  if (command != null) {
    if (!human) return null;
    text = `${command} ${tagText(text, "command-args") ?? ""}`.trim();
  } else if (!human && /^\/\S+$/.test(text)) {
    return null;
  }
  // The TUI writes an `[Image #n]` placeholder for each; note them only
  // when nothing in the text does.
  if (images && !text.includes("[Image")) {
    const note = images === 1 ? "[image]" : `[${images} images]`;
    text = text ? `${note}\n${text}` : note;
  }
  return text || null;
}

function tagText(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? match[1].trim() : null;
}

function blockIndex(rec: Record<string, unknown>): number {
  return typeof rec.apiBlockIndex === "number" ? rec.apiBlockIndex : 0;
}
