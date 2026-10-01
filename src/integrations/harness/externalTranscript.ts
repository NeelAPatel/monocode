/**
 * Shared by the converters that rebuild transcripts written outside MonoCode
 * (claudeTranscript, codexTranscript) for read-only viewing.
 */

import type {
  HarnessId,
  TurnModel,
} from "../../features/sessions/model/session";
import { resolveModel } from "../../features/sessions/model/models";

/** The model and effort a transcript last ran with, for continuing it. */
export type TranscriptSummary = { model?: string; effort?: string };

/**
 * Turn provenance from the model id a provider wrote. A catalog entry gives
 * the display name; an id the catalog does not know is kept as written
 * rather than resolved to some other model.
 */
export function transcriptTurnModel(
  harness: HarnessId,
  nativeModel: string,
): TurnModel {
  const model = resolveModel(harness, nativeModel);
  const native = model.nativeId ?? model.id.slice(model.id.indexOf(":") + 1);
  return native === nativeModel || model.id === nativeModel
    ? { harness, id: model.id, name: model.name }
    : { harness, id: nativeModel, name: nativeModel };
}

/** Tool output past this is cut; the transcript is for reading, not replay. */
export const EXTERNAL_TOOL_DETAIL_LIMIT = 20_000;

export function clipToolDetail(text: string): string {
  if (text.length <= EXTERNAL_TOOL_DETAIL_LIMIT) return text;
  const hidden = text.length - EXTERNAL_TOOL_DETAIL_LIMIT;
  return `${text.slice(0, EXTERNAL_TOOL_DETAIL_LIMIT)}\n… ${hidden.toLocaleString("en-US")} more characters not shown`;
}

/** `startedAt` from a record's ISO `timestamp`, when it has a valid one. */
export function recordStartedAt(rec: Record<string, unknown>): {
  startedAt?: number;
} {
  const at =
    typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  return Number.isFinite(at) ? { startedAt: at } : {};
}
