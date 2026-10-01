import type {
  Block,
  TurnMetrics,
} from "../../../../features/sessions/model/session";
import { asRecord, mapCodexNotification, stringField } from "./codexProtocol";
import {
  clipToolDetail,
  recordStartedAt,
  transcriptTurnModel,
  type TranscriptSummary,
} from "../../externalTranscript";

const COMPACTED_TEXT = "Context compacted";

/**
 * Codex Desktop prepends IDE and browser context to what the person typed and
 * heads their own words with this line.
 */
const TYPED_PROMPT_MARKER = "## My request:";

/** One Codex turn, from `task_started` to `task_complete`. */
type OpenTurn = {
  turnId?: string;
  model?: string;
  metrics?: TurnMetrics;
  durationMs?: number;
  /** The prompt that opened it; a steer sent mid-turn does not replace it. */
  user?: Block;
};

/**
 * Rebuild a read-only transcript from a Codex rollout written outside
 * MonoCode. The host passes only `item_completed` items (plus the older
 * `user_message`/`agent_message` events and compaction markers), in file
 * order, so every item is already final.
 */
export function codexTranscriptToBlocks(
  records: Record<string, unknown>[],
): Block[] {
  const blocks: Block[] = [];
  let turn: OpenTurn | null = null;
  const pushUser = (block: Block) => {
    blocks.push(block);
    if (turn?.turnId != null) {
      turn.user ??= block;
      return;
    }
    // Older rollouts have no task events; each prompt then opens a turn.
    if (turn) closeTurn(turn);
    turn = { user: block };
  };
  records.forEach((rec, index) => {
    const type = stringField(rec, "type");
    const at = recordStartedAt(rec);
    if (type === "task_started") {
      if (turn) closeTurn(turn);
      turn = { turnId: stringField(rec, "turn_id") };
      return;
    }
    if (type === "turn_context") {
      turn ??= { turnId: stringField(rec, "turn_id") };
      turn.model = stringField(rec, "model") ?? turn.model;
      return;
    }
    if (type === "token_count") {
      if (turn) turn.metrics = tokenMetrics(rec.last) ?? turn.metrics;
      return;
    }
    if (type === "task_complete") {
      if (!turn) return;
      if (typeof rec.duration_ms === "number")
        turn.durationMs = rec.duration_ms;
      closeTurn(turn);
      turn = null;
      return;
    }
    if (type === "user_message" || type === "agent_message") {
      const text = stringField(rec, "message")?.trim();
      if (text) {
        const block: Block = {
          id: `${type}-${index}`,
          role: type === "user_message" ? "user" : "assistant",
          text,
          ...(type === "user_message" ? at : {}),
        };
        if (type === "user_message") pushUser(block);
        else blocks.push(block);
      }
      return;
    }
    if (type === "compacted") {
      pushCompacted(blocks, index);
      return;
    }
    const item = asRecord(rec.item);
    if (type !== "item_completed" || !item) return;
    const id = stringField(item, "id") ?? `item-${index}`;
    switch (stringField(item, "type")) {
      case "UserMessage": {
        const text = userMessageText(item.content);
        if (text) pushUser({ id, role: "user", text, ...at });
        return;
      }
      case "AgentMessage": {
        const text = contentText(item.content);
        if (text) blocks.push({ id, role: "assistant", text });
        return;
      }
      case "Reasoning": {
        const text = contentText(item.summary_text);
        if (text) blocks.push({ id, role: "reasoning", text });
        return;
      }
      case "ContextCompaction":
        pushCompacted(blocks, index);
        return;
      case "DynamicToolCall":
        blocks.push(dynamicToolBlock(item, id));
        return;
      case "CommandExecution":
      case "FileChange":
      case "McpToolCall": {
        const block = liveToolBlock(item, id);
        if (block) blocks.push(block);
        return;
      }
    }
  });
  if (turn) closeTurn(turn);
  return blocks;
}

/**
 * Give the turn's prompt the footer fields a MonoCode turn has. The turn id
 * is what `thread/rollback` needs to edit the last turn.
 */
function closeTurn(turn: OpenTurn): void {
  const { user } = turn;
  if (!user) return;
  if (turn.turnId) user.providerTurnId = turn.turnId;
  if (turn.durationMs != null) user.durationMs = turn.durationMs;
  if (turn.model) user.turnModel = transcriptTurnModel("codex", turn.model);
  if (turn.metrics) user.turnMetrics = turn.metrics;
}

/** The rollout's `last_token_usage`, mapped as the live session maps it. */
function tokenMetrics(last: unknown): TurnMetrics | undefined {
  const usage = asRecord(last);
  if (!usage) return undefined;
  const respelled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(usage)) {
    respelled[camelCase(key)] = value;
  }
  const { events } = mapCodexNotification("thread/tokenUsage/updated", {
    tokenUsage: { last: respelled },
  });
  const event = events.find((entry) => entry.type === "turn.metrics");
  if (!event || event.type !== "turn.metrics") return undefined;
  const { type: _type, ...metrics } = event;
  return metrics;
}

/** The model and effort the thread last ran with. */
export function codexTranscriptSummary(
  records: Record<string, unknown>[],
): TranscriptSummary {
  const summary: TranscriptSummary = {};
  for (const rec of records) {
    if (stringField(rec, "type") !== "turn_context") continue;
    summary.model = stringField(rec, "model") ?? summary.model;
    summary.effort = stringField(rec, "effort") ?? summary.effort;
  }
  return summary;
}

/**
 * Rollout items are the app-server's items in another spelling
 * (`CommandExecution`, `aggregated_output`). Respelling them lets the live
 * mapper title and preview them exactly as a MonoCode Codex session would.
 */
function liveToolBlock(
  item: Record<string, unknown>,
  id: string,
): Block | null {
  const { events } = mapCodexNotification("item/completed", {
    item: appServerItem(item, id),
  });
  const event = events.find((entry) => entry.type === "tool.updated");
  if (!event || event.type !== "tool.updated") return null;
  const output =
    stringField(item, "aggregated_output") ?? outputText(item.result);
  const detail = clipToolDetail(event.detail ?? output ?? "");
  return {
    id,
    role: "tool",
    text: "",
    tool: {
      callId: id,
      title: event.title,
      kind: event.kind,
      status: event.status,
      ...(detail ? { detail } : {}),
      ...(event.preview ? { preview: event.preview } : {}),
    },
  };
}

function appServerItem(
  item: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(item)) {
    out[camelCase(key)] = value;
  }
  const type = stringField(item, "type") ?? "";
  out.type = type.charAt(0).toLowerCase() + type.slice(1);
  if (type === "FileChange") out.changes = fileChanges(item.changes);
  if (type === "CommandExecution") commandExecutionShape(out);
  return out;
}

/**
 * Current rollouts store `command` as an argv array, `parsed_cmd` for the
 * command actions, and `cwd` as a file URL; the live mapper wants a string,
 * `commandActions`, and a path.
 */
function commandExecutionShape(out: Record<string, unknown>): void {
  const { command, cwd } = out;
  if (
    Array.isArray(command) &&
    command.every((part) => typeof part === "string")
  ) {
    const argv = command as string[];
    out.command =
      argv.length === 3 && (argv[1] === "-lc" || argv[1] === "-c")
        ? argv[2]
        : argv.join(" ");
  }
  if (!Array.isArray(out.commandActions) && Array.isArray(out.parsedCmd)) {
    out.commandActions = out.parsedCmd;
  }
  if (typeof cwd === "string" && cwd.startsWith("file://")) {
    try {
      out.cwd = decodeURIComponent(new URL(cwd).pathname);
    } catch {
      // Keep the raw value when it is not a valid URL.
    }
  }
}

/** Rollouts key changes by path; the app-server lists `{path, diff}`. */
function fileChanges(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const row = asRecord(entry);
      return row ? [row] : [];
    });
  }
  const byPath = asRecord(value);
  if (!byPath) return [];
  return Object.entries(byPath).map(([path, change]) => {
    const row = asRecord(change);
    const diff = stringField(row, "unified_diff") ?? stringField(row, "diff");
    return { path, ...(diff ? { diff } : {}) };
  });
}

function dynamicToolBlock(item: Record<string, unknown>, id: string): Block {
  const tool = stringField(item, "tool") ?? "tool";
  const namespace = stringField(item, "namespace");
  const detail = clipToolDetail(outputText(item.content_items) ?? "");
  return {
    id,
    role: "tool",
    text: "",
    tool: {
      callId: id,
      title: namespace ? `${namespace}:${tool}` : tool,
      kind: "other",
      status: item.success === false ? "failed" : "completed",
      ...(detail ? { detail } : {}),
    },
  };
}

function pushCompacted(blocks: Block[], index: number): void {
  // A rollout marks one compaction twice: the item and the rewrite record.
  if (blocks[blocks.length - 1]?.text === COMPACTED_TEXT) return;
  blocks.push({
    id: `compacted-${index}`,
    role: "system",
    text: COMPACTED_TEXT,
  });
}

/**
 * What the person sent. Attached images are `local_image`/`image` parts;
 * the TUI already writes an `[Image #n]` placeholder into the text for each,
 * so a note is added only when nothing else marks them.
 */
function userMessageText(content: unknown): string {
  const text = typedPrompt(contentText(content));
  const images = Array.isArray(content)
    ? content.filter((part) => {
        const kind = stringField(asRecord(part), "type");
        return kind === "local_image" || kind === "image";
      }).length
    : 0;
  if (!images || text.includes("[Image")) return text;
  const note = images === 1 ? "[image]" : `[${images} images]`;
  return text ? `${note}\n${text}` : note;
}

export function typedPrompt(text: string): string {
  const at = text.lastIndexOf(TYPED_PROMPT_MARKER);
  return at < 0 ? text : text.slice(at + TYPED_PROMPT_MARKER.length).trim();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : (stringField(asRecord(part), "text") ?? ""),
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function outputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return contentText(value) || undefined;
  const rec = asRecord(value);
  if (!rec) return undefined;
  return contentText(rec.content) || undefined;
}

function camelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
