import type { DisplayTimelineItem, TranscriptMessage } from "../../../contracts/timeline-types";

const MIN_WORKED_DURATION_MS = 1_000;

/**
 * Insert "Worked for Ns" turn markers between turns, derived purely from real
 * message/tool timestamps. A turn begins at a user message and runs until the
 * next user message; the marker sits right after the prompt (Codex-style) and
 * reports the elapsed time from the prompt to the last item of that turn.
 *
 * Durations are never fabricated: a marker is emitted only when the turn has
 * downstream work and both endpoints carry parseable timestamps spanning at
 * least one second.
 */
export function buildDisplayTimelineItems(
  transcript: readonly TranscriptMessage[],
): readonly DisplayTimelineItem[] {
  const result: DisplayTimelineItem[] = [];

  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    result.push(item);

    if (item.kind !== "message" || item.role !== "user") {
      continue;
    }

    const startMs = Date.parse(item.createdAt);
    if (Number.isNaN(startMs)) {
      continue;
    }

    let endMs: number | null = null;
    for (let next = index + 1; next < transcript.length; next += 1) {
      const nextItem = transcript[next];
      if (!nextItem) {
        continue;
      }
      if (nextItem.kind === "message" && nextItem.role === "user") {
        break;
      }
      const nextMs = Date.parse(nextItem.createdAt);
      if (!Number.isNaN(nextMs)) {
        endMs = endMs == null ? nextMs : Math.max(endMs, nextMs);
      }
    }

    if (endMs == null) {
      continue;
    }

    const durationMs = endMs - startMs;
    if (durationMs < MIN_WORKED_DURATION_MS) {
      continue;
    }

    result.push({ kind: "turn-marker", id: `turn-marker:${item.id}`, durationMs });
  }

  return result;
}
