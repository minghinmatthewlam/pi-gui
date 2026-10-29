import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { SessionFileCatalogStorage } from "@pi-gui/catalogs";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function response(model: Parameters<StreamFunction>[0], text: string, error?: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: error ? "error" : "stop",
    ...(error ? { errorMessage: error } : {}),
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  if (text) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  if (error) stream.push({ type: "error", reason: "error", error: message });
  else stream.push({ type: "done", reason: "stop", message });
  return stream;
}

/**
 * Use the installed Pi runtime, real extension callbacks, and the driver's
 * public API. Only model streaming is replaced. No credentials, remote
 * providers, user session files, or timing-based sleeps are involved.
 */
async function fixture(
  t: TestContext,
  streamFunction: StreamFunction,
  extension?: ExtensionFactory,
  wrapCatalog?: (catalog: JsonCatalogStore) => SessionFileCatalogStorage,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-boundary-lifecycle-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // SessionSupervisor creates the SessionManager before invoking its factory.
  // Keep that default session-directory resolution inside this test's temp dir.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Lifecycle regression tests must never use the network");
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0, "no network request is permitted"));
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "boundary-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  const rawEvents: AgentSessionEvent[] = [];
  const events: SessionDriverEvent[] = [];
  const changed = new Set<() => void>();
  let runtime!: AgentSessionRuntime;
  const catalog = new JsonCatalogStore({ catalogFilePath: join(root, "catalogs.json") });
  const driver = new PiSdkDriver({
    agentDir,
    catalogStorage: wrapCatalog ? wrapCatalog(catalog) : catalog,
    createAgentSessionRuntimeImpl: async (options) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...options,
        tools: [],
        resourceLoaderOptions: {
          ...options?.resourceLoaderOptions,
          extensionFactories: [
            ...(options?.resourceLoaderOptions?.extensionFactories ?? []),
            ...(extension ? [extension] : []),
          ],
        },
      });
      runtime.session.agent.streamFunction = streamFunction;
      runtime.session.subscribe((event) => rawEvents.push(event));
      return runtime;
    },
  });
  // The workspace as the app registers it, so a later sync rebuilds this session's entry.
  const { workspace } = await driver.syncWorkspace(cwd, "Boundary");
  const snapshot = await driver.createSession(workspace, {
    initialModel: { provider: "boundary-test", modelId: "scripted" },
  });
  const ref = snapshot.ref;
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
    for (const listener of changed) listener();
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });

  function until(predicate: () => boolean) {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!predicate()) return;
        changed.delete(check);
        resolve();
      };
      changed.add(check);
    });
  }

  return {
    driver,
    ref,
    root,
    workspacePath: cwd,
    // The latest runtime; reopening a released session creates a new one.
    get runtime() {
      return runtime;
    },
    /** A second driver on the same catalog and agent dir, as after an app restart. */
    restartedDriver: () => {
      const restarted = new PiSdkDriver({
        agentDir,
        catalogFilePath: join(root, "catalogs.json"),
        createAgentSessionRuntimeImpl: async (options) => {
          const reopened = await createAgentSessionRuntimeWithNpmFallback({
            ...options,
            tools: [],
          });
          reopened.session.agent.streamFunction = streamFunction;
          return reopened;
        },
      });
      t.after(() => restarted.closeSession(ref));
      return restarted;
    },
    events,
    rawEvents,
    until,
    completions: () => events.filter((event) => event.type === "runCompleted"),
    failures: () => events.filter((event) => event.type === "runFailed"),
    initialRunId: () => {
      const first = events.find(
        (event) => event.type === "sessionUpdated" && event.snapshot.status === "running",
      );
      assert.ok(first?.type === "sessionUpdated");
      assert.ok(first.snapshot.runningRunId);
      return first.snapshot.runningRunId;
    },
  };
}

async function assertPersistedAssistantIdentity(h: Awaited<ReturnType<typeof fixture>>) {
  const nativeIds = h.runtime.session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => entry.id);
  const persisted = h.events.filter((event) => event.type === "assistantMessagePersisted");
  assert.deepEqual(
    persisted.map((event) => event.sourceMessageId),
    nativeIds,
    "each finalized assistant response must publish its actual persisted Pi entry ID",
  );
  assert.deepEqual(
    h.events
      .filter(
        (event) =>
          event.type === "assistantMessageEnded" || event.type === "assistantMessagePersisted",
      )
      .map((event) => event.type),
    nativeIds.flatMap(() => ["assistantMessageEnded", "assistantMessagePersisted"]),
    "message completion precedes persisted identity, including retries and continuations",
  );
  for (const event of persisted) {
    assert.deepEqual(event.sessionRef, h.ref);
    assert.ok(event.runId);
  }
  const transcript = await h.driver.getTranscript(h.ref);
  for (const item of transcript) {
    if (item.kind === "message" && item.role === "assistant") {
      assert.ok(
        nativeIds.includes(item.id),
        "hydrated assistant rows use the same identity as live events",
      );
      assert.equal(
        item.sourceMessageId,
        item.id,
        "hydrated review actions retain the native source ID",
      );
    }
  }
  return persisted;
}

await test(
  "before-settle continuation stays running and completes once with the original run id",
  { timeout: 15000 },
  async (t) => {
    const beforeSettle = gate();
    const continueRun = gate();
    const idleCommandStarted = gate();
    const idleLifecycle: string[] = [];
    let continued = false;
    let requests = 0;
    const contexts: string[] = [];
    const h = await fixture(
      t,
      (model, context) => {
        contexts.push(JSON.stringify(context.messages));
        requests += 1;
        return response(model, requests === 1 ? "First response" : "Continued response");
      },
      (pi) => {
        pi.registerCommand("wait-idle", {
          description: "Wait for the entire session activity to settle",
          handler: async (_args, ctx) => {
            idleCommandStarted.release();
            await ctx.waitForIdle();
            idleLifecycle.push("idle-command-resolved");
          },
        });
        pi.on("agent_settled", () => {
          idleLifecycle.push("agent-settled");
        });
        pi.on("agent_before_settle", async () => {
          if (continued) return;
          continued = true;
          beforeSettle.release();
          await continueRun.promise;
          return {
            entries: [
              {
                type: "custom_message",
                customType: "lifecycle-test",
                content: "Continue checking",
                display: false,
              },
            ],
            continue: true,
          };
        });
      },
    );
    const sending = h.driver.sendUserMessage(h.ref, { text: "Start" });
    let waitingForIdle = Promise.resolve();
    try {
      await beforeSettle.promise;
      const pending = await h.driver.openSession(h.ref);
      assert.equal(pending.status, "running", "agent_end is not a desktop run boundary");
      assert.equal(pending.runningRunId, h.initialRunId());
      assert.equal(h.completions().length, 0);
      assert.equal(h.failures().length, 0);

      waitingForIdle = h.driver.sendUserMessage(h.ref, { text: "/wait-idle" });
      await idleCommandStarted.promise;
      // The first agent-core run is already idle while the before-settle hook
      // is gated. Drain its promise continuations without releasing the gate:
      // an incorrectly bound agent.waitForIdle() would finish this command now.
      await nextEventLoopTurn();
      assert.deepEqual(idleLifecycle, [], "the command must wait through before-settle work");
      assert.equal(h.rawEvents.filter((event) => event.type === "agent_settled").length, 0);
    } finally {
      continueRun.release();
      await Promise.all([sending, waitingForIdle]);
    }
    await h.until(() => h.completions().length > 0);
    assert.equal(requests, 2);
    assert.match(contexts[1]!, /Continue checking/);
    assert.equal(h.rawEvents.filter((event) => event.type === "agent_end").length, 2);
    assert.equal(h.rawEvents.filter((event) => event.type === "agent_settled").length, 1);
    assert.equal(h.completions().length, 1);
    assert.equal(h.completions()[0]?.runId, h.initialRunId());
    assert.equal(h.completions()[0]?.snapshot.preview, "Continued response");
    assert.deepEqual(idleLifecycle, ["agent-settled", "idle-command-resolved"]);
    assert.deepEqual(
      h.events
        .filter(
          (event) =>
            event.type === "assistantDelta" ||
            event.type === "assistantMessageEnded" ||
            event.type === "assistantMessagePersisted" ||
            event.type === "runCompleted",
        )
        .map((event) => [
          event.type,
          event.type === "assistantDelta" ? event.text : undefined,
          event.runId,
        ]),
      [
        ["assistantDelta", "First response", h.initialRunId()],
        ["assistantMessageEnded", undefined, h.initialRunId()],
        ["assistantMessagePersisted", undefined, h.initialRunId()],
        ["assistantDelta", "Continued response", h.initialRunId()],
        ["assistantMessageEnded", undefined, h.initialRunId()],
        ["assistantMessagePersisted", undefined, h.initialRunId()],
        ["runCompleted", undefined, h.initialRunId()],
      ],
    );
    await assertPersistedAssistantIdentity(h);
    const final = await h.driver.openSession(h.ref);
    assert.equal(final.status, "idle");
    assert.equal(final.runningRunId, undefined);
  },
);

await test(
  "a retryable attempt keeps the run id and reports only the eventual success",
  { timeout: 15000 },
  async (t) => {
    const retryStarted = gate();
    const finishRetry = gate();
    let requests = 0;
    const h = await fixture(t, async (model) => {
      requests += 1;
      if (requests === 1) return response(model, "", "overloaded_error");
      retryStarted.release();
      await finishRetry.promise;
      return response(model, "Recovered response");
    });
    const sending = h.driver.sendUserMessage(h.ref, { text: "Retry once" });
    try {
      await retryStarted.promise;
      const pending = await h.driver.openSession(h.ref);
      assert.equal(pending.status, "running");
      assert.equal(pending.runningRunId, h.initialRunId());
      assert.equal(h.completions().length, 0);
      assert.equal(h.failures().length, 0, "a retryable attempt must not announce run failure");
    } finally {
      finishRetry.release();
      await sending;
    }
    await h.until(() => h.completions().length > 0);
    assert.equal(requests, 2);
    assert.deepEqual(
      h.rawEvents.filter((event) => event.type === "agent_end").map((event) => event.willRetry),
      [true, false],
    );
    assert.equal(h.rawEvents.filter((event) => event.type === "agent_settled").length, 1);
    assert.equal(h.completions().length, 1);
    assert.equal(h.completions()[0]?.runId, h.initialRunId());
    assert.equal(h.completions()[0]?.snapshot.preview, "Recovered response");
    assert.equal(h.failures().length, 0);
    const persisted = await assertPersistedAssistantIdentity(h);
    assert.equal(persisted.length, 2, "the failed retry attempt also retains its native identity");
    assert.deepEqual(
      persisted.map((event) => event.runId),
      [h.initialRunId(), h.initialRunId()],
    );
  },
);

await test(
  "an extension turn started after settlement receives a distinct desktop run id",
  { timeout: 15000 },
  async (t) => {
    const secondStarted = gate();
    const finishSecond = gate();
    let requested = false;
    let requests = 0;
    const h = await fixture(
      t,
      async (model) => {
        requests += 1;
        if (requests === 1) return response(model, "Original response");
        secondStarted.release();
        await finishSecond.promise;
        return response(model, "Extension response");
      },
      (pi) => {
        pi.on("agent_settled", () => {
          if (requested) return;
          requested = true;
          pi.sendMessage(
            { customType: "after-settlement", content: "Start a separate turn", display: false },
            { triggerTurn: true },
          );
        });
      },
    );
    const sending = h.driver.sendUserMessage(h.ref, { text: "Start original turn" });
    let extensionRunId: string | undefined;
    try {
      await secondStarted.promise;
      await h.until(() => h.completions().length > 0);
      const pending = await h.driver.openSession(h.ref);
      assert.equal(pending.status, "running");
      extensionRunId = pending.runningRunId;
      assert.ok(extensionRunId, "extension-started turns also need a run id");
      assert.notEqual(extensionRunId, h.initialRunId());
      assert.equal(h.completions().length, 1);
      assert.equal(h.completions()[0]?.runId, h.initialRunId());
    } finally {
      finishSecond.release();
      await sending;
    }
    await h.until(() => h.completions().length === 2);
    assert.equal(requests, 2);
    assert.equal(h.rawEvents.filter((event) => event.type === "agent_settled").length, 2);
    assert.deepEqual(
      h.completions().map((event) => event.runId),
      [h.initialRunId(), extensionRunId],
    );
    assert.deepEqual(
      h.events
        .filter((event) => event.type === "assistantDelta")
        .map((event) => [event.text, event.runId]),
      [
        ["Original response", h.initialRunId()],
        ["Extension response", extensionRunId],
      ],
    );
    assert.equal(h.failures().length, 0);
    const persisted = await assertPersistedAssistantIdentity(h);
    assert.deepEqual(
      persisted.map((event) => event.runId),
      [h.initialRunId(), extensionRunId],
    );
  },
);

await test(
  "releasing an idle session frees its runtime, keeps its listeners, and it reopens from its file; a running one is kept",
  { timeout: 15000 },
  async (t) => {
    const replying = gate();
    const finishReply = gate();
    let requests = 0;
    const h = await fixture(t, async (model) => {
      requests += 1;
      if (requests === 2) {
        replying.release();
        await finishReply.promise;
      }
      return response(model, `Reply ${requests}`);
    });
    await h.driver.sendUserMessage(h.ref, { text: "First" });
    await h.until(() => h.completions().length === 1);
    const before = await h.driver.getTranscript(h.ref);
    const firstRuntime = h.runtime;

    assert.equal(h.driver.releaseSession(h.ref), true);
    assert.equal(h.driver.isSessionLoaded(h.ref), false);
    // Reopening builds a new runtime from the session file, with the same transcript. The
    // listener subscribed before the release still hears the reopened session.
    const reopened = await h.driver.openSession(h.ref);
    assert.equal(reopened.status, "idle");
    assert.equal(h.driver.isSessionLoaded(h.ref), true);
    assert.notEqual(h.runtime, firstRuntime, "the released runtime is not reused");
    assert.deepEqual(await h.driver.getTranscript(h.ref), before);

    // A released session still works.
    const sending = h.driver.sendUserMessage(h.ref, { text: "Second" });
    try {
      await replying.promise;
      assert.equal(h.driver.releaseSession(h.ref), false, "a running session is kept");
      assert.equal((await h.driver.openSession(h.ref)).status, "running");
    } finally {
      finishReply.release();
      await sending;
    }
    await h.until(() => h.completions().length === 2);
    const after = await h.driver.getTranscript(h.ref);
    assert.ok(after.some((item) => item.kind === "message" && item.text === "Reply 2"));
  },
);

await test(
  "a Stop while an extension's before-settle continuation is pending reads as stopped, not completed",
  { timeout: 15000 },
  async (t) => {
    // The pr-review example's pattern: after a normal reply, the extension awaits and then
    // continues the run. pi writes no aborted reply when the user stops during that await.
    const beforeSettle = gate();
    const continueRun = gate();
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, "Review in progress");
      },
      (pi) => {
        pi.on("agent_before_settle", async () => {
          beforeSettle.release();
          await continueRun.promise;
          return {
            entries: [
              {
                type: "custom_message",
                customType: "lifecycle-test",
                content: "Keep reviewing",
                display: false,
              },
            ],
            continue: true,
          };
        });
      },
    );
    const sending = h.driver.sendUserMessage(h.ref, { text: "Review the PR" });
    await beforeSettle.promise;
    const stopping = h.driver.cancelCurrentRun(h.ref);
    continueRun.release();
    await Promise.all([sending, stopping]);
    await h.until(() => h.rawEvents.some((event) => event.type === "agent_settled"));
    assert.equal(requests, 1, "the stopped run is not continued");
    const replies = h.runtime.session.messages.filter((message) => message.role === "assistant");
    assert.deepEqual(
      replies.map((message) => message.stopReason),
      ["stop"],
      "pi adds no aborted reply, so the stop is only known to the driver",
    );
    const snapshot = await h.driver.openSession(h.ref);
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.lastRunOutcome, "stopped");
    await assert.rejects(
      h.driver.archiveSessionIfIdle(h.ref, { lastRunOutcome: "completed" }),
      /last run changed/,
    );
    assert.equal((await h.driver.openSession(h.ref)).archivedAt, undefined);

    // pi's session file holds only the normal reply; after a restart the Stop must still count.
    await h.driver.closeSession(h.ref);
    assert.match(
      await readFile(join(h.root, "catalogs.json"), "utf8"),
      /"stoppedReplies": \{\s*"[^"]+": "[^"]+"/,
    );
    const restarted = h.restartedDriver();
    // The app syncs the workspace at startup, which rebuilds every catalog entry.
    const synced = await restarted.syncWorkspace(h.workspacePath, "Boundary");
    assert.equal(synced.workspace.workspaceId, h.ref.workspaceId);
    assert.ok(
      synced.sessions.find((entry) => entry.sessionRef.sessionId === h.ref.sessionId)
        ?.stoppedReplyId,
      "the sync keeps this session's mark",
    );
    // Archiving and restoring the cold session rewrites its catalog entry; the mark stays.
    await restarted.archiveSession(h.ref);
    await restarted.unarchiveSession(h.ref);
    assert.match(
      await readFile(join(h.root, "catalogs.json"), "utf8"),
      /"stoppedReplies": \{\s*"[^"]+": "[^"]+"/,
    );
    const reopened = await restarted.openSession(h.ref);
    assert.equal(reopened.lastRunOutcome, "stopped");
    await assert.rejects(
      restarted.archiveSessionIfIdle(h.ref, { lastRunOutcome: "completed" }),
      /last run changed/,
    );
    assert.equal((await restarted.openSession(h.ref)).archivedAt, undefined);

    // The next run clears it, in memory and in the catalog.
    await restarted.sendUserMessage(h.ref, { text: "Finish the review" });
    const finished = await restarted.openSession(h.ref);
    assert.equal(finished.status, "idle");
    assert.equal(finished.lastRunOutcome, "completed");
    assert.match(await readFile(join(h.root, "catalogs.json"), "utf8"), /"stoppedReplies": \{\}/);
  },
);

await test(
  "a Stop saved during a workspace sync survives when an extension switches session before the sync writes",
  { timeout: 15000 },
  async (t) => {
    const beforeSettle = gate();
    const continueRun = gate();
    let holdReplace: ReturnType<typeof gate> | undefined;
    let replaceReached!: () => void;
    const replaceStarted = new Promise<void>((resolve) => {
      replaceReached = resolve;
    });
    const h = await fixture(
      t,
      (model) => response(model, "Review in progress"),
      (pi) => {
        pi.registerCommand("fresh-thread", {
          description: "Start a new session from an extension",
          handler: async (_args, ctx) => {
            await ctx.newSession();
          },
        });
        pi.on("agent_before_settle", async () => {
          beforeSettle.release();
          await continueRun.promise;
          return { continue: true };
        });
      },
      (catalog) =>
        Object.assign(Object.create(catalog) as JsonCatalogStore, {
          replaceWorkspaceSessions: async (
            ...args: Parameters<JsonCatalogStore["replaceWorkspaceSessions"]>
          ) => {
            if (holdReplace) {
              replaceReached();
              await holdReplace.promise;
            }
            return catalog.replaceWorkspaceSessions(...args);
          },
        }),
    );
    const sending = h.driver.sendUserMessage(h.ref, { text: "Review the PR" });
    await beforeSettle.promise;
    // The sync builds this session's entry now, before the Stop, and waits to write it.
    holdReplace = gate();
    const syncing = h.driver.syncWorkspace(h.workspacePath, "Boundary");
    await replaceStarted;
    const stopping = h.driver.cancelCurrentRun(h.ref);
    continueRun.release();
    await Promise.all([sending, stopping]);
    // An extension moves the thread to a new session before the sync writes.
    await h.driver.sendUserMessage(h.ref, { text: "/fresh-thread" });
    holdReplace.release();
    await syncing;

    const restarted = h.restartedDriver();
    const reopened = await restarted.openSession(h.ref);
    assert.equal(reopened.lastRunOutcome, "stopped");
    await assert.rejects(restarted.archiveSessionIfIdle(h.ref, { lastRunOutcome: "completed" }));
  },
);

await test(
  "after switching away, a Stop another owner saved for the session refuses the archive on return",
  { timeout: 15000 },
  async (t) => {
    const h = await fixture(
      t,
      (model) => response(model, "Review done"),
      (pi) => {
        pi.registerCommand("fresh-thread", {
          description: "Start a new session from an extension",
          handler: async (_args, ctx) => {
            await ctx.newSession();
          },
        });
      },
    );
    await h.driver.sendUserMessage(h.ref, { text: "Review the PR" });
    await h.until(() => h.completions().length > 0);
    const reply = h.runtime.session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .at(-1);
    assert.ok(reply);
    // An extension moves the thread to a new session; this process no longer holds the first.
    await h.driver.sendUserMessage(h.ref, { text: "/fresh-thread" });
    // Another owner opens the first session, stops a run whose newest reply is that one, saves.
    const otherOwner = new JsonCatalogStore({ catalogFilePath: join(h.root, "catalogs.json") });
    await otherOwner.sessions.setStoppedReplyId(h.ref, reply.id);
    // Back to the first session here: the archive must read the catalog, not a stale copy.
    await h.driver.openSession(h.ref);
    await assert.rejects(
      h.driver.archiveSessionIfIdle(h.ref, { lastRunOutcome: "completed" }),
      /last run changed/,
    );
    assert.equal((await h.driver.openSession(h.ref)).archivedAt, undefined);
  },
);

await test(
  "a Stop while extension agent_settled handlers still run is not archived, then reads as stopped",
  { timeout: 15000 },
  async (t) => {
    const settling = gate();
    const finishSettling = gate();
    const h = await fixture(
      t,
      (model) => response(model, "Review done"),
      (pi) => {
        pi.on("agent_settled", async () => {
          settling.release();
          await finishSettling.promise;
        });
      },
    );
    const sending = h.driver.sendUserMessage(h.ref, { text: "Review the PR" });
    await settling.promise;
    // pi already counts the run as over; the user's Stop ends the visible run.
    await h.driver.cancelCurrentRun(h.ref);
    await assert.rejects(
      h.driver.archiveSessionIfIdle(h.ref, { lastRunOutcome: "completed" }),
      /not archived/,
    );
    finishSettling.release();
    await sending;
    await h.until(() => h.rawEvents.some((event) => event.type === "agent_settled"));
    assert.equal((await h.driver.openSession(h.ref)).lastRunOutcome, "stopped");
    await assert.rejects(
      h.driver.archiveSessionIfIdle(h.ref, { lastRunOutcome: "completed" }),
      /last run changed/,
    );
  },
);
