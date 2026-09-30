import { useEffect, useState } from "react";
import {
  listExternalSessions,
  type ExternalSession,
} from "../../../platform/tauri/fs";
import { isRemoteProjectPath } from "../../projects/model/recents";

const NONE: readonly ExternalSession[] = [];

/**
 * Conversations other clients wrote for `cwd`, listed when the project opens
 * and again whenever the window regains focus, since they are usually
 * written while the person is in the other app.
 * Remote projects have none: their provider files live on another machine.
 */
export function useExternalSessions(cwd: string): readonly ExternalSession[] {
  const [listed, setListed] = useState<{
    cwd: string;
    sessions: readonly ExternalSession[];
  }>({ cwd: "", sessions: NONE });
  const local = Boolean(cwd) && cwd !== "~" && !isRemoteProjectPath(cwd);
  useEffect(() => {
    if (!local) return;
    let cancelled = false;
    const refresh = () => {
      listExternalSessions(cwd).then(
        (sessions) => {
          if (!cancelled) setListed({ cwd, sessions });
        },
        () => {
          // Unreadable provider files just mean nothing to show.
          if (!cancelled) setListed({ cwd, sessions: NONE });
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [cwd, local]);
  return local && listed.cwd === cwd ? listed.sessions : NONE;
}
