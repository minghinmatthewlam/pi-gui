import { expect, test } from "@playwright/test";
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";

const timestamp = "2026-10-26T00:00:00.000Z";

function link(id: string, parentSessionId: string): OrchestrationChildThread {
  return {
    id,
    parentWorkspaceId: "ws",
    parentSessionId,
    childWorkspaceId: "ws",
    childSessionId: id,
    title: id,
    goal: id,
    status: "complete",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const workerReply: readonly TranscriptMessage[] = [
  { kind: "message", id: "reply", role: "assistant", createdAt: timestamp, text: "Done." },
];

function fixture(options: { readonly onEnsureSessionReady: () => void }) {
  let children: readonly OrchestrationChildThread[] = [
    link("child", "parent"),
    link("grandchild", "child"),
  ];
  const archivedAt = new Map<string, string>([["grandchild", timestamp]]);
  const archiveWrites: string[] = [];
  const host = {
    initialize: async () => undefined,
    orchestrationChildren: () => children,
    orchestrationState: () => ({ workspaces: [], orchestrationChildren: children }),
    replaceOrchestrationChildren: (next: readonly OrchestrationChildThread[]) => {
      children = next;
    },
    sessionFromState: (ref: SessionRef) => ({
      title: ref.sessionId,
      status: "idle",
      updatedAt: timestamp,
      ...(archivedAt.has(ref.sessionId) ? { archivedAt: archivedAt.get(ref.sessionId) } : {}),
    }),
    ensureSessionReady: async () => {
      options.onEnsureSessionReady();
      return undefined;
    },
    lastRunOutcome: () => "completed" as const,
    archiveIdleSession: async (ref: SessionRef) => {
      archiveWrites.push(sessionKey(ref));
      archivedAt.set(ref.sessionId, timestamp);
    },
    getQueuedComposerMessages: () => [],
    transcriptFor: () => workerReply,
    persistUiState: async () => undefined,
    emit: () => undefined,
  };
  return {
    owner: createOrchestrationOwner(
      host as unknown as Parameters<typeof createOrchestrationOwner>[0],
    ),
    archivedAt,
    archiveWrites,
  };
}

const parentRef = { workspaceId: "ws", sessionId: "parent" };

test("a finished child with only archived children is archived", async () => {
  const f = fixture({ onEnsureSessionReady: () => undefined });
  const result = await f.owner.archiveChildThreadsToolResult(parentRef, ["child"]);
  expect(result.details.archived).toEqual(["child"]);
  expect(f.archiveWrites).toEqual([sessionKey({ workspaceId: "ws", sessionId: "child" })]);
});

test("a grandchild restored while the child opens keeps the child unarchived", async () => {
  const f = fixture({
    // The user restores the grandchild while a cold child session is being opened.
    onEnsureSessionReady: () => f.archivedAt.delete("grandchild"),
  });
  const result = await f.owner.archiveChildThreadsToolResult(parentRef, ["child"]);
  expect(result.details.archived).toEqual([]);
  expect(result.details.skipped).toEqual([
    { threadId: "child", reason: "This child has its own unarchived child threads." },
  ]);
  expect(f.archiveWrites).toEqual([]);
});

test("a child the user archived while it opened is not archived again", async () => {
  const f = fixture({ onEnsureSessionReady: () => f.archivedAt.set("child", timestamp) });
  const result = await f.owner.archiveChildThreadsToolResult(parentRef, ["child"]);
  expect(result.details.skipped).toEqual([
    { threadId: "child", reason: "Child thread is already archived." },
  ]);
  expect(f.archiveWrites).toEqual([]);
});
