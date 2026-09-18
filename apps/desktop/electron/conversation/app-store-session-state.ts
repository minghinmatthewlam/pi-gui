import { sessionKey } from "@pi-gui/session-driver";
import type { SessionDriverEvent, SessionSnapshot } from "@pi-gui/session-driver";
import type {
  DesktopAppState,
  SessionRecord,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import { hasUnseenSessionUpdate, previewFromTranscript } from "../application/app-store-utils";
import { NEW_THREAD_PLACEHOLDER_TITLE } from "./thread-title-constants";

/**
 * Patch only run status for Stop. A full snapshot apply here would replace
 * composer-owned config (e.g. `/thinking max`) with the driver's clamped value.
 */
export function applyUrgentRunStatusState(
  state: DesktopAppState,
  event: SessionDriverEvent,
): DesktopAppState | undefined {
  const status =
    event.type === "runFailed"
      ? "failed"
      : event.type === "sessionUpdated" || event.type === "runCompleted"
        ? event.snapshot.status
        : undefined;
  if (status !== "stopping" && status !== "idle" && status !== "failed") {
    return undefined;
  }
  const current = state.workspaces
    .find((workspace) => workspace.id === event.sessionRef.workspaceId)
    ?.sessions.find((session) => session.id === event.sessionRef.sessionId)?.status;
  if (status === "idle" && current !== "running" && current !== "stopping") {
    return undefined;
  }
  return {
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === event.sessionRef.workspaceId
        ? {
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === event.sessionRef.sessionId
                ? {
                    ...session,
                    status,
                    runningSince: status === "stopping" ? session.runningSince : undefined,
                  }
                : session,
            ),
          }
        : workspace,
    ),
    revision: state.revision + 1,
  };
}

/**
 * Slash commands stamp a seq after the driver emit is queued. A deferred
 * sessionUpdated with the same or older seq must not replace that local config.
 */
export function shouldPreserveLocalSessionConfig(
  localWriteSeq: number | undefined,
  eventSeq: number,
): boolean {
  return eventSeq > 0 && (localWriteSeq ?? 0) >= eventSeq;
}

export function eventWithSessionConfig(
  event: SessionDriverEvent,
  config: SessionSnapshot["config"],
): SessionDriverEvent {
  if (
    event.type !== "sessionOpened" &&
    event.type !== "sessionUpdated" &&
    event.type !== "runCompleted"
  ) {
    return event;
  }
  return { ...event, snapshot: { ...event.snapshot, config } };
}

export function applySessionEventState(
  state: DesktopAppState,
  event: SessionDriverEvent,
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  runningSinceBySession: Map<string, string>,
  lastViewedAtBySession: Map<string, string>,
): DesktopAppState {
  const key = sessionKey(event.sessionRef);
  // No clone: the cache follows immutable-write discipline (every mutation
  // replaces the array), so this reference is a stable snapshot. Cloning the
  // whole transcript here cost O(thread) allocations per session event.
  const transcript = transcriptCache.get(key) ?? [];
  const preview = previewFromTranscript(transcript);
  const lastViewedAt = lastViewedAtBySession.get(key);

  return {
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === event.sessionRef.workspaceId
        ? {
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === event.sessionRef.sessionId
                ? updateSessionRecord(session, {
                    snapshot: snapshotForEvent(event),
                    status: statusForEvent(session.status, event),
                    transcript,
                    preview,
                    runningSince: runningSinceBySession.get(key),
                    lastViewedAt,
                  })
                : session,
            ),
          }
        : workspace,
    ),
    revision: state.revision + 1,
  };
}

export function updateSessionRecord(
  session: SessionRecord,
  options: {
    readonly snapshot?: Partial<
      Pick<SessionSnapshot, "title" | "updatedAt" | "archivedAt" | "preview" | "status" | "config">
    >;
    readonly status?: SessionRecord["status"];
    readonly transcript: readonly TranscriptMessage[];
    readonly preview: string | undefined;
    readonly runningSince: string | undefined;
    readonly lastViewedAt: string | undefined;
  },
): SessionRecord {
  const updatedAt = options.snapshot?.updatedAt ?? session.updatedAt;
  const nextStatus = options.status ?? options.snapshot?.status ?? session.status;
  const snapshotTitle = options.snapshot?.title;
  // Queued session events may predate a rename; the placeholder must not replace a resolved title.
  const title =
    snapshotTitle === NEW_THREAD_PLACEHOLDER_TITLE && session.title !== NEW_THREAD_PLACEHOLDER_TITLE
      ? session.title
      : (snapshotTitle ?? session.title);
  return {
    ...session,
    title,
    updatedAt,
    lastViewedAt: options.lastViewedAt,
    archivedAt: options.snapshot?.archivedAt ?? session.archivedAt,
    preview: options.preview ?? options.snapshot?.preview ?? session.preview,
    status: nextStatus,
    runningSince: options.runningSince,
    hasUnseenUpdate: hasUnseenSessionUpdate(
      nextStatus,
      updatedAt,
      options.lastViewedAt,
      options.transcript,
    ),
    config: options.snapshot?.config ?? session.config,
  };
}

function snapshotForEvent(event: SessionDriverEvent) {
  switch (event.type) {
    case "sessionOpened":
    case "sessionUpdated":
    case "runCompleted":
      return event.snapshot;
    default:
      return undefined;
  }
}

function statusForEvent(
  sessionStatus: SessionRecord["status"],
  event: SessionDriverEvent,
): SessionRecord["status"] {
  switch (event.type) {
    case "sessionOpened":
    case "sessionUpdated":
    case "runCompleted":
      return event.snapshot.status;
    case "runFailed":
      return "failed";
    case "sessionClosed":
      return "idle";
    default:
      return sessionStatus;
  }
}
