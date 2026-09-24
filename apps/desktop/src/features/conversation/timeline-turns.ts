import type { TurnChangeSummary } from "../../../contracts/review";
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
 *
 * Each captured turn that changed files gets a changes card at the end of that turn: after
 * the last transcript item of the turn and any tool rows that follow it, before the next
 * user message.
 */
export function buildDisplayTimelineItems(
  transcript: readonly TranscriptMessage[],
  turnChanges: readonly TurnChangeSummary[] = [],
): readonly DisplayTimelineItem[] {
  const result: DisplayTimelineItem[] = [];
  const cardsAfter = turnChangeCardPositions(transcript, turnChanges);

  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    result.push(item);
    for (const turn of cardsAfter.get(index) ?? []) {
      result.push({ kind: "turn-changes", id: `turn-changes:${turn.checkpointId}`, turn });
    }

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

function turnChangeCardPositions(
  transcript: readonly TranscriptMessage[],
  turnChanges: readonly TurnChangeSummary[],
): ReadonlyMap<number, TurnChangeSummary[]> {
  const positions = new Map<number, TurnChangeSummary[]>();
  if (turnChanges.length === 0) return positions;
  const turnByEntry = new Map<string, TurnChangeSummary>();
  for (const turn of turnChanges)
    for (const entryId of turn.entryIds) turnByEntry.set(entryId, turn);
  const lastIndex = new Map<TurnChangeSummary, number>();
  transcript.forEach((item, index) => {
    if (item.kind !== "message") return;
    const turn = turnByEntry.get(item.sourceMessageId ?? item.id);
    if (turn) lastIndex.set(turn, index);
  });
  // Cards keep the capture order when several turns end at the same row.
  for (const turn of turnChanges) {
    let index = lastIndex.get(turn);
    if (index === undefined) continue;
    while (index + 1 < transcript.length && !startsAnotherTurn(transcript[index + 1], turn)) {
      index += 1;
    }
    positions.set(index, [...(positions.get(index) ?? []), turn]);
  }
  return positions;

  function startsAnotherTurn(item: TranscriptMessage | undefined, turn: TurnChangeSummary) {
    if (item?.kind !== "message") return false;
    const owner = turnByEntry.get(item.sourceMessageId ?? item.id);
    return item.role === "user" || (owner !== undefined && owner !== turn);
  }
}
