import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { DesktopAppState, SessionRecord, TranscriptMessage } from "../src/desktop-state";
import { previewFromTranscript } from "./app-store-utils";

export function applySessionEventState(
  state: DesktopAppState,
  event: SessionDriverEvent,
  transcriptCache: Map<string, TranscriptMessage[]>,
  runningSinceBySession: Map<string, string>,
  lastViewedAtBySession: Map<string, string>,
): DesktopAppState {
  const key = sessionKey(event.sessionRef);
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
                ? updateSessionRecord(
                    session,
                    event,
                    preview,
                    runningSinceBySession.get(key),
                    lastViewedAt,
                  )
                : session,
            ),
          }
        : workspace,
    ),
    revision: state.revision + 1,
  };
}

function updateSessionRecord(
  session: SessionRecord,
  event: SessionDriverEvent,
  preview: string | undefined,
  runningSince: string | undefined,
  lastViewedAt: string | undefined,
): SessionRecord {
  const snapshot = snapshotForEvent(event);
  const updatedAt = snapshot?.updatedAt ?? session.updatedAt;
  const nextStatus = statusForEvent(session.status, event);
  return {
    ...session,
    title: snapshot?.title ?? session.title,
    updatedAt,
    lastViewedAt,
    archivedAt: snapshot?.archivedAt ?? session.archivedAt,
    preview: preview ?? snapshot?.preview ?? session.preview,
    status: nextStatus,
    runningSince,
    hasUnseenUpdate: nextStatus !== "running" && Boolean(lastViewedAt && updatedAt > lastViewedAt),
    config: snapshot?.config ?? session.config,
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
