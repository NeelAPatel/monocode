import { describe, expect, it } from "vitest";
import { codexTranscriptToBlocks, typedPrompt } from "./codexTranscript";
import { EXTERNAL_TOOL_DETAIL_LIMIT } from "../../externalTranscript";

// Synthetic records shaped like a Codex rollout, trimmed by the host.
const item = (value: Record<string, unknown>) => ({
  type: "item_completed",
  timestamp: "2026-01-02T03:04:05.000Z",
  item: value,
});

describe("codexTranscriptToBlocks", () => {
  it("renders the item_completed stream as one conversation", () => {
    const blocks = codexTranscriptToBlocks([
      item({
        type: "UserMessage",
        id: "u1",
        content: [{ type: "text", text: "run the tests", text_elements: [] }],
      }),
      item({
        type: "Reasoning",
        id: "r1",
        summary_text: ["Plan: run npm test.", null],
      }),
      item({ type: "Reasoning", id: "r2", summary_text: [] }),
      item({
        type: "AgentMessage",
        id: "a1",
        phase: "commentary",
        content: [{ type: "Text", text: "Running them now." }],
      }),
      item({
        type: "CommandExecution",
        id: "c1",
        command: "npm test",
        cwd: "/work/app",
        aggregated_output: "1 failing",
        exit_code: 1,
        status: "failed",
      }),
      item({
        type: "AgentMessage",
        id: "a2",
        phase: "final_answer",
        content: [{ type: "Text", text: "One test fails." }],
      }),
    ]);
    expect(blocks.map((block) => [block.role, block.text])).toEqual([
      ["user", "run the tests"],
      ["reasoning", "Plan: run npm test."],
      ["assistant", "Running them now."],
      ["tool", ""],
      ["assistant", "One test fails."],
    ]);
    expect(blocks[0].startedAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    expect(blocks[3].tool).toMatchObject({
      callId: "c1",
      kind: "execute",
      status: "failed",
      detail: "1 failing",
    });
    expect(blocks[3].tool?.title).toBeTruthy();
  });

  it("previews file changes keyed by path", () => {
    const [block] = codexTranscriptToBlocks([
      item({
        type: "FileChange",
        id: "f1",
        status: "completed",
        changes: {
          "/work/app/src/a.ts": {
            type: "update",
            unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
            move_path: null,
          },
        },
      }),
    ]);
    expect(block.tool).toMatchObject({ kind: "edit", status: "completed" });
    expect(block.tool?.title).toContain("a.ts");
  });

  it("shows MCP and dynamic tool calls with their output", () => {
    const blocks = codexTranscriptToBlocks([
      item({
        type: "McpToolCall",
        id: "m1",
        server: "docs",
        tool: "search",
        arguments: { query: "x" },
        result: {
          content: [{ type: "text", text: "found it" }],
          isError: false,
        },
        status: "completed",
      }),
      item({
        type: "DynamicToolCall",
        id: "d1",
        namespace: "collaboration",
        tool: "spawn_agent",
        arguments: {},
        content_items: [{ type: "input_text", text: "spawned" }],
        success: false,
      }),
    ]);
    expect(blocks[0].tool).toMatchObject({
      title: "docs:search",
      detail: "found it",
    });
    expect(blocks[1].tool).toMatchObject({
      title: "collaboration:spawn_agent",
      status: "failed",
      detail: "spawned",
    });
  });

  it("marks a compaction once and clips huge output", () => {
    const blocks = codexTranscriptToBlocks([
      item({ type: "ContextCompaction", id: "k1" }),
      { type: "compacted", timestamp: "t" },
      item({
        type: "CommandExecution",
        id: "c1",
        command: "cat big.log",
        aggregated_output: "x".repeat(EXTERNAL_TOOL_DETAIL_LIMIT + 3),
        status: "completed",
      }),
    ]);
    expect(blocks.map((block) => block.role)).toEqual(["system", "tool"]);
    expect(blocks[0].text).toBe("Context compacted");
    expect(blocks[1].tool?.detail).toMatch(/3 more characters not shown$/);
  });

  it("shows only what the person typed under Codex Desktop's context", () => {
    const [block] = codexTranscriptToBlocks([
      item({
        type: "UserMessage",
        id: "u1",
        content: [
          {
            type: "text",
            text: "# Files mentioned by the user:\n\n## a.ts: /p/a.ts\n\n## My request:\nfix the header\n",
          },
          { type: "image", text: null },
        ],
      }),
    ]);
    expect(block.text).toBe("fix the header");
    expect(typedPrompt("plain prompt")).toBe("plain prompt");
  });

  it("reads the older user_message and agent_message events", () => {
    const blocks = codexTranscriptToBlocks([
      {
        type: "user_message",
        timestamp: "2026-01-02T03:04:05.000Z",
        message: "hi",
      },
      { type: "agent_message", message: "hello" },
      { type: "agent_message", message: "   " },
    ]);
    expect(blocks.map((block) => [block.role, block.text])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
  });
});
