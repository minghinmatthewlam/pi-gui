import test from "node:test";
import assert from "node:assert/strict";
import { SessionSupervisor } from "../dist/session-supervisor.js";

/**
 * Guards the call site, not the predicate: these drive the real
 * handleAgentEvent -> queueDriverEvents -> persistSnapshot path with a counting
 * catalog, so deleting the shouldPersistSnapshotForAgentEvent call in
 * handleAgentEvent fails them.
 */

function makeCountingCatalog() {
  const calls: string[] = [];
  return {
    calls,
    sessions: {
      upsertSession: async (entry: { title: string }) => {
        calls.push(entry.title);
      },
    },
    setSessionFile: async () => undefined,
  };
}

function makeRecord() {
  const emitted: Array<{ type: string }> = [];
  const record = {
    ref: { workspaceId: "ws-1", sessionId: "sess-1" },
    workspace: { workspaceId: "ws-1", path: "/tmp/ws-1", displayName: "ws-1" },
    title: "persist probe",
    runtime: undefined,
    session: undefined,
    sessionFile: undefined,
    status: "running",
    updatedAt: new Date().toISOString(),
    archivedAt: undefined,
    preview: undefined,
    config: undefined,
    runningRunId: "run-1",
    queuedMessages: [],
    closed: false,
    listeners: new Set([
      (event: { type: string }) => {
        emitted.push(event);
      },
    ]),
    eventQueue: Promise.resolve(),
    unsubscribeAgent: undefined,
    pendingHostUiRequests: new Map(),
    extensionUiState: { dialogs: [], notices: [] },
    bindingExtensions: false,
    sessionCommands: [],
    leasePath: undefined,
    transcriptDiskMtimeMs: undefined,
  };
  return { record, emitted };
}

async function drive(event: unknown) {
  const catalog = makeCountingCatalog();
  const supervisor = new SessionSupervisor({
    catalogStorage: catalog as never,
  }) as unknown as {
    handleAgentEvent: (record: unknown, event: unknown) => void;
  };
  const { record, emitted } = makeRecord();
  supervisor.handleAgentEvent(record, event);
  await record.eventQueue;
  return { catalogWrites: catalog.calls.length, emitted };
}

const assistantDelta = {
  type: "message_update",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  assistantMessageEvent: { type: "text_delta", delta: "hello" },
};

await test("a streaming partial emits its driver events without writing the catalog", async () => {
  const { catalogWrites, emitted } = await drive(assistantDelta);

  // The event still reaches the UI...
  assert.ok(
    emitted.some((event) => event.type === "assistantDelta"),
    `expected an assistantDelta, got ${JSON.stringify(emitted.map((e) => e.type))}`,
  );
  // ...but costs no durable catalog write. This is the whole fix: without it
  // every streamed token queues an fsync ahead of every other session
  // operation.
  assert.equal(catalogWrites, 0);
});

await test("a discrete agent event still writes the catalog", async () => {
  const { catalogWrites, emitted } = await drive({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  });

  assert.ok(emitted.length > 0, "expected the discrete event to emit");
  assert.equal(catalogWrites, 1);
});
