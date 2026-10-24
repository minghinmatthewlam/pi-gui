import { sessionKey } from "@pi-gui/session-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";

/**
 * Trailing-edge interval for streaming transcript / sidebar publishes.
 * Hidden macOS CI windows coalesce Node timers past this delay, so Electron
 * proofs must poll for the flush instead of waiting interval+slack once.
 */
export const STREAMING_UI_PUBLISH_INTERVAL_MS = 50;

/**
 * Token-level `assistantDelta` always arrives with a redundant `sessionUpdated`
 * (preview/timestamp). Publishing full app state for each pair was the leftover
 * #93 CPU path after #114. Defer those two; flush immediately on discrete events.
 *
 * `trackedRunId` is the last observed `snapshot.runningRunId` for this session.
 * A new run id (Send after Stop) is not deferred. Do not pass
 * `runningSinceBySession.has` — user cancel never clears that map.
 */
export function shouldDeferStreamingUiPublish(
  event: SessionDriverEvent,
  trackedRunId: string | undefined,
): boolean {
  if (event.type === "assistantDelta" || event.type === "toolUpdated") {
    return true;
  }
  if (event.type !== "sessionUpdated" || event.snapshot.status !== "running") {
    return false;
  }
  const runId = event.snapshot.runningRunId;
  return Boolean(runId) && runId === trackedRunId;
}

/**
 * One app-wide UI publish per interval, including all dirty sessions. Separate
 * per-session timers multiply full-state publishes when agents run in parallel.
 * Discrete events cancel only their session; other sessions keep their flush.
 * Also owns last-seen runningRunId so Stop→Send is immediate.
 */
export class StreamingUiPublisher {
  private readonly pending = new Map<string, SessionRef>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly trackedRunId = new Map<string, string>();

  constructor(
    private readonly publish: (sessionRefs: readonly SessionRef[]) => void,
    private readonly intervalMs: number = STREAMING_UI_PUBLISH_INTERVAL_MS,
  ) {}

  shouldDefer(event: SessionDriverEvent): boolean {
    return shouldDeferStreamingUiPublish(
      event,
      this.trackedRunId.get(sessionKey(event.sessionRef)),
    );
  }

  /**
   * Record the run id after the defer decision for this event so the first
   * running tick is not deferred by its own write.
   */
  observe(event: SessionDriverEvent): void {
    const key = sessionKey(event.sessionRef);
    if (event.type === "sessionClosed") {
      this.trackedRunId.delete(key);
      return;
    }
    if (
      event.type === "sessionUpdated" &&
      event.snapshot.status === "running" &&
      event.snapshot.runningRunId
    ) {
      this.trackedRunId.set(key, event.snapshot.runningRunId);
    }
  }

  schedule(sessionRef: SessionRef): void {
    this.pending.set(sessionKey(sessionRef), sessionRef);
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const sessions = [...this.pending.values()];
      this.pending.clear();
      this.publish(sessions);
    }, this.intervalMs);
  }

  cancel(sessionRef: SessionRef): void {
    this.pending.delete(sessionKey(sessionRef));
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
    this.trackedRunId.clear();
  }
}
