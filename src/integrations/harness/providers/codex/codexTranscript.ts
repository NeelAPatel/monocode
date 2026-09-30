import type { Block } from "../../../../features/sessions/model/session";
import { asRecord, mapCodexNotification, stringField } from "./codexProtocol";
import { clipToolDetail, recordStartedAt } from "../../externalTranscript";

const COMPACTED_TEXT = "Context compacted";

/**
 * Codex Desktop prepends IDE and browser context to what the person typed and
 * heads their own words with this line.
 */
const TYPED_PROMPT_MARKER = "## My request:";

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
  records.forEach((rec, index) => {
    const type = stringField(rec, "type");
    const at = recordStartedAt(rec);
    if (type === "user_message" || type === "agent_message") {
      const text = stringField(rec, "message")?.trim();
      if (text) {
        blocks.push({
          id: `${type}-${index}`,
          role: type === "user_message" ? "user" : "assistant",
          text,
          ...(type === "user_message" ? at : {}),
        });
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
        const text = typedPrompt(contentText(item.content));
        if (text) blocks.push({ id, role: "user", text, ...at });
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
  return blocks;
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
  return out;
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
