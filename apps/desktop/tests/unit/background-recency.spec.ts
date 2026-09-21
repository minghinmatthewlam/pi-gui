import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import { createConversationOwner } from "../../electron/conversation/app-store-composer";

const sessionRef: SessionRef = { workspaceId: "ws", sessionId: "sess" };

function deliveryHost(status: "idle" | "running") {
  const stamps: SessionRef[] = [];
  const sent: string[] = [];
  const queued: string[] = [];
  const transcriptCache = new Map<string, readonly unknown[]>();
  const host = {
    conversationState: {
      transcriptCache,
      activeAssistantMessageBySession: new Map<string, string>(),
      sessionErrorsBySession: new Map<string, string>(),
    },
    driver: {
      sendUserMessage: async (_ref: SessionRef, message: { text: string }) => {
        sent.push(message.text);
      },
      replaceQueuedMessages: async (_ref: SessionRef, messages: readonly { text: string }[]) => {
        queued.push(...messages.map((message) => message.text));
      },
    },
    ensureSessionReady: async () => undefined,
    sessionFromState: () => ({
      updatedAt: "2026-09-21T00:00:00.000Z",
      title: "Target",
      status,
    }),
    getQueuedComposerMessages: () => [],
    recordUserMessageRecency: (ref: SessionRef) => {
      stamps.push(ref);
      return true;
    },
    publishSelectedTranscriptFor: () => undefined,
    refreshState: async () => ({}) as never,
  };
  return { host, stamps, sent, queued, transcriptCache };
}

test("a scheduled-task user message stamps recency", async () => {
  const { host, stamps, sent, transcriptCache } = deliveryHost("idle");
  const owner = createConversationOwner(host as never);
  const messageId = await owner.deliverBackgroundInstruction(sessionRef, "Run the task");

  expect(messageId).toBeTruthy();
  expect(stamps).toEqual([sessionRef]);
  expect(sent).toEqual(["Run the task"]);
  expect(transcriptCache.size).toBe(1);
});

test("a scheduled-task follow-up queued onto a running thread stamps recency", async () => {
  const { host, stamps, sent, queued } = deliveryHost("running");
  const owner = createConversationOwner(host as never);
  const messageId = await owner.deliverBackgroundInstruction(sessionRef, "Run the task");

  expect(messageId).toBeUndefined();
  expect(stamps).toEqual([sessionRef]);
  expect(queued).toEqual(["Run the task"]);
  expect(sent).toEqual([]);
});

test("an empty scheduled-task instruction does not stamp recency", async () => {
  const { host, stamps, sent } = deliveryHost("idle");
  const owner = createConversationOwner(host as never);

  await expect(owner.deliverBackgroundInstruction(sessionRef, "   ")).rejects.toThrow(/empty/);
  expect(stamps).toEqual([]);
  expect(sent).toEqual([]);
});
