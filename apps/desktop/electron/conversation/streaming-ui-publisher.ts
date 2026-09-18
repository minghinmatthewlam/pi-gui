import { sessionKey } from "@pi-gui/session-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";

/** Trailing-edge interval for streaming transcript / sidebar publishes. */
export const STREAMING_UI_PUBLISH_INTERVAL_MS = 50;

/**
 * Token-level `assistantDelta` always arrives with a redundant `sessionUpdated`
 * (preview/timestamp). Publishing full app state for each pair was the leftover
 * #93 CPU path after #114. Defer those two; flush immediately on discrete events.
 */
export function shouldDeferStreamingUiPublish(
  event: SessionDriverEvent,
  alreadyTrackingRun: boolean,
): boolean {
  if (event.type === "assistantDelta") {
    return true;
  }
  return (
    event.type === "sessionUpdated" && alreadyTrackingRun && event.snapshot.status === "running"
  );
}

/**
 * At most one UI publish per session per interval. Later tokens in the window
 * mark the same slot dirty; a discrete event cancels the timer because it is
 * about to `emit()` itself.
 */
export class StreamingUiPublisher {
  private readonly pending = new Map<
    string,
    { readonly sessionRef: SessionRef; readonly timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly publish: (sessionRef: SessionRef) => void,
    private readonly intervalMs: number = STREAMING_UI_PUBLISH_INTERVAL_MS,
  ) {}

  schedule(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    if (this.pending.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.publish(sessionRef);
    }, this.intervalMs);
    this.pending.set(key, { sessionRef, timer });
  }

  cancel(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(key);
  }

  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
