import { describe, expect, it } from "vitest";
import { claudePromptText, claudeTranscriptToBlocks } from "./claudeTranscript";
import { EXTERNAL_TOOL_DETAIL_LIMIT } from "../../externalTranscript";

// Synthetic records shaped like a Claude session file, trimmed by the host.
const prompt = (uuid: string, content: unknown, extra = {}) => ({
  type: "user",
  uuid,
  timestamp: "2026-01-02T03:04:05.000Z",
  origin: { kind: "human" },
  message: { role: "user", content },
  ...extra,
});

const assistant = (
  uuid: string,
  messageId: string,
  apiBlockIndex: number,
  block: Record<string, unknown>,
) => ({
  type: "assistant",
  uuid,
  apiBlockIndex,
  message: { id: messageId, role: "assistant", content: [block] },
});

const toolResult = (
  uuid: string,
  toolUseId: string,
  content: unknown,
  isError = false,
) => ({
  type: "user",
  uuid,
  toolUseResult: true,
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      },
    ],
  },
});

describe("claudeTranscriptToBlocks", () => {
  it("rebuilds a reply split one block per record, in block order", () => {
    const blocks = claudeTranscriptToBlocks([
      prompt("u1", "read the readme"),
      // Out of order in the file: apiBlockIndex decides.
      assistant("a2", "m1", 1, { type: "text", text: "Reading it now." }),
      assistant("a1", "m1", 0, {
        type: "thinking",
        thinking: "",
        signature: "sig",
      }),
      assistant("a3", "m1", 2, {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { file_path: "/p/README.md" },
      }),
      toolResult("u2", "t1", "# Demo"),
      assistant("a4", "m2", 0, { type: "text", text: "It is a demo." }),
      assistant("a5", "m2", 1, { type: "text", text: "Nothing else." }),
    ]);
    expect(blocks.map((block) => [block.role, block.text])).toEqual([
      ["user", "read the readme"],
      ["assistant", "Reading it now."],
      ["tool", ""],
      ["assistant", "It is a demo.\n\nNothing else."],
    ]);
    expect(blocks[0].startedAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    expect(blocks[2].tool).toMatchObject({
      callId: "t1",
      kind: "read",
      status: "completed",
      detail: "# Demo",
    });
    expect(blocks[2].tool?.title).toBeTruthy();
  });

  it("keeps non-empty reasoning and marks failed and unanswered tools", () => {
    const blocks = claudeTranscriptToBlocks([
      prompt("u1", "run tests"),
      assistant("a1", "m1", 0, {
        type: "thinking",
        thinking: "Plan: run npm test.",
      }),
      assistant("a2", "m1", 1, {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "npm test" },
      }),
      toolResult("u2", "t1", [{ type: "text", text: "1 failing" }], true),
      assistant("a3", "m2", 0, {
        type: "tool_use",
        id: "t2",
        name: "Bash",
        input: { command: "npm test -- --watch" },
      }),
    ]);
    expect(blocks.map((block) => block.role)).toEqual([
      "user",
      "reasoning",
      "tool",
      "tool",
    ]);
    expect(blocks[1].text).toBe("Plan: run npm test.");
    expect(blocks[2].tool).toMatchObject({
      kind: "execute",
      status: "failed",
      detail: "1 failing",
    });
    expect(blocks[3].tool?.status).toBe("cancelled");
  });

  it("clips huge tool output", () => {
    const detail = claudeTranscriptToBlocks([
      assistant("a1", "m1", 0, {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: {},
      }),
      toolResult("u1", "t1", "x".repeat(EXTERNAL_TOOL_DETAIL_LIMIT + 5)),
    ])[0].tool?.detail;
    expect(detail?.startsWith("x".repeat(EXTERNAL_TOOL_DETAIL_LIMIT))).toBe(
      true,
    );
    expect(detail).toMatch(/5 more characters not shown$/);
  });

  it("ignores results for unknown tools and non-conversation records", () => {
    expect(
      claudeTranscriptToBlocks([
        toolResult("u1", "missing", "orphan"),
        { type: "attachment", uuid: "x" },
        { type: "system", uuid: "y" },
      ]),
    ).toEqual([]);
  });
});

describe("claudePromptText", () => {
  it("accepts typed prompts and notes attached images", () => {
    expect(claudePromptText(prompt("u", "  hello  "))).toBe("hello");
    expect(
      claudePromptText(
        prompt("u", [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png" },
          },
          { type: "text", text: "what is this?" },
        ]),
      ),
    ).toBe("[image]\nwhat is this?");
  });

  it("rejects injected, meta, notification, and tool-result records", () => {
    expect(claudePromptText(prompt("u", "x", { isMeta: true }))).toBeNull();
    expect(
      claudePromptText(
        prompt("u", "x", { origin: { kind: "task-notification" } }),
      ),
    ).toBeNull();
    expect(
      claudePromptText(prompt("u", "x", { toolUseResult: true })),
    ).toBeNull();
    expect(
      claudePromptText(prompt("u", "x", { isSidechain: true })),
    ).toBeNull();
    expect(claudePromptText(prompt("u", "   "))).toBeNull();
    expect(
      claudePromptText(
        prompt("u", "[Request interrupted by user for tool use]"),
      ),
    ).toBeNull();
    expect(
      claudePromptText({ type: "assistant", message: { content: "x" } }),
    ).toBeNull();
  });
});
