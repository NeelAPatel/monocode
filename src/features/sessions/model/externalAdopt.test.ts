import { describe, expect, it } from "vitest";
import { adoptExternalSession } from "./externalAdopt";

// Synthetic records shaped like the host's trimmed Claude transcript.
const claudeRecords = [
  {
    type: "user",
    uuid: "u1",
    timestamp: "2026-01-02T03:04:05.000Z",
    origin: { kind: "human" },
    message: { role: "user", content: "fix the login bug" },
  },
  {
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-01-02T03:04:09.000Z",
    effort: "high",
    message: {
      id: "m1",
      role: "assistant",
      model: "claude-opus-5-5",
      usage: { input_tokens: 3, output_tokens: 2 },
      content: [{ type: "text", text: "Done." }],
    },
  },
];

const external = {
  provider: "claude" as const,
  id: "ext-1",
  title: "Login fix",
  cwd: "/work/app",
  source: "claude-desktop",
};

describe("adoptExternalSession", () => {
  it("builds a resumable session on the default account", () => {
    const result = adoptExternalSession({
      external,
      records: claudeRecords,
      projectCwd: "/work/app/",
    });
    if (!("session" in result)) throw new Error(result.blocked);
    const { session } = result;
    expect(session).toMatchObject({
      harness: "claude",
      cwd: "/work/app/",
      title: "Login fix",
      model: "claude:opus-5-5",
      providerSessionId: "ext-1",
      providerAccountId: "default",
    });
    expect(session.blocks.map((block) => block.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(session.blocks[0]).toMatchObject({
      durationMs: 4_000,
      turnModel: { id: "claude:opus-5-5" },
    });
  });

  it("falls back to the default model for an id the catalog lacks", () => {
    const records = structuredClone(claudeRecords);
    (records[1].message as { model: string }).model = "claude-future-9";
    const result = adoptExternalSession({
      external,
      records,
      projectCwd: "/work/app",
    });
    if (!("session" in result)) throw new Error(result.blocked);
    expect(result.session.model).not.toBe("claude-future-9");
  });

  it("refuses chats that ran in another folder, remote projects, and empty chats", () => {
    expect(
      adoptExternalSession({
        external: { ...external, cwd: "/work/app/web" },
        records: claudeRecords,
        projectCwd: "/work/app",
      }),
    ).toEqual({ blocked: expect.stringContaining("/work/app/web") });
    expect(
      adoptExternalSession({
        external,
        records: claudeRecords,
        projectCwd: "remote://env/work/app",
      }),
    ).toHaveProperty("blocked");
    expect(
      adoptExternalSession({ external, records: [], projectCwd: "/work/app" }),
    ).toHaveProperty("blocked");
  });

  it("rebuilds Codex threads with their turn ids", () => {
    const result = adoptExternalSession({
      external: { ...external, provider: "codex", source: "Codex Desktop" },
      records: [
        { type: "task_started", turn_id: "t1" },
        {
          type: "item_completed",
          timestamp: "2026-01-02T03:04:05.000Z",
          item: {
            type: "UserMessage",
            id: "u1",
            content: [{ type: "text", text: "hi" }],
          },
        },
        { type: "task_complete", turn_id: "t1", duration_ms: 10 },
      ],
      projectCwd: "/work/app",
    });
    if (!("session" in result)) throw new Error(result.blocked);
    expect(result.session.harness).toBe("codex");
    expect(result.session.blocks[0]).toMatchObject({ providerTurnId: "t1" });
  });
});
