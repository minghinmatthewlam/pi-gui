import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionSnapshot } from "@pi-gui/session-driver";
import type { DesktopAppState, SessionRecord, TranscriptMessage } from "../src/desktop-state";
import { cloneTranscriptMessage, hasUnseenSessionUpdate, previewFromTranscript } from "./app-store-utils";

export function applySessionEventState(
  state: DesktopAppState,
  event: SessionDriverEvent,
  transcriptCache: Map<string, TranscriptMessage[]>,
  runningSinceBySession: Map<string, string>,
  lastViewedAtBySession: Map<string, string>,
): DesktopAppState {
  const key = sessionKey(event.sessionRef);
  const transcript = (transcriptCache.get(key) ?? []).map(cloneTranscriptMessage);
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
  return {
    ...session,
    title: options.snapshot?.title ?? session.title,
    updatedAt,
    lastViewedAt: options.lastViewedAt,
    archivedAt: options.snapshot?.archivedAt ?? session.archivedAt,
    preview: options.preview ?? options.snapshot?.preview ?? session.preview,
    status: nextStatus,
    runningSince: options.runningSince,
    hasUnseenUpdate: hasUnseenSessionUpdate(nextStatus, updatedAt, options.lastViewedAt, options.transcript),
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

function statusForEvent(sessionStatus: SessionRecord["status"], event: SessionDriverEvent): SessionRecord["status"] {
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
