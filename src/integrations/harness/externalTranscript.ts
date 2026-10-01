/**
 * Shared by the converters that rebuild transcripts written outside MonoCode
 * (claudeTranscript, codexTranscript) for read-only viewing.
 */

import type {
  HarnessId,
  TurnModel,
} from "../../features/sessions/model/session";
import {
  MODELS,
  modelsFor,
  resolveModel,
} from "../../features/sessions/model/models";

/** The model and effort a transcript last ran with, for continuing it. */
export type TranscriptSummary = { model?: string; effort?: string };

/**
 * The catalog entry for a model id a provider wrote, or `undefined` when the
 * catalog does not know it. Never resolves to some other model.
 */
export function catalogModel(
  harness: HarnessId,
  nativeModel: string,
): { id: string; name: string } | undefined {
  // Claude writes dated snapshots (`claude-haiku-4-5-20251001`) of the ids
  // the catalog lists undated.
  const undated = nativeModel.replace(/-\d{8}$/, "");
  const model = resolveModel(harness, undated);
  const native = model.nativeId ?? model.id.slice(model.id.indexOf(":") + 1);
  if (native === undated || model.id === undated) return model;
  // The CLI can list a model under a moving alias (`haiku`) instead of its
  // versioned id; the same display name identifies the same version.
  const known = knownModel(harness, undated);
  return known
    ? modelsFor(harness).find(
        (listed) => displayName(listed.name) === displayName(known.name),
      )
    : undefined;
}

function knownModel(harness: HarnessId, nativeId: string) {
  return MODELS.find(
    (model) => model.harness === harness && model.nativeId === nativeId,
  );
}

function displayName(name: string): string {
  return name
    .replace(/^claude\s+/i, "")
    .trim()
    .toLowerCase();
}

/** Turn provenance from the model id a provider wrote; unknown ids as is. */
export function transcriptTurnModel(
  harness: HarnessId,
  nativeModel: string,
): TurnModel {
  const model =
    catalogModel(harness, nativeModel) ??
    knownModel(harness, nativeModel.replace(/-\d{8}$/, ""));
  return model
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
