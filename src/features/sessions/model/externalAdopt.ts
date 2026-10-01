import type { ExternalSession } from "../../../platform/tauri/fs";
import { DEFAULT_PROVIDER_ACCOUNT_ID } from "../../providers/model/providerAccounts";
import {
  isRemoteProjectPath,
  normalizeProjectPath,
} from "../../projects/model/recents";
import {
  claudeTranscriptSummary,
  claudeTranscriptToBlocks,
} from "../../../integrations/harness/providers/claude/claudeTranscript";
import {
  codexTranscriptSummary,
  codexTranscriptToBlocks,
} from "../../../integrations/harness/providers/codex/codexTranscript";
import { catalogModel } from "../../../integrations/harness/externalTranscript";
import { newSession, type RuntimeMode, type Session } from "./session";

export type ExternalAdoption = { session: Session } | { blocked: string };

/**
 * A MonoCode session that continues a conversation another client started:
 * its history rebuilt from the transcript, bound to the provider's own id so
 * the next turn resumes it. External chats are read from the default
 * provider dirs, so the session stays on the default account.
 */
export function adoptExternalSession(input: {
  external: Pick<
    ExternalSession,
    "provider" | "id" | "title" | "cwd" | "source"
  >;
  records: Record<string, unknown>[];
  projectCwd: string;
  runtimeMode?: RuntimeMode;
}): ExternalAdoption {
  const { external, records, projectCwd } = input;
  if (isRemoteProjectPath(projectCwd)) {
    return { blocked: "Chats from other apps can only continue locally." };
  }
  // Claude files a transcript under the folder it ran in, and `--resume`
  // looks there, so the session has to run in that same folder.
  if (normalizeProjectPath(external.cwd) !== normalizeProjectPath(projectCwd)) {
    return {
      blocked: `This chat ran in ${external.cwd}. Open that folder as a project to continue it.`,
    };
  }
  const codex = external.provider === "codex";
  const blocks = codex
    ? codexTranscriptToBlocks(records)
    : claudeTranscriptToBlocks(records);
  if (!blocks.some((block) => block.role === "user")) {
    return { blocked: "This chat has no messages to continue." };
  }
  const summary = codex
    ? codexTranscriptSummary(records)
    : claudeTranscriptSummary(records);
  // A model the catalog does not know falls back to the default rather than
  // starting the CLI on an id MonoCode cannot describe.
  const model = summary.model
    ? catalogModel(external.provider, summary.model)
    : undefined;
  const base = newSession(
    external.provider,
    projectCwd,
    model?.id,
    input.runtimeMode,
  );
  return {
    session: {
      ...base,
      title: external.title,
      blocks,
      providerSessionId: external.id,
      providerAccountId: DEFAULT_PROVIDER_ACCOUNT_ID,
    },
  };
}
