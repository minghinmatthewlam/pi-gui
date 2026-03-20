import type { SessionDriverEvent } from "@pi-app/session-driver";
import type { DesktopAppState, SessionRecord, TranscriptMessage } from "../src/desktop-state";
import { cloneTranscriptMessage } from "./app-store-utils";
import { previewFromTranscript, sessionKey } from "./app-store-utils";

export function applySessionEventState(
  state: DesktopAppState,
  event: SessionDriverEvent,
  transcriptCache: Map<string, TranscriptMessage[]>,
  runningSinceBySession: Map<string, string>,
): DesktopAppState {
  const key = sessionKey(event.sessionRef);
  const transcript = (transcriptCache.get(key) ?? []).map(cloneTranscriptMessage);
  const preview = previewFromTranscript(transcript);

  return {
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === event.sessionRef.workspaceId
        ? {
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === event.sessionRef.sessionId
                ? updateSessionRecord(session, event, transcript, preview, runningSinceBySession.get(key))
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
  transcript: readonly TranscriptMessage[],
  preview: string | undefined,
  runningSince: string | undefined,
): SessionRecord {
  const snapshot = snapshotForEvent(event);

  return {
    ...session,
    title: snapshot?.title ?? session.title,
    updatedAt: snapshot?.updatedAt ?? event.timestamp,
    preview: preview ?? snapshot?.preview ?? session.preview,
    status: statusForEvent(session.status, event),
    runningSince,
    config: snapshot?.config ?? session.config,
    transcript,
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
