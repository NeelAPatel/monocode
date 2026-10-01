import { DEFAULT_PROVIDER_ACCOUNT_ID } from "../../providers/model/providerAccounts";
import type { HarnessId, ProviderLink } from "./session";

/** What the sidebar's External marker says about a session. */
export type ExternalLineage = {
  /** The adopted conversation, when the session began in another client. */
  adopted?: ProviderLink;
  /** Provider of each conversation the session ran on, oldest first. */
  chain: HarnessId[];
  /** Latest hand-back to another client, while it lasts. */
  handedBack?: ProviderLink;
  /** When MonoCode last caught up with the adopted transcript. */
  syncedAt?: number;
};

/**
 * `null` for a session that never left MonoCode. A live session learns of a
 * new conversation before its saved links do, so the current one is added
 * when it is not linked yet.
 */
export function externalLineage(session: {
  harness: HarnessId;
  providerSessionId?: string;
  providerLinks?: ProviderLink[];
}): ExternalLineage | null {
  const links = session.providerLinks ?? [];
  const adopted = links.find((link) => link.origin === "external");
  const handedBack = [...links]
    .reverse()
    .find((link) => link.handedBackAt != null);
  if (!adopted && !handedBack) return null;
  const chain = links.map((link) => link.harness);
  if (
    session.providerSessionId &&
    !links.some((link) => link.providerSessionId === session.providerSessionId)
  ) {
    chain.push(session.harness);
  }
  return {
    ...(adopted ? { adopted } : {}),
    chain,
    ...(handedBack ? { handedBack } : {}),
    ...(adopted?.syncedMtimeMs != null
      ? { syncedAt: adopted.syncedMtimeMs }
      : {}),
  };
}

/**
 * The shell command that resumes a conversation in its provider's own CLI.
 * Only default-account conversations: another account's config dir is
 * MonoCode's, and the command would not find the transcript without it.
 */
export function resumeCommand(
  link: Pick<
    ProviderLink,
    "harness" | "providerSessionId" | "providerAccountId"
  >,
  cwd: string,
): string | null {
  if (
    (link.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID) !==
    DEFAULT_PROVIDER_ACCOUNT_ID
  ) {
    return null;
  }
  const id = shellQuote(link.providerSessionId);
  const resume =
    link.harness === "claude"
      ? `claude --resume ${id}`
      : link.harness === "codex"
        ? `codex resume ${id}`
        : null;
  return resume && `cd ${shellQuote(cwd)} && ${resume}`;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}
