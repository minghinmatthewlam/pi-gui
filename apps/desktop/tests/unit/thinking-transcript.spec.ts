import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import {
  appendAssistantDelta,
  appendThinkingDelta,
  applyTimelineEvent,
} from "../../electron/conversation/app-store-timeline";
import {
  isThinkingOpen,
  toggleThinkingRow,
  toggleThinkingVisibility,
} from "../../src/features/conversation/hooks/use-thinking-visibility";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = sessionKey(sessionRef);
const timestamp = "2026-09-22T19:00:00.000Z";

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

function messages(transcript: Map<string, readonly TranscriptMessage[]>): TranscriptMessage[] {
  return [...(transcript.get(key) ?? [])];
}

function assistantMessages(transcript: Map<string, readonly TranscriptMessage[]>) {
  return messages(transcript).filter(
    (item): item is Extract<TranscriptMessage, { kind: "message" }> =>
      item.kind === "message" && item.role === "assistant",
  );
}

test("reasoning streams into the reply it belongs to, separate from its text", () => {
  const { transcript, state } = fixture();
  appendThinkingDelta(transcript, state.activeAssistantMessageBySession, sessionRef, "Read ");
  appendThinkingDelta(transcript, state.activeAssistantMessageBySession, sessionRef, "the file.");
  appendAssistantDelta(transcript, state.activeAssistantMessageBySession, sessionRef, "Done.");

  const [reply] = assistantMessages(transcript);
  expect(reply?.thinking).toBe("Read the file.");
  expect(reply?.text).toBe("Done.");
});

test("an empty reasoning delta never opens a row", () => {
  const { transcript, state } = fixture();
  appendThinkingDelta(transcript, state.activeAssistantMessageBySession, sessionRef, "");
  expect(messages(transcript)).toHaveLength(0);
});

test("a reasoning delta does not move or duplicate the streaming reply", () => {
  const { transcript, state } = fixture();
  appendAssistantDelta(transcript, state.activeAssistantMessageBySession, sessionRef, "Answer");
  const before = messages(transcript);

  const event: SessionDriverEvent = {
    type: "thinkingDelta",
    sessionRef,
    timestamp,
    text: "extra reasoning",
  };
  appendThinkingDelta(transcript, state.activeAssistantMessageBySession, sessionRef, event.text);
  applyTimelineEvent(transcript, event, state);

  const [reply] = assistantMessages(transcript);
  expect(messages(transcript)).toHaveLength(before.length);
  expect(reply?.id).toBe(before[0]?.id);
  expect(reply?.thinking).toBe("extra reasoning");
  expect(reply?.text).toBe("Answer");
});

test("Cmd/Ctrl+T opens every reply, and one reply can stay closed after it", () => {
  // The store is renderer-wide view state; leave it at its default for other specs.
  expect(isThinkingOpen("row-1")).toBe(false);

  toggleThinkingVisibility();
  expect(isThinkingOpen("row-1")).toBe(true);
  expect(isThinkingOpen("row-2")).toBe(true);

  toggleThinkingRow("row-2");
  expect(isThinkingOpen("row-2")).toBe(false);
  expect(isThinkingOpen("row-1")).toBe(true);

  // The next global toggle wins over a single reply's choice.
  toggleThinkingVisibility();
  expect(isThinkingOpen("row-1")).toBe(false);
  expect(isThinkingOpen("row-2")).toBe(false);
});
