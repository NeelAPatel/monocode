/**
 * Shared by the converters that rebuild transcripts written outside MonoCode
 * (claudeTranscript, codexTranscript) for read-only viewing.
 */

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
