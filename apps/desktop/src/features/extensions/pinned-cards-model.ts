import type { ExtensionCard, SessionTranscriptPin } from "@pi-gui/session-driver";
import type { TimelineTranscriptItem, TranscriptMessage } from "../../../contracts/timeline-types";

/** More pins than this stack too high above the composer; the most recently pinned ones show. */
const MAX_VISIBLE_PINS = 3;

export type PinnedCard = SessionTranscriptPin & { readonly card: ExtensionCard };

/**
 * The only place pins leave the transcript: the timeline gets everything else, typed so a pin
 * cannot reach it, and the composer gets the pins.
 */
export function splitPinnedCards(transcript: readonly TranscriptMessage[]): {
  readonly timeline: readonly TimelineTranscriptItem[];
  readonly pins: readonly SessionTranscriptPin[];
} {
  const timeline: TimelineTranscriptItem[] = [];
  const pins: SessionTranscriptPin[] = [];
  for (const item of transcript) {
    if (item.kind === "pin") pins.push(item);
    else timeline.push(item);
  }
  return { timeline, pins };
}

/**
 * The pins drawn above the composer: removed and hidden pins drop out first, then the most
 * recently first-written ones up to the cap, oldest on top.
 */
export function visiblePinnedCards(
  pins: readonly SessionTranscriptPin[],
  isDismissed: (pin: PinnedCard) => boolean,
): PinnedCard[] {
  return pins
    .filter((pin): pin is PinnedCard => pin.card !== null && !isDismissed(pin as PinnedCard))
    .slice(-MAX_VISIBLE_PINS);
}
