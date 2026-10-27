import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent, type SessionStatus } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { applyTimelineEvent } from "../../electron/conversation/app-store-timeline";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = sessionKey(sessionRef);

function sessionUpdated(
  timestamp: string,
  status: SessionStatus,
  runningRunId?: string,
): SessionDriverEvent {
  return {
    type: "sessionUpdated",
    sessionRef,
    timestamp,
    snapshot: {
      ref: sessionRef,
      workspace: { workspaceId: "workspace", path: "/tmp/workspace", displayName: "workspace" },
      title: "Thread",
      status,
      updatedAt: timestamp,
      ...(runningRunId ? { runningRunId } : {}),
    },
  };
}

test("a run sent after Stop times and counts from its own start", () => {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  const apply = (event: SessionDriverEvent) => applyTimelineEvent(transcript, event, state);

  apply(sessionUpdated("2026-10-02T10:00:00.000Z", "running", "run-1"));
  apply({
    type: "toolStarted",
    sessionRef,
    timestamp: "2026-10-02T10:00:01.000Z",
    toolName: "bash",
    callId: "call-1",
    input: { command: "sleep 30" },
  });
  apply(sessionUpdated("2026-10-02T10:00:05.000Z", "running", "run-1"));
  expect(state.runningSinceBySession.get(key)).toBe("2026-10-02T10:00:00.000Z");

  // Stop settles the run with only an idle update.
  apply(sessionUpdated("2026-10-02T10:00:06.000Z", "idle"));
  apply(sessionUpdated("2026-10-02T10:05:00.000Z", "running", "run-2"));
  expect(state.runningSinceBySession.get(key)).toBe("2026-10-02T10:05:00.000Z");
  expect(state.runMetricsBySession.get(key)).toMatchObject({ runId: "run-2", toolCount: 0 });
});
