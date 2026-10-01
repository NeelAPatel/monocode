import { useRef, useState } from "react";
import { ExternalLink } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import { copyText } from "../../../platform/tauri/clipboard";
import { HarnessIcon } from "./HarnessIcon";
import { externalSourceLabel } from "./ExternalTranscriptView";
import {
  externalLineage,
  resumeCommand,
  type ExternalLineage,
} from "../model/providerLineage";
import {
  HARNESS_LABEL,
  HARNESS_TITLE,
  type HarnessId,
  type ProviderLink,
} from "../model/session";

/**
 * Marks a sidebar session whose conversation began in another client or was
 * handed back to one, and says where it has been when clicked.
 */
export function ExternalPill({
  session,
}: {
  session: {
    harness: HarnessId;
    cwd: string;
    worktreeCwd?: string;
    providerSessionId?: string;
    providerLinks?: ProviderLink[];
  };
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const lineage = externalLineage(session);
  if (!lineage) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-no-drag
        data-tauri-drag-region="false"
        title={lineageSummary(lineage)}
        aria-label="External chat details"
        aria-expanded={open}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded bg-content/10 px-1 text-[10px] leading-4 text-content/55 hover:bg-content/15 hover:text-content/80"
      >
        <ExternalLink className="size-2.5" strokeWidth={1.75} />
        External
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="right"
          align="start"
          gap={6}
          width={280}
          autoFocus
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label="External chat details"
        >
          <LineageDetails
            lineage={lineage}
            cwd={session.worktreeCwd ?? session.cwd}
            current={currentLink(session)}
          />
        </Popover>
      ) : null}
    </>
  );
}

function LineageDetails({
  lineage,
  cwd,
  current,
}: {
  lineage: ExternalLineage;
  cwd: string;
  current?: Pick<
    ProviderLink,
    "harness" | "providerSessionId" | "providerAccountId"
  >;
}) {
  const [copied, setCopied] = useState(false);
  const command = current ? resumeCommand(current, cwd) : null;
  const { adopted, handedBack } = lineage;
  return (
    <div className="flex flex-col gap-2 p-3 font-sans text-[12px] leading-5 text-content/80">
      {adopted ? (
        <Row label="Started in">
          <HarnessIcon harness={adopted.harness} className="size-3.5" />
          {startedInLabel(adopted)}
        </Row>
      ) : null}
      {adopted?.adoptedAt ? (
        <Row label="Continued here">{formatWhen(adopted.adoptedAt)}</Row>
      ) : null}
      <Row label="Providers">
        {lineage.chain.map((harness) => HARNESS_TITLE[harness]).join(" → ")}
      </Row>
      <Row label="Now">
        {handedBack
          ? `Handed back to ${HARNESS_LABEL[handedBack.harness]} ${formatWhen(handedBack.handedBackAt!)}`
          : "In MonoCode"}
      </Row>
      {lineage.syncedAt ? (
        <Row label="Last synced">{formatWhen(lineage.syncedAt)}</Row>
      ) : null}
      {command ? (
        <button
          type="button"
          title={command}
          onClick={() => {
            void copyText(command).then(() => setCopied(true));
          }}
          className="mt-1 self-start rounded px-1.5 py-0.5 text-accent hover:bg-content/10"
        >
          {copied ? "Copied" : "Copy resume command"}
        </button>
      ) : null}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-24 shrink-0 text-content/45">{label}</span>
      <span className="flex min-w-0 items-center gap-1 truncate">
        {children}
      </span>
    </div>
  );
}

function currentLink(session: {
  harness: HarnessId;
  providerSessionId?: string;
  providerLinks?: ProviderLink[];
}) {
  if (!session.providerSessionId) return undefined;
  return (
    session.providerLinks?.find(
      (link) => link.providerSessionId === session.providerSessionId,
    ) ?? {
      harness: session.harness,
      providerSessionId: session.providerSessionId,
    }
  );
}

function lineageSummary(lineage: ExternalLineage): string {
  const parts: string[] = [];
  if (lineage.adopted) {
    parts.push(`Started in ${startedInLabel(lineage.adopted)}`);
  }
  if (lineage.chain.length > 1) {
    parts.push(
      lineage.chain.map((harness) => HARNESS_TITLE[harness]).join(" → "),
    );
  }
  if (lineage.handedBack) {
    parts.push(`handed back to ${HARNESS_LABEL[lineage.handedBack.harness]}`);
  }
  return parts.join(" · ");
}

function startedInLabel(link: ProviderLink): string {
  return link.harness === "claude" || link.harness === "codex"
    ? externalSourceLabel(link.harness, link.source ?? "")
    : HARNESS_LABEL[link.harness];
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
