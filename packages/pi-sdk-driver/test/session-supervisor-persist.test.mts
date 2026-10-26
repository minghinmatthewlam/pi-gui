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

function releasableRecord() {
  const { record, emitted } = makeRecord();
  let disposals = 0;
  Object.assign(record, {
    status: "idle",
    runningRunId: undefined,
    promptStarting: false,
    extensionCommandsRunning: 0,
    queuedStartScheduled: false,
    reloadPending: false,
    extensionUiState: { statuses: new Map(), widgets: new Map(), dialogs: [], notices: [] },
    session: { isStreaming: false, isCompacting: false },
    runtime: {
      dispose: async () => {
        disposals += 1;
      },
    },
  });
  return { record, emitted, disposals: () => disposals };
}

function supervisorWith(record: { ref: { workspaceId: string; sessionId: string } }) {
  const catalog = makeCountingCatalog();
  const supervisor = new SessionSupervisor({ catalogStorage: catalog as never });
  (supervisor as unknown as { records: Map<string, unknown> }).records.set(
    `${record.ref.workspaceId}:${record.ref.sessionId}`,
    record,
  );
  return { supervisor, catalog };
}

await test("releasing frees the runtime, keeps the listeners and writes no catalog entry", async () => {
  const { record, emitted, disposals } = releasableRecord();
  const { supervisor, catalog } = supervisorWith(record);

  assert.equal(supervisor.releaseSession(record.ref), true);
  await record.eventQueue;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(disposals(), 1, "the runtime, its lease and its extensions are released");
  assert.equal(record.session, undefined);
  assert.equal(record.listeners.size, 1, "subscribers stay attached for the reopen");
  // A late catalog write could undo an archive made while the release was finishing.
  assert.equal(catalog.calls.length, 0);
  assert.ok(
    emitted.some((event) => event.type === "hostUiRequest"),
    "the stopped extensions' UI is reset",
  );
});

await test("a session is not released while an operation on it is running", async () => {
  const { record, disposals } = releasableRecord();
  const { supervisor } = supervisorWith(record);
  let finish!: () => void;
  const operation = supervisor.trackOperation(
    record.ref,
    () => new Promise<void>((resolve) => (finish = resolve)),
  );

  assert.equal(supervisor.releaseSession(record.ref), false);
  finish();
  await operation;
  assert.equal(supervisor.releaseSession(record.ref), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposals(), 1);
});
