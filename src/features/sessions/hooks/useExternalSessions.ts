import { useCallback, useEffect, useState } from "react";
import {
  listExternalSessions,
  type ExternalSession,
} from "../../../platform/tauri/fs";
import { isRemoteProjectPath } from "../../projects/model/recents";

const NONE: readonly ExternalSession[] = [];

export type ExternalSessionsState = {
  sessions: readonly ExternalSession[];
  /** A listing is in flight. */
  refreshing: boolean;
  refresh: () => void;
};

/**
 * Conversations other clients wrote for `cwd`, listed when the project opens,
 * whenever the window regains focus, and on demand. Other apps write them
 * while MonoCode may not get a focus event at all (a remote display, a second
 * monitor), so `refresh` is exposed for an explicit control.
 * Remote projects have none: their provider files live on another machine.
 */
export function useExternalSessions(cwd: string): ExternalSessionsState {
  const [listed, setListed] = useState<{
    cwd: string;
    sessions: readonly ExternalSession[];
  }>({ cwd: "", sessions: NONE });
  const [pending, setPending] = useState(0);
  const [token, setToken] = useState(0);
  const local = Boolean(cwd) && cwd !== "~" && !isRemoteProjectPath(cwd);
  const refresh = useCallback(() => setToken((value) => value + 1), []);
  useEffect(() => {
    if (!local) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [local, refresh]);
  useEffect(() => {
    if (!local) return;
    let cancelled = false;
    setPending((count) => count + 1);
    listExternalSessions(cwd)
      .then(
        (sessions) => {
          if (!cancelled) setListed({ cwd, sessions });
        },
        () => {
          // Unreadable provider files just mean nothing to show.
          if (!cancelled) setListed({ cwd, sessions: NONE });
        },
      )
      .finally(() => setPending((count) => count - 1));
    return () => {
      cancelled = true;
    };
  }, [cwd, local, token]);
  return {
    sessions: local && listed.cwd === cwd ? listed.sessions : NONE,
    refreshing: local && pending > 0,
    refresh,
  };
}
