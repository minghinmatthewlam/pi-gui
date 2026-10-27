import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import {
  appendAssistantDelta,
  applyTimelineEvent,
} from "../../electron/conversation/app-store-timeline";

// The window owner skips publishing a transcript whose array is unchanged, so events that
// leave the transcript alone must keep the same array instead of a copy.

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = sessionKey(sessionRef);
const timestamp = "2026-10-13T12:00:00.000Z";

function fixture() {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  const send = (event: SessionDriverEvent) => applyTimelineEvent(transcript, event, state);
  appendAssistantDelta(transcript, state.activeAssistantMessageBySession, sessionRef, "Hello");
  return { transcript, state, send };
}

const runningSnapshot = {
  ref: sessionRef,
  workspace: { workspaceId: "workspace", path: "/workspace" },
  title: "Thread",
  status: "running",
  updatedAt: timestamp,
  runningRunId: "run-1",
} as unknown as Extract<SessionDriverEvent, { type: "sessionUpdated" }>["snapshot"];

test("events that leave the transcript alone keep the same array", () => {
  const h = fixture();
  const before = h.transcript.get(key);

  h.send({
    type: "hostUiRequest",
    sessionRef,
    timestamp,
    request: { kind: "title", requestId: "title-1", title: "⠋ | Thread" },
  });
  h.send({
    type: "hostUiRequest",
    sessionRef,
    timestamp,
    request: { kind: "notify", requestId: "notify-1", message: "Saved", level: "info" },
  });
  h.send({ type: "assistantMessageEnded", sessionRef, timestamp });
  // Running updates only start the run timer; the renderer draws the Working line.
  h.send({ type: "sessionUpdated", sessionRef, timestamp, snapshot: runningSnapshot });
  h.send({
    type: "sessionUpdated",
    sessionRef,
    timestamp: "2026-10-13T12:00:05.000Z",
    snapshot: runningSnapshot,
  });

  expect(h.transcript.get(key)).toBe(before);
  expect(h.state.runningSinceBySession.get(key)).toBe(timestamp);
});

test("an unknown session gets no empty transcript entry from an event that adds nothing", () => {
  const h = fixture();
  const other = { workspaceId: "workspace", sessionId: "other" };
  h.send({
    type: "hostUiRequest",
    sessionRef: other,
    timestamp,
    request: { kind: "title", requestId: "title-2", title: "Other" },
  });
  expect(h.transcript.has(sessionKey(other))).toBe(false);
});

test("events that change the transcript still replace the array", () => {
  const h = fixture();
  const before = h.transcript.get(key);
  h.send({
    type: "hostUiRequest",
    sessionRef,
    timestamp,
    request: { kind: "notify", requestId: "notify-2", message: "Broke", level: "error" },
  });
  const after = h.transcript.get(key);
  expect(after).not.toBe(before);
  expect(after).toHaveLength(2);
  expect(before).toHaveLength(1);
});
