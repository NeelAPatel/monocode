import { describe, expect, it } from "vitest";
import { adoptedLink, mergeForeignTurns } from "./externalSync";
import type { Block, ProviderLink } from "./session";

const user = (id: string, text: string, startedAt: number): Block => ({
  id,
  role: "user",
  text,
  startedAt,
});
const reply = (id: string, text: string): Block => ({
  id,
  role: "assistant",
  text,
});

describe("mergeForeignTurns", () => {
  const mine = [user("m1", "fix it", 1_000), reply("m2", "fixed")];

  it("appends turns another client added, after a notice", () => {
    const merged = mergeForeignTurns(
      mine,
      [user("f1", "now test it", 900_000), reply("f2", "tested")],
      { now: 5 },
    );
    expect(merged.added).toBe(1);
    expect(merged.blocks.map((block) => block.id)).toEqual([
      "m1",
      "m2",
      "external-sync-5",
      "f1",
      "f2",
    ]);
    expect(merged.blocks[2]).toMatchObject({
      role: "system",
      text: "Synced 1 turn added outside MonoCode.",
    });
  });

  it("ignores a tail with no new prompt or only MonoCode's own", () => {
    expect(mergeForeignTurns(mine, []).added).toBe(0);
    expect(mergeForeignTurns(mine, [reply("x", "late")]).blocks).toBe(mine);
    // MonoCode's prompt, written after the marker before a quit.
    expect(
      mergeForeignTurns(mine, [user("t1", "fix it", 2_000), reply("t2", "ok")])
        .added,
    ).toBe(0);
  });

  it("keeps a repeated prompt that came much later", () => {
    expect(
      mergeForeignTurns(mine, [user("t1", "fix it", 1_000 + 3_600_000)]).added,
    ).toBe(1);
  });

  it("reloads a rewritten transcript in full", () => {
    const merged = mergeForeignTurns(
      mine,
      [user("a", "x", 1), reply("b", "y"), user("c", "z", 2)],
      { rewritten: true, now: 7 },
    );
    expect(merged.added).toBe(2);
    expect(merged.blocks.map((block) => block.id)).toEqual([
      "a",
      "b",
      "c",
      "external-sync-7",
    ]);
  });
});

describe("adoptedLink", () => {
  const link: ProviderLink = {
    providerSessionId: "c1",
    harness: "claude",
    origin: "external",
    path: "/p/c1.jsonl",
    firstUserTurn: 0,
    createdAt: 1,
  };

  it("finds the adopted conversation the session is on", () => {
    expect(
      adoptedLink({ providerSessionId: "c1", providerLinks: [link] }),
    ).toBe(link);
  });

  it("is undefined after a switch away or for MonoCode's own", () => {
    expect(
      adoptedLink({ providerSessionId: "x1", providerLinks: [link] }),
    ).toBeUndefined();
    expect(
      adoptedLink({
        providerSessionId: "c1",
        providerLinks: [{ ...link, origin: "monocode" }],
      }),
    ).toBeUndefined();
  });
});
