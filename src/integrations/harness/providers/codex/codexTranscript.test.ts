import { describe, expect, it } from "vitest";
import {
  codexTranscriptSummary,
  codexTranscriptToBlocks,
  typedPrompt,
} from "./codexTranscript";
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
    // The attached image is noted, as Claude chats note theirs.
    expect(block.text).toBe("[image]\nfix the header");
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

describe("codexTranscriptToBlocks turn footer fields", () => {
  const userItem = (id: string, text: string) =>
    item({ type: "UserMessage", id, content: [{ type: "text", text }] });
  const started = (turnId: string) => ({
    type: "task_started",
    turn_id: turnId,
    started_at: 1,
  });
  const context = (turnId: string, model: string, effort = "medium") => ({
    type: "turn_context",
    turn_id: turnId,
    model,
    effort,
  });
  const tokens = (input: number, cached: number, output: number) => ({
    type: "token_count",
    last: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
    },
  });
  const complete = (turnId: string, durationMs: number) => ({
    type: "task_complete",
    turn_id: turnId,
    duration_ms: durationMs,
  });

  it("gives each prompt its turn id, duration, model and last token count", () => {
    const blocks = codexTranscriptToBlocks([
      started("t1"),
      context("t1", "gpt-x"),
      userItem("u1", "first"),
      tokens(100, 20, 5),
      tokens(200, 150, 9),
      complete("t1", 4_000),
      started("t2"),
      context("t2", "gpt-y"),
      userItem("u2", "second"),
      // A steer mid-turn is its own message but not a new turn.
      userItem("u3", "also this"),
      complete("t2", 1_500),
    ]);
    const users = blocks.filter((block) => block.role === "user");
    expect(
      users.map(({ id, providerTurnId, durationMs }) => ({
        id,
        providerTurnId,
        durationMs,
      })),
    ).toEqual([
      { id: "u1", providerTurnId: "t1", durationMs: 4_000 },
      { id: "u2", providerTurnId: "t2", durationMs: 1_500 },
      { id: "u3", providerTurnId: undefined, durationMs: undefined },
    ]);
    expect(users[0].turnMetrics).toEqual({
      inputTokens: 200,
      outputTokens: 9,
      cacheReadTokens: 150,
      cacheHitPercent: 75,
    });
    expect(users[0].turnModel).toMatchObject({ harness: "codex", id: "gpt-x" });
    expect(users[1].turnModel).toMatchObject({ id: "gpt-y" });
  });

  it("keeps an unfinished last turn's id and model but no duration", () => {
    const [user] = codexTranscriptToBlocks([
      started("t1"),
      context("t1", "gpt-x"),
      userItem("u1", "go"),
    ]);
    expect(user).toMatchObject({ providerTurnId: "t1" });
    expect(user.turnModel).toMatchObject({ id: "gpt-x" });
    expect(user.durationMs).toBeUndefined();
  });

  it("summarizes the last model and effort", () => {
    expect(
      codexTranscriptSummary([
        context("t1", "gpt-x", "high"),
        context("t2", "gpt-y", "low"),
      ]),
    ).toEqual({ model: "gpt-y", effort: "low" });
  });
});

describe("codexTranscriptToBlocks attached images", () => {
  const user = (content: unknown[]) =>
    codexTranscriptToBlocks([
      item({ type: "UserMessage", id: "u1", content }),
    ])[0];

  it("notes images sent without text", () => {
    expect(
      user([
        { type: "local_image", path: "images/red.png" },
        { type: "local_image", path: "images/blue.png" },
      ]),
    ).toMatchObject({ role: "user", text: "[2 images]" });
  });

  it("keeps the TUI's own placeholders and adds a note otherwise", () => {
    expect(
      user([
        { type: "local_image", path: "/p/blue.png" },
        { type: "text", text: "[Image #1]  notes.md  What day?" },
      ]).text,
    ).toBe("[Image #1]  notes.md  What day?");
    expect(
      user([
        { type: "image", image_url: "data:" },
        { type: "text", text: "what is this?" },
      ]).text,
    ).toBe("[image]\nwhat is this?");
  });

  it("reads a skill invocation as typed", () => {
    expect(
      user([
        { type: "text", text: "$fruit-facts  give me the fact." },
        { type: "skill", name: "fruit-facts", path: "/p/SKILL.md" },
      ]).text,
    ).toBe("$fruit-facts  give me the fact.");
  });
});
