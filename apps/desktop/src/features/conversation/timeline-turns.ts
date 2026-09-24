import type { TurnChangeSummary } from "../../../contracts/review";
import type {
  DisplayTimelineItem,
  TimelineTurnMarker,
  TranscriptMessage,
} from "../../../contracts/timeline-types";

const MIN_WORKED_DURATION_MS = 1_000;

function isUserMessage(item: TranscriptMessage | undefined): boolean {
  return item?.kind === "message" && item.role === "user";
}

/**
 * Insert "Worked for Ns" turn markers, derived purely from real message/tool
 * timestamps. A turn begins at a user message and runs until the next user
 * message; the marker sits directly above the turn's final assistant reply
 * (Codex-style), or at the end of the turn when it has no assistant reply, and
 * reports the elapsed time from the prompt to the last item of that turn.
 *
 * Durations are never fabricated: a marker is emitted only when the turn has
 * downstream work and both endpoints carry parseable timestamps spanning at
 * least one second. The turn still in progress gets no marker, since its final
 * reply is not known yet.
 *
 * Each captured turn that changed files gets a changes card at the end of that turn: after
 * the last transcript item of the turn and any rows that follow it, before the next user
 * message.
 */
export function buildDisplayTimelineItems(
  transcript: readonly TranscriptMessage[],
  options: {
    readonly lastTurnRunning?: boolean;
    readonly turnChanges?: readonly TurnChangeSummary[];
  } = {},
): readonly DisplayTimelineItem[] {
  // Marker to emit immediately before the transcript item at that index.
  // Index `transcript.length` means "after the last item".
  const markersBefore = new Map<number, TimelineTurnMarker>();

  for (let start = 0; start < transcript.length; start += 1) {
    const prompt = transcript[start];
    if (!prompt || !isUserMessage(prompt)) {
      continue;
    }

    let end = start + 1;
    while (end < transcript.length && !isUserMessage(transcript[end])) {
      end += 1;
    }
    if (end === transcript.length && options.lastTurnRunning) {
      break;
    }

    const startMs = Date.parse(prompt.createdAt);
    if (Number.isNaN(startMs)) {
      continue;
    }

    let endMs: number | null = null;
    let finalReplyIndex: number | null = null;
    for (let index = start + 1; index < end; index += 1) {
      const item = transcript[index];
      if (!item) {
        continue;
      }
      if (item.kind === "message" && item.role === "assistant") {
        finalReplyIndex = index;
      }
      const itemMs = Date.parse(item.createdAt);
      if (!Number.isNaN(itemMs)) {
        endMs = endMs == null ? itemMs : Math.max(endMs, itemMs);
      }
    }

    if (endMs == null || endMs - startMs < MIN_WORKED_DURATION_MS) {
      continue;
    }

    markersBefore.set(finalReplyIndex ?? end, {
      kind: "turn-marker",
      id: `turn-marker:${prompt.id}`,
      durationMs: endMs - startMs,
    });
  }

  const cardsAfter = turnChangeCardPositions(transcript, options.turnChanges ?? []);
  if (markersBefore.size === 0 && cardsAfter.size === 0) {
    return transcript;
  }

  const result: DisplayTimelineItem[] = [];
  for (let index = 0; index <= transcript.length; index += 1) {
    const marker = markersBefore.get(index);
    if (marker) {
      result.push(marker);
    }
    const item = transcript[index];
    if (item) {
      result.push(item);
    }
    for (const turn of cardsAfter.get(index) ?? []) {
      result.push({ kind: "turn-changes", id: `turn-changes:${turn.checkpointId}`, turn });
    }
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
