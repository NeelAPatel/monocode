import { useCallback, useEffect, useRef, useState } from "react";
import { AgentTranscript } from "./AgentTranscript";
import { TranscriptFind } from "./TranscriptFind";
import { HarnessIcon } from "./HarnessIcon";
import type { Block } from "../model/session";
import {
  readExternalSession,
  type ExternalProvider,
} from "../../../platform/tauri/fs";
import { claudeTranscriptToBlocks } from "../../../integrations/harness/providers/claude/claudeTranscript";
import { codexTranscriptToBlocks } from "../../../integrations/harness/providers/codex/codexTranscript";
import type { ExternalTabSource } from "../../workspace/model/layout";

const CLAUDE_SOURCE_LABEL: Record<string, string> = {
  "claude-desktop": "Claude Desktop",
  cli: "Claude Code",
  "sdk-cli": "Claude Agent SDK",
  "sdk-ts": "Claude Agent SDK",
};

const CODEX_SOURCE_LABEL: Record<string, string> = {
  codex_cli_rs: "Codex CLI",
  codex_exec: "Codex CLI",
};

/** Claude reports an `entrypoint` id; Codex a display name, mostly. */
export function externalSourceLabel(
  provider: ExternalProvider,
  source: string,
): string {
  if (provider === "claude") return CLAUDE_SOURCE_LABEL[source] ?? "Claude";
  return CODEX_SOURCE_LABEL[source] ?? (source.trim() || "Codex");
}

/** Adopt an external chat as a MonoCode session and open that instead. */
export type ContinueExternal = (
  external: ExternalTabSource,
  title: string,
) => Promise<void>;

type Load =
  | { state: "loading" }
  | { state: "ready"; blocks: Block[] }
  | { state: "error"; message: string };

/**
 * A conversation another client wrote for this project, read from its own
 * file each time the tab opens. Read-only: MonoCode resumes a chat only after
 * the person chooses to continue it, which turns it into a MonoCode session.
 */
export function ExternalTranscriptView({
  title,
  cwd,
  external,
  visible,
  focused = visible,
  onOpenFile,
  onContinue,
}: {
  title: string;
  cwd: string;
  external: ExternalTabSource;
  visible: boolean;
  focused?: boolean;
  onOpenFile?: (path: string) => void;
  onContinue?: () => Promise<void>;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [continuing, setContinuing] = useState(false);
  const continueHere = useCallback(() => {
    if (!onContinue) return;
    setContinuing(true);
    void onContinue().finally(() => setContinuing(false));
  }, [onContinue]);
  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    readExternalSession(external.provider, external.path).then(
      (records) => {
        if (cancelled) return;
        const blocks =
          external.provider === "codex"
            ? codexTranscriptToBlocks(records)
            : claudeTranscriptToBlocks(records);
        setLoad({ state: "ready", blocks });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ state: "error", message: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [external.provider, external.path]);
  const navigateBlockRef = useRef<
    ((blockId: string | null, query?: string) => boolean) | null
  >(null);
  const onNavigateReady = useCallback(
    (navigate: (blockId: string | null, query?: string) => boolean) => {
      navigateBlockRef.current = navigate;
    },
    [],
  );
  const navigateBlock = useCallback(
    (blockId: string | null, query?: string) =>
      navigateBlockRef.current?.(blockId, query) ?? false,
    [],
  );
  const blocks = load.state === "ready" ? load.blocks : [];
  return (
    <div data-external-tab className="flex h-full min-h-0 flex-col">
      <div className="@container relative min-h-0 flex-1">
        {load.state === "ready" ? (
          <>
            <AgentTranscript
              blocks={blocks}
              cwd={cwd}
              harness={external.provider}
              visible={visible}
              onOpenFile={onOpenFile}
              onNavigateReady={onNavigateReady}
            />
            <TranscriptFind
              blocks={blocks}
              visible={visible}
              focused={focused}
              onNavigate={navigateBlock}
            />
          </>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center">
            <p className="max-w-sm text-[12px] leading-5 text-content/45">
              {load.state === "loading"
                ? "Loading conversation…"
                : `This conversation could not be read. ${load.message}`}
            </p>
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-1.5 border-t border-stroke px-3 py-1.5 font-sans text-[11px] text-content/45">
        <HarnessIcon
          harness={external.provider}
          className="size-3.5 shrink-0"
        />
        <span className="min-w-0 truncate" title={title}>
          {externalSourceLabel(external.provider, external.source)} · external
        </span>
        {onContinue && load.state === "ready" ? (
          <button
            type="button"
            disabled={continuing}
            onClick={continueHere}
            title="Continue this chat as a MonoCode session"
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-accent hover:bg-content/10 disabled:opacity-50"
          >
            {continuing ? "Continuing…" : "Continue in MonoCode"}
          </button>
        ) : (
          <span className="ml-auto shrink-0">read-only</span>
        )}
      </footer>
    </div>
  );
}
