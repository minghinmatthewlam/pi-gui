import test from "node:test";
import assert from "node:assert/strict";
import { sessionKey } from "@pi-gui/session-driver";
import { SessionSupervisor } from "../dist/session-supervisor.js";

function fixture() {
  const writes: unknown[] = [];
  const emitted: string[] = [];
  const record = {
    ref: { workspaceId: "ws", sessionId: "child" },
    workspace: { workspaceId: "ws", path: "/tmp/archive-probe" },
    title: "Completed child",
    updatedAt: "2026-10-24T00:00:00Z",
    status: "idle",
    archivedAt: undefined as string | undefined,
    runningRunId: undefined as string | undefined,
    promptStarting: false,
    extensionCommandsRunning: 0,
    queuedStartScheduled: false,
    queuedStartRecheck: false,
    sendsSettling: 0,
    queueStepsPending: 0,
    piQueueSync: Promise.resolve() as Promise<unknown>,
    startedQueuedMessageIds: new Set<string>(),
    acceptedQueuedMessageIds: new Set<string>(),
    reloadInFlight: undefined as Promise<void> | undefined,
    reloadPending: false,
    queuedMessages: [] as unknown[],
    startingQueuedMessage: undefined as unknown,
    pendingHostUiRequests: new Map(),
    closed: false,
    listeners: new Set([
      (event: { type: string }) => {
        emitted.push(event.type);
      },
    ]),
    session: {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      messages: [{ role: "assistant", stopReason: "stop", content: "done" }] as {
        role: string;
        stopReason?: string;
        content: string;
      }[],
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      clearQueue: () => undefined,
      sessionManager: {
        getBranch: () => [{ type: "message", id: "reply-1", message: { role: "assistant" } }],
      },
    },
  };
  // The catalog's stopped-run marks, by session key, as the guarded archive reads them.
  const marks = new Map<string, string>();
  const supervisor = new SessionSupervisor({
    catalogStorage: {
      sessions: {
        upsertSession: async (value: unknown) => {
          writes.push(value);
        },
        setStoppedReplyId: async (ref: { workspaceId: string; sessionId: string }, id?: string) => {
          if (id === undefined) marks.delete(sessionKey(ref));
          else marks.set(sessionKey(ref), id);
        },
        archiveSessionUnlessStopped: async (
          ref: { workspaceId: string; sessionId: string },
          _archivedAt: string,
          newestReplyId: string | undefined,
        ) => newestReplyId === undefined || marks.get(sessionKey(ref)) !== newestReplyId,
      },
    } as never,
  });
  (supervisor as unknown as { records: Map<string, unknown> }).records.set(
    sessionKey(record.ref),
    record,
  );
  return { supervisor, record, writes, emitted, marks };
}

await test("idle archive preserves history and uses the normal archive/restore persistence path", async () => {
  const f = fixture();
  const history = f.record.session.messages;
  await f.supervisor.archiveSessionIfIdle(f.record.ref);
  assert.ok(f.record.archivedAt);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.emitted, ["sessionUpdated"]);
  assert.equal(f.record.session.messages, history);
  await f.supervisor.unarchiveSession(f.record.ref);
  assert.equal(f.record.archivedAt, undefined);
  assert.equal(f.record.session.messages, history);
});

const busyCases: Record<string, (record: ReturnType<typeof fixture>["record"]) => void> = {
  "running turn": (r) => {
    r.runningRunId = "run";
  },
  "prompt about to start": (r) => {
    r.promptStarting = true;
  },
  "streaming or waiting on a tool": (r) => {
    r.session.isStreaming = true;
  },
  compaction: (r) => {
    r.session.isCompacting = true;
  },
  "extension command": (r) => {
    r.extensionCommandsRunning = 1;
  },
  "queued follow-up": (r) => {
    r.queuedMessages = [{ text: "keep working" }];
  },
  "runtime queue": (r) => {
    r.session.pendingMessageCount = 1;
  },
  "scheduled queue start": (r) => {
    r.queuedStartScheduled = true;
  },
  "send waiting for reloads to settle": (r) => {
    r.sendsSettling = 1;
  },
  "taken queue entry": (r) => {
    r.startingQueuedMessage = { text: "next" };
  },
  "run stopped but not yet settled by pi": (r) => {
    Object.assign(r, { runAwaitingSettle: true });
  },
  "pending dialog": (r) => {
    r.pendingHostUiRequests.set("permission", {});
  },
  "failed session": (r) => {
    r.status = "failed";
  },
};
for (const [name, mutate] of Object.entries(busyCases)) {
  await test(`idle archive refuses ${name} without a write or cancellation`, async () => {
    const f = fixture();
    mutate(f.record);
    await assert.rejects(f.supervisor.archiveSessionIfIdle(f.record.ref));
    assert.equal(f.record.archivedAt, undefined);
    assert.equal(f.writes.length, 0);
    assert.equal(f.emitted.length, 0);
  });
}
await test("idle archive checks after awaiting session loading, not an earlier idle snapshot", async () => {
  const f = fixture();
  const promise = f.supervisor.archiveSessionIfIdle(f.record.ref);
  f.record.promptStarting = true;
  await assert.rejects(promise);
  assert.equal(f.writes.length, 0);
});
await test("idle archive leaves the finished-work decision to the caller", async () => {
  const f = fixture();
  f.record.session.messages = [{ role: "assistant", stopReason: "aborted", content: "partial" }];
  await f.supervisor.archiveSessionIfIdle(f.record.ref);
  assert.ok(f.record.archivedAt);
});
await test("a leftover queue recheck hint after the queue drained does not block archiving", async () => {
  const f = fixture();
  f.record.queuedStartRecheck = true;
  await f.supervisor.archiveSessionIfIdle(f.record.ref);
  assert.ok(f.record.archivedAt);
});

await test("idle archive refuses when the run outcome changed since the caller checked", async () => {
  const f = fixture();
  f.record.session.messages = [{ role: "assistant", stopReason: "aborted", content: "partial" }];
  await assert.rejects(
    f.supervisor.archiveSessionIfIdle(f.record.ref, { lastRunOutcome: "completed" }),
    /last run changed/,
  );
  assert.equal(f.writes.length, 0);
  f.record.session.messages = [{ role: "assistant", stopReason: "stop", content: "done" }];
  await f.supervisor.archiveSessionIfIdle(f.record.ref, { lastRunOutcome: "completed" });
  assert.ok(f.record.archivedAt);
});

await test("idle archive refuses a send that is still waiting for a reload to settle", async () => {
  const f = fixture();
  let finishReload!: () => void;
  f.record.reloadInFlight = new Promise<void>((resolve) => {
    finishReload = resolve;
  });
  const sending = f.supervisor.sendUserMessage(f.record.ref, { text: "one more thing" });
  await assert.rejects(f.supervisor.archiveSessionIfIdle(f.record.ref), /not archived/);
  assert.equal(f.record.archivedAt, undefined);
  assert.equal(f.writes.length, 0);
  f.record.reloadInFlight = undefined;
  finishReload();
  await sending.catch(() => undefined);
  assert.equal(f.record.sendsSettling, 0);
});

await test("idle archive refuses while a queue change is still being applied", async () => {
  const f = fixture();
  const replacing = f.supervisor.replaceQueuedMessages(f.record.ref, []);
  await assert.rejects(f.supervisor.archiveSessionIfIdle(f.record.ref), /not archived/);
  assert.equal(f.record.archivedAt, undefined);
  await replacing;
  assert.equal(f.record.queueStepsPending, 0);
  await f.supervisor.archiveSessionIfIdle(f.record.ref);
  assert.ok(f.record.archivedAt);
});

await test("a send that started after an archive landed brings the thread back", async () => {
  const f = fixture();
  await f.supervisor.archiveSessionIfIdle(f.record.ref);
  assert.ok(f.record.archivedAt);
  // The fixture has no real pi session, so the prompt itself fails after the send starts.
  await f.supervisor
    .sendUserMessage(f.record.ref, { text: "one more thing" })
    .catch(() => undefined);
  assert.equal(f.record.archivedAt, undefined);
});

await test("a queued message starting does not undo the user's archive", async () => {
  const f = fixture();
  await f.supervisor.archiveSession(f.record.ref);
  const archivedAt = f.record.archivedAt;
  assert.ok(archivedAt);
  const supervisor = f.supervisor as unknown as {
    sendReadyMessage(record: unknown, input: { text: string }): Promise<void>;
  };
  await supervisor.sendReadyMessage(f.record, { text: "queued follow-up" }).catch(() => undefined);
  assert.equal(f.record.archivedAt, archivedAt);
});

function queueFixture() {
  const f = fixture();
  const piQueue: string[] = [];
  const session = f.record.session as typeof f.record.session & Record<string, unknown>;
  Object.assign(f.record, { eventQueue: Promise.resolve() });
  Object.assign(session, {
    followUp: async (text: string) => {
      piQueue.push(text);
    },
    steer: async () => undefined,
    getFollowUpMessages: () => piQueue,
    clearQueue: () => {
      piQueue.length = 0;
    },
  });
  const started: { text: string; archived: boolean }[] = [];
  Object.assign(f.supervisor, {
    sendReadyMessage: async (record: { archivedAt?: string }, input: { text: string }) => {
      started.push({ text: input.text, archived: Boolean(record.archivedAt) });
    },
  });
  return { ...f, started };
}

function queued(id: string, text: string) {
  return {
    id,
    text,
    mode: "followUp" as const,
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
}

await test("a follow-up queued while an agent archive landed brings the thread back before it starts", async () => {
  const f = queueFixture();
  // The app accepted the follow-up while the child ran, then awaited before queueing it.
  // Meanwhile the child settled and the parent agent archived it.
  await f.supervisor.archiveSessionIfIdle(f.record.ref, { lastRunOutcome: "completed" });
  assert.ok(f.record.archivedAt);
  await f.supervisor.replaceQueuedMessages(f.record.ref, [queued("q1", "one more thing")]);
  await f.record.piQueueSync;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.started, [{ text: "one more thing", archived: false }]);
  assert.equal(f.record.archivedAt, undefined);
});

await test("editing or removing what was already queued keeps the user's archive", async () => {
  const f = queueFixture();
  f.record.runningRunId = "run";
  f.record.status = "running";
  await f.supervisor.replaceQueuedMessages(f.record.ref, [queued("q1", "first")]);
  await f.supervisor.archiveSession(f.record.ref);
  const archivedAt = f.record.archivedAt;
  assert.ok(archivedAt);
  await f.supervisor.replaceQueuedMessages(f.record.ref, [queued("q1", "first, edited")]);
  assert.equal(f.record.archivedAt, archivedAt);
  await f.supervisor.replaceQueuedMessages(f.record.ref, []);
  assert.equal(f.record.archivedAt, archivedAt);
  assert.deepEqual(f.started, []);
});

await test("a late edit of a message Stop cleared does not undo the user's archive", async () => {
  const f = queueFixture();
  f.record.runningRunId = "run";
  f.record.status = "running";
  await f.supervisor.replaceQueuedMessages(f.record.ref, [queued("q1", "first")]);
  // Stop clears the queue; the user then archives; an edit of q1 started before Stop lands.
  f.record.queuedMessages = [];
  await f.supervisor.archiveSession(f.record.ref);
  const archivedAt = f.record.archivedAt;
  await f.supervisor.replaceQueuedMessages(f.record.ref, [queued("q1", "first, edited")]);
  assert.equal(f.record.archivedAt, archivedAt);
});

await test("idle archive refuses a completed reply the catalog marks as stopped", async () => {
  const f = fixture();
  f.marks.set(sessionKey(f.record.ref), "reply-1");
  await assert.rejects(
    f.supervisor.archiveSessionIfIdle(f.record.ref, { lastRunOutcome: "completed" }),
    /last run changed/,
  );
  assert.equal(f.record.archivedAt, undefined);
  f.marks.set(sessionKey(f.record.ref), "an-older-reply");
  await f.supervisor.archiveSessionIfIdle(f.record.ref, { lastRunOutcome: "completed" });
  assert.ok(f.record.archivedAt);
});

await test("idle archive refuses while a stopped-run mark write has failed (fail-safe)", async () => {
  const f = fixture();
  const sessions = (f.supervisor as unknown as { catalogs: { sessions: Record<string, unknown> } })
    .catalogs.sessions;
  let fail = true;
  Object.assign(sessions, {
    setStoppedReplyId: async () => {
      if (fail) throw new Error("disk full");
    },
  });
  const internals = f.supervisor as unknown as {
    markStoppedReply(record: unknown, replyId: string | undefined): void;
  };
  internals.markStoppedReply(f.record, "reply-1");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    f.supervisor.archiveSessionIfIdle(f.record.ref, { lastRunOutcome: "completed" }),
    /last run changed/,
  );
  // A later write that succeeds lets the catalog decide again.
  fail = false;
  internals.markStoppedReply(f.record, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await f.supervisor.archiveSessionIfIdle(f.record.ref, { lastRunOutcome: "completed" });
  assert.ok(f.record.archivedAt);
});

await test("idle archive waits for a stopped-run mark write in flight, and refuses if it fails", async () => {
  const f = fixture();
  const sessions = (f.supervisor as unknown as { catalogs: { sessions: Record<string, unknown> } })
    .catalogs.sessions;
  let failWrite!: (error: Error) => void;
  Object.assign(sessions, {
    setStoppedReplyId: () =>
      new Promise<void>((_resolve, reject) => {
        failWrite = reject;
      }),
  });
  (
    f.supervisor as unknown as { markStoppedReply(record: unknown, replyId: string): void }
  ).markStoppedReply(f.record, "reply-1");
  const archiving = f.supervisor.archiveSessionIfIdle(f.record.ref, {
    lastRunOutcome: "completed",
  });
  failWrite(new Error("disk full"));
  await assert.rejects(archiving, /last run changed/);
  assert.equal(f.record.archivedAt, undefined);
});

await test("idle archive also waits for a Stop mark write queued while it waited on an earlier one", async () => {
  const f = fixture();
  const sessions = (f.supervisor as unknown as { catalogs: { sessions: Record<string, unknown> } })
    .catalogs.sessions;
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  Object.assign(sessions, {
    setStoppedReplyId: () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  });
  const mark = (
    f.supervisor as unknown as {
      markStoppedReply(record: unknown, replyId: string | undefined): void;
    }
  ).markStoppedReply.bind(f.supervisor);
  mark(f.record, undefined);
  const archiving = f.supervisor.archiveSessionIfIdle(f.record.ref, {
    lastRunOutcome: "completed",
  });
  // The guard is now waiting on the first write; a Stop queues a second one.
  await new Promise((resolve) => setImmediate(resolve));
  mark(f.record, "reply-1");
  pending[0]!.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  pending[1]!.reject(new Error("disk full"));
  await assert.rejects(archiving, /last run changed/);
  assert.equal(f.record.archivedAt, undefined);
});
