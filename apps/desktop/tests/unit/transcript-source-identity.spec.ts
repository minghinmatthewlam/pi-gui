import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { createConversationOwner } from "../../electron/conversation/app-store-composer";
import {
  appendAssistantDelta,
  applyTimelineEvent,
} from "../../electron/conversation/app-store-timeline";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = sessionKey(sessionRef);
const timestamp = "2026-09-22T19:00:00.000Z";

function fixture() {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  const send = (event: SessionDriverEvent) => applyTimelineEvent(transcript, event, state);
  const append = (text: string) =>
    appendAssistantDelta(transcript, state.activeAssistantMessageBySession, sessionRef, text);
  const ended = () => send({ type: "assistantMessageEnded", sessionRef, timestamp });
  const persisted = (sourceMessageId: string) =>
    send({ type: "assistantMessagePersisted", sessionRef, timestamp, sourceMessageId });
  return { transcript, state, send, append, ended, persisted };
}

test("persisted source identity attaches to its ended live row without replacing display IDs or metrics", () => {
  const h = fixture();
  h.state.runMetricsBySession.set(key, {
    startedAt: timestamp,
    toolCount: 3,
    searchCount: 1,
    fileCount: 2,
  });
  h.append("First response");
  const first = h.transcript.get(key)![0]!;
  h.ended();
  h.persisted("native-first");
  h.append("Continued response");
  const second = h.transcript.get(key)![1]!;
  h.ended();
  h.persisted("native-second");
  expect(h.transcript.get(key)).toEqual([
    { ...first, sourceMessageId: "native-first" },
    { ...second, sourceMessageId: "native-second" },
  ]);
  expect(h.state.runMetricsBySession.get(key)?.toolCount).toBe(3);
  expect(h.state.pendingAssistantMessageBySession.has(key)).toBe(false);
});

test("tool-only and repeated persisted events cannot attach to an earlier assistant row", () => {
  const h = fixture();
  h.append("Before tool");
  h.ended();
  h.persisted("native-text");
  const previous = h.transcript.get(key);
  h.ended(); // This assistant emitted tools, but no visible text.
  h.persisted("native-tool-only");
  h.persisted("duplicate-native-event");
  expect(h.transcript.get(key)).toEqual(previous);
  expect(h.state.pendingAssistantMessageBySession.has(key)).toBe(false);
});

test("a close discards a pending association before any later persisted event", () => {
  const h = fixture();
  h.append("Interrupted response");
  h.ended();
  h.send({ type: "sessionClosed", sessionRef, timestamp, reason: "manual" });
  h.persisted("late-native-id");
  expect(h.state.pendingAssistantMessageBySession.has(key)).toBe(false);
  expect(h.transcript.get(key)![0]).not.toHaveProperty("sourceMessageId");
});

test("Stop preserves the live identity while already-enqueued host events are delayed", async () => {
  const h = fixture();
  h.append("Partial response before Stop");
  const originalId = h.transcript.get(key)![0]!.id;
  // Only the cancellation path is exercised; the event queue intentionally has not drained.
  const owner = createConversationOwner({
    initialize: async () => undefined,
    driver: { cancelCurrentRun: async () => undefined },
    conversationState: {
      activeAssistantMessageBySession: h.state.activeAssistantMessageBySession,
      sessionErrorsBySession: new Map(),
    },
    clearConversationError: () => undefined,
    schedulePersistUiState: () => undefined,
    emit: () => ({}),
    withSessionError: (_ref: unknown, error: unknown) => {
      throw error;
    },
  } as never);
  await owner.cancelCurrentRun(sessionRef);
  expect(h.state.activeAssistantMessageBySession.get(key)).toBe(originalId);
  h.ended();
  h.persisted("native-stopped-response");
  expect(h.transcript.get(key)![0]).toMatchObject({
    id: originalId,
    sourceMessageId: "native-stopped-response",
  });
});
