import { expect, test } from "@playwright/test";
import { sessionKey } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import {
  appendAssistantDelta,
  appendAssistantThinkingDelta,
  applyTimelineEvent,
} from "../../electron/conversation/app-store-timeline";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = sessionKey(sessionRef);
const timestamp = "2026-11-13T12:00:00.000Z";

function fixture() {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  return { transcript, state };
}

function assistantRow(transcript: Map<string, readonly TranscriptMessage[]>) {
  const rows = transcript.get(key) ?? [];
  const row = rows[0];
  if (row?.kind !== "message") throw new Error("expected an assistant message row");
  return row;
}

test("reasoning streams onto the same live row as the answer", () => {
  const h = fixture();

  appendAssistantThinkingDelta(
    h.transcript,
    h.state.activeAssistantMessageBySession,
    sessionRef,
    "Look at the ",
  );
  appendAssistantThinkingDelta(
    h.transcript,
    h.state.activeAssistantMessageBySession,
    sessionRef,
    "failing test. ",
  );
  appendAssistantDelta(
    h.transcript,
    h.state.activeAssistantMessageBySession,
    sessionRef,
    "Fixed it.",
  );

  // One row owns the turn, so the answer never splits from its reasoning.
  expect(h.transcript.get(key)).toHaveLength(1);
  expect(assistantRow(h.transcript).thinking).toBe("Look at the failing test. ");
  expect(assistantRow(h.transcript).text).toBe("Fixed it.");
});

test("the saved reasoning of the finished turn replaces the streamed copy", () => {
  const h = fixture();
  appendAssistantThinkingDelta(
    h.transcript,
    h.state.activeAssistantMessageBySession,
    sessionRef,
    "partial",
  );
  appendAssistantDelta(
    h.transcript,
    h.state.activeAssistantMessageBySession,
    sessionRef,
    "Answer.",
  );

  applyTimelineEvent(
    h.transcript,
    {
      type: "assistantMessageEnded",
      sessionRef,
      timestamp,
      thinking: "partial reasoning, complete.",
    } as const,
    h.state,
  );

  expect(assistantRow(h.transcript).thinking).toBe("partial reasoning, complete.");
  expect(assistantRow(h.transcript).text).toBe("Answer.");
  expect(h.state.activeAssistantMessageBySession.get(key)).toBeUndefined();
});
