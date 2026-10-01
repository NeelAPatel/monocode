import type { Block, ProviderLink, Session } from "./session";

/** Within this of a prompt MonoCode sent, the same text is that prompt. */
const SAME_PROMPT_WINDOW_MS = 5 * 60_000;

/**
 * The adopted conversation a session is on now, when it can be checked for
 * writes by another client.
 */
export function adoptedLink(
  session: Pick<Session, "providerSessionId" | "providerLinks">,
): (ProviderLink & { harness: "claude" | "codex"; path: string }) | undefined {
  const link = session.providerLinks?.find(
    (entry) => entry.providerSessionId === session.providerSessionId,
  );
  if (
    link?.origin !== "external" ||
    !link.path ||
    (link.harness !== "claude" && link.harness !== "codex")
  ) {
    return undefined;
  }
  return link as ProviderLink & { harness: "claude" | "codex"; path: string };
}

/** Why a turn cannot start while another app has the chat open. */
export function externalOwnerNotice(owner: {
  app: string;
  status?: string;
}): string {
  const app = OWNER_APP_LABEL[owner.app] ?? "Another app";
  const doing = owner.status === "busy" ? "is working in" : "has";
  return `${app} ${doing} this chat open right now. Finish or close it there, then send again here, so the two do not mix up its turns.`;
}

const OWNER_APP_LABEL: Record<string, string> = {
  "claude-desktop": "Claude Desktop",
  cli: "Claude Code",
  "codex-desktop": "Codex Desktop",
  codex: "Codex",
};

export type ForeignMerge = { blocks: Block[]; added: number };

/**
 * Turns another client appended to an adopted transcript, added after the
 * session's own. Records past MonoCode's sync marker hold only those turns,
 * but a prompt MonoCode sent can land there too if it quit before moving the
 * marker; a recent prompt with the same text is that one, not a new turn.
 * Bookkeeping records with no prompt add nothing.
 */
export function mergeForeignTurns(
  blocks: Block[],
  tail: Block[],
  options: { rewritten?: boolean; now?: number } = {},
): ForeignMerge {
  const now = options.now ?? Date.now();
  if (options.rewritten) {
    const added = tail.filter((block) => block.role === "user").length;
    return {
      blocks: [
        ...tail,
        notice(
          "This chat changed outside MonoCode and was reloaded from its transcript.",
          now,
        ),
      ],
      added,
    };
  }
  const own = blocks.filter((block) => block.role === "user");
  const start = tail.findIndex(
    (block) =>
      block.role === "user" &&
      !own.some(
        (mine) =>
          mine.text === block.text &&
          mine.startedAt != null &&
          block.startedAt != null &&
          Math.abs(mine.startedAt - block.startedAt) < SAME_PROMPT_WINDOW_MS,
      ),
  );
  if (start < 0) return { blocks, added: 0 };
  const appended = tail.slice(start);
  const added = appended.filter((block) => block.role === "user").length;
  return {
    blocks: [
      ...blocks,
      notice(
        `Synced ${added} ${added === 1 ? "turn" : "turns"} added outside MonoCode.`,
        now,
      ),
      ...appended,
    ],
    added,
  };
}

function notice(text: string, at: number): Block {
  return { id: `external-sync-${at}`, role: "system", text };
}
