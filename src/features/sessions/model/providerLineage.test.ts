import { describe, expect, it } from "vitest";
import { externalLineage, resumeCommand } from "./providerLineage";
import type { ProviderLink } from "./session";

const link = (overrides: Partial<ProviderLink>): ProviderLink => ({
  providerSessionId: "id",
  harness: "claude",
  origin: "monocode",
  firstUserTurn: 0,
  createdAt: 1,
  ...overrides,
});

describe("externalLineage", () => {
  it("is null for a session that never left MonoCode", () => {
    expect(
      externalLineage({
        harness: "claude",
        providerSessionId: "c1",
        providerLinks: [link({ providerSessionId: "c1" })],
      }),
    ).toBeNull();
    expect(externalLineage({ harness: "codex" })).toBeNull();
  });

  it("describes an adopted chat and the providers it moved through", () => {
    const adopted = link({
      providerSessionId: "c1",
      origin: "external",
      source: "claude-desktop",
      adoptedAt: 5,
      syncedMtimeMs: 9,
    });
    expect(
      externalLineage({
        harness: "claude",
        // Live: switched again before the store linked it.
        providerSessionId: "c2",
        providerLinks: [
          adopted,
          link({ providerSessionId: "x1", harness: "codex", firstUserTurn: 3 }),
        ],
      }),
    ).toEqual({ adopted, chain: ["claude", "codex", "claude"], syncedAt: 9 });
  });

  it("marks a hand-back even for a chat that began in MonoCode", () => {
    const handed = link({ providerSessionId: "c1", handedBackAt: 7 });
    expect(
      externalLineage({
        harness: "claude",
        providerSessionId: "c1",
        providerLinks: [handed],
      }),
    ).toEqual({ chain: ["claude"], handedBack: handed });
  });
});

describe("resumeCommand", () => {
  it("resumes in the provider's CLI from the chat's folder", () => {
    expect(
      resumeCommand(link({ providerSessionId: "abc-1" }), "/work/app"),
    ).toBe("cd /work/app && claude --resume abc-1");
    expect(
      resumeCommand(
        link({ harness: "codex", providerSessionId: "t1" }),
        "/work/my app",
      ),
    ).toBe("cd '/work/my app' && codex resume t1");
  });

  it("has none for other accounts or other providers", () => {
    expect(
      resumeCommand(link({ providerAccountId: "work" }), "/work/app"),
    ).toBeNull();
    expect(resumeCommand(link({ harness: "cursor" }), "/work/app")).toBeNull();
    expect(resumeCommand(link({ providerAccountId: "default" }), "/w")).toBe(
      "cd /w && claude --resume id",
    );
  });
});
