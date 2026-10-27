import { expect, test } from "@playwright/test";
import { sessionKey } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";

const timestamp = "2026-10-24T00:00:00.000Z";

function child(id: string, parentSessionId: string): OrchestrationChildThread {
  return Object.freeze({
    id,
    parentWorkspaceId: "ws",
    parentSessionId,
    childWorkspaceId: "ws",
    childSessionId: id,
    title: id,
    goal: id,
    status: "running",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function fixture() {
  let children: readonly OrchestrationChildThread[] = [
    child("a", "parent-a"),
    child("b", "parent-b"),
  ];
  const transcripts = new Map<string, readonly TranscriptMessage[]>();
  const empty: readonly TranscriptMessage[] = [];
  const forbidden = (): never => {
    throw new Error("Projection must not invoke task or persistence operations");
  };
  const forbiddenAsync = (): Promise<never> =>
    Promise.reject(new Error("Projection must not invoke async task operations"));
  const host: Parameters<typeof createOrchestrationOwner>[0] = {
    driver: { createSession: forbiddenAsync, cancelCurrentRun: forbiddenAsync },
    initialize: forbiddenAsync,
    orchestrationState: () => ({ workspaces: [], orchestrationChildren: children }),
    orchestrationChildren: () => children,
    replaceOrchestrationChildren: forbidden,
    refreshState: forbiddenAsync,
    emit: forbidden,
    withError: forbiddenAsync,
    persistUiState: forbiddenAsync,
    workspaceRefFromState: forbidden,
    sessionFromState: (ref) => ({ title: ref.sessionId, status: "running", updatedAt: timestamp }),
    ensureSessionReady: forbiddenAsync,
    ensureSessionSubscription: forbiddenAsync,
    subscribeToSessionEvents: forbidden,
    updateSessionConfig: forbidden,
    buildCreateSessionOptions: forbiddenAsync,
    getQueuedComposerMessages: () => [],
    seedSession: forbidden,
    transcriptFor: () => empty,
    transcriptForKey: (key) => transcripts.get(key) ?? empty,
    replaceTranscript: forbidden,
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: forbidden,
    submitComposerToSession: forbiddenAsync,
  };
  return {
    owner: createOrchestrationOwner(host),
    transcripts,
    setChildren: (next: readonly OrchestrationChildThread[]) => {
      children = next;
    },
  };
}

test("unchanged parent histories are not rescanned while another worker updates", () => {
  const f = fixture();
  let readsA = 0,
    readsB = 0;
  f.transcripts.set(sessionKey({ workspaceId: "ws", sessionId: "parent-a" }), [
    {
      kind: "message",
      id: "accepted-a",
      role: "assistant",
      createdAt: timestamp,
      get text() {
        readsA++;
        return "orchestrator-accepted: a first acceptance";
      },
    },
  ]);
  f.transcripts.set(sessionKey({ workspaceId: "ws", sessionId: "parent-b" }), [
    {
      kind: "message",
      id: "accepted-b",
      role: "assistant",
      createdAt: timestamp,
      get text() {
        readsB++;
        return "orchestrator-accepted: b other acceptance";
      },
    },
  ]);
  const ref = { workspaceId: "ws", sessionId: "a" };
  const first = f.owner.projectOrchestrationChildrenForSessions([ref]);
  expect(first[0]?.evidence.some((e) => e.source === "orchestrator-accepted")).toBe(true);
  const counts = [readsA, readsB];
  for (let i = 0; i < 100; i++) f.owner.projectOrchestrationChildrenForSessions([ref]);
  expect([readsA, readsB]).toEqual(counts);
  f.transcripts.set(sessionKey({ workspaceId: "ws", sessionId: "parent-a" }), [
    {
      kind: "message",
      id: "new-acceptance",
      role: "assistant",
      createdAt: timestamp,
      text: "orchestrator-accepted: a updated acceptance",
    },
  ]);
  const next = f.owner.projectOrchestrationChildrenForSessions([ref]);
  expect(next[0]?.evidence.find((e) => e.source === "orchestrator-accepted")?.detail).toBe(
    "updated acceptance",
  );
  expect(readsB).toBe(counts[1]);
});

test("new child identities and rewound histories invalidate evidence without retaining stale acceptance", () => {
  const f = fixture();
  const key = sessionKey({ workspaceId: "ws", sessionId: "parent-a" });
  const transcript: readonly TranscriptMessage[] = [
    {
      kind: "message",
      id: "accept-new",
      role: "assistant",
      createdAt: timestamp,
      text: "orchestrator-accepted: new-child accepted",
    },
  ];
  f.transcripts.set(key, transcript);
  f.owner.projectOrchestrationChildren();
  f.setChildren([child("new-child", "parent-a")]);
  const added = f.owner.projectOrchestrationChildren();
  expect(added[0]?.evidence.find((e) => e.source === "orchestrator-accepted")?.childSessionId).toBe(
    "new-child",
  );
  f.setChildren([{ ...child("new-child", "parent-a"), childSessionId: "replacement-session" }]);
  const replaced = f.owner.projectOrchestrationChildren();
  expect(
    replaced[0]?.evidence.find((e) => e.source === "orchestrator-accepted")?.childSessionId,
  ).toBe("replacement-session");
  f.transcripts.set(key, []);
  expect(f.owner.projectOrchestrationChildren()[0]?.evidence).toEqual([]);
});
