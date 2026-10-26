import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import {
  appendAssistantDelta,
  applyTimelineEvent,
  preserveLiveTimings,
  timelineFromDriverTranscript,
} from "../../electron/conversation/app-store-timeline";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const start = "2026-01-01T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(start) + ms).toISOString();

test("streamed thinking and text share a row, with first-text and generation timings", () => {
  const cache = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  const send = (event: SessionDriverEvent) => applyTimelineEvent(cache, event, state);
  send({ type: "assistantMessageStarted", sessionRef, timestamp: start });
  appendAssistantDelta(
    cache,
    state.activeAssistantMessageBySession,
    sessionRef,
    "reason",
    at(400),
    true,
  );
  appendAssistantDelta(cache, state.activeAssistantMessageBySession, sessionRef, "answer", at(900));
  appendAssistantDelta(cache, state.activeAssistantMessageBySession, sessionRef, " done", at(1450));
  send({ type: "assistantMessageEnded", sessionRef, timestamp: at(1600) });
  send({
    type: "assistantMessagePersisted",
    sessionRef,
    timestamp: at(1700),
    sourceMessageId: "entry-1",
  });
  const reply = cache.get(sessionKey(sessionRef))?.[0];
  expect(reply).toMatchObject({
    kind: "message",
    thinking: "reason",
    text: "answer done",
    timeToFirstTokenMs: 900,
    generationMs: 550,
    sourceMessageId: "entry-1",
  });

  const reloaded = timelineFromDriverTranscript(
    [
      {
        kind: "message",
        id: "entry-1",
        sourceMessageId: "entry-1",
        role: "assistant",
        text: "answer done",
        thinking: "reason",
        createdAt: start,
      },
    ],
    new Map(),
  );
  expect(preserveLiveTimings(reloaded, cache.get(sessionKey(sessionRef)) ?? [])[0]).toMatchObject({
    thinking: "reason",
    timeToFirstTokenMs: 900,
    generationMs: 550,
  });
});

test("finished tools show elapsed time; tool-only assistant messages leave no empty reply", () => {
  const cache = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  const send = (event: SessionDriverEvent) => applyTimelineEvent(cache, event, state);
  send({ type: "assistantMessageStarted", sessionRef, timestamp: start });
  send({ type: "assistantMessageEnded", sessionRef, timestamp: at(100) });
  send({ type: "toolStarted", sessionRef, timestamp: at(200), callId: "tool-1", toolName: "bash" });
  send({ type: "toolFinished", sessionRef, timestamp: at(1450), callId: "tool-1", success: true });
  expect(cache.get(sessionKey(sessionRef))).toMatchObject([
    { kind: "tool", createdAt: at(200), finishedAt: at(1450) },
  ]);
});
