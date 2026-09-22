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
import { PiSdkDriver, type PiSdkDriverConfig } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];
type CaptureHandler = NonNullable<PiSdkDriverConfig["onTurnCaptureBoundary"]>;
type Boundary = Parameters<CaptureHandler>[0];
type ObservedBoundary = { event: Boundary; content: string | null; signal: AbortSignal };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function response(
  model: Parameters<StreamFunction>[0],
  options: { text?: string; write?: string; error?: string; aborted?: boolean } = {},
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content:
      options.write !== undefined
        ? [
            {
              type: "toolCall",
              id: `write-${options.write}`,
              name: "write",
              arguments: { path: "result.txt", content: options.write },
            },
          ]
        : [{ type: "text", text: options.text ?? "Done" }],
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
    stopReason: options.aborted
      ? "aborted"
      : options.error
        ? "error"
        : options.write !== undefined
          ? "toolUse"
          : "stop",
    ...(options.error ? { errorMessage: options.error } : {}),
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  if (options.write === undefined && !options.error && !options.aborted) {
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: options.text ?? "Done",
      partial: message,
    });
  }
  if (options.error || options.aborted) {
    stream.push({ type: "error", reason: options.aborted ? "aborted" : "error", error: message });
  } else {
    stream.push({
      type: "done",
      reason: options.write !== undefined ? "toolUse" : "stop",
      message,
    });
  }
  return stream;
}

/** Real installed Pi, persisted session entries, and its real write tool; only the provider is fake. */
async function fixture(
  t: TestContext,
  streamFunction: StreamFunction,
  options: {
    extension?: ExtensionFactory;
    capture?: CaptureHandler;
    driver?: Partial<PiSdkDriverConfig>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-turn-capture-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Turn capture tests must never use the network");
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
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
        "capture-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  const boundaries: ObservedBoundary[] = [];
  const rawEvents: AgentSessionEvent[] = [];
  const events: SessionDriverEvent[] = [];
  const changed = new Set<() => void>();
  const pulse = () => {
    for (const listener of changed) listener();
  };
  let runtime!: AgentSessionRuntime;
  const fileContent = async () => {
    try {
      return await readFile(join(cwd, "result.txt"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const driver = new PiSdkDriver({
    ...options.driver,
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    onTurnCaptureBoundary: async (event, signal) => {
      boundaries.push({ event: structuredClone(event), signal, content: await fileContent() });
      pulse();
      await options.capture?.(event, signal);
    },
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...runtimeOptions,
        tools: ["write"],
        resourceLoaderOptions: {
          ...runtimeOptions.resourceLoaderOptions,
          extensionFactories: [
            ...(runtimeOptions.resourceLoaderOptions?.extensionFactories ?? []),
            ...(options.extension ? [options.extension] : []),
          ],
        },
      });
      runtime.session.agent.streamFunction = streamFunction;
      runtime.session.subscribe((event) => {
        rawEvents.push(event);
        pulse();
      });
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "capture-workspace", path: cwd },
    { initialModel: { provider: "capture-test", modelId: "scripted" } },
  );
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
    pulse();
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });

  const until = (predicate: () => boolean) => {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!predicate()) return;
        changed.delete(check);
        resolve();
      };
      changed.add(check);
    });
  };
  return {
    driver,
    ref,
    runtime,
    boundaries,
    rawEvents,
    events,
    until,
    fileContent,
    openings: () => boundaries.filter(({ event }) => event.opening),
    closings: () => boundaries.filter(({ event }) => event.closing),
    completed: () => events.filter((event) => event.type === "runCompleted"),
    failed: () => events.filter((event) => event.type === "runFailed"),
    send: (text = "Start") => driver.sendUserMessage(ref, { text }),
  };
}

function assertAnchors(h: Awaited<ReturnType<typeof fixture>>) {
  const entries = new Map(
    h.runtime.session.sessionManager.getBranch().map((entry) => [entry.id, entry]),
  );
  for (const { event } of h.closings()) {
    assert.deepEqual(event.sessionRef, h.ref);
    assert.ok(event.runId);
    assert.ok(event.runtimeGeneration);
    assert.ok(event.closing!.assistantEntryIds.length > 0);
    for (const id of event.closing!.assistantEntryIds) {
      const entry = entries.get(id);
      assert.equal(entry?.type, "message");
      if (entry?.type === "message") assert.equal(entry.message.role, "assistant");
    }
    for (const id of event.closing!.userEntryIds) {
      const entry = entries.get(id);
      assert.equal(entry?.type, "message");
      if (entry?.type === "message") assert.equal(entry.message.role, "user");
    }
  }
}

function assertSuccessfulWrites(h: Awaited<ReturnType<typeof fixture>>, expected: number) {
  const writes = h.rawEvents.filter(
    (event) => event.type === "tool_execution_end" && event.toolName === "write",
  );
  assert.equal(writes.length, expected, "Pi must execute every scripted write tool call");
  for (const event of writes) {
    if (event.type === "tool_execution_end") {
      assert.equal(event.isError, false, JSON.stringify(event.result));
    }
  }
}

async function assertPersistedCaptureIdentity(h: Awaited<ReturnType<typeof fixture>>) {
  const nativeAssistants = h.runtime.session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant");
  const persisted = () => h.events.filter((event) => event.type === "assistantMessagePersisted");
  await h.until(() => persisted().length === nativeAssistants.length);
  const nativeIds = nativeAssistants.map((entry) => entry.id);
  assert.deepEqual(
    persisted().map((event) => event.sourceMessageId),
    nativeIds,
  );
  assert.deepEqual(
    h.closings().flatMap(({ event }) => event.closing!.assistantEntryIds),
    nativeIds,
    "response review events and captured intervals share the exact raw Pi assistant anchors",
  );
  assert.deepEqual(
    h.events
      .filter(
        (event) =>
          event.type === "assistantMessageEnded" || event.type === "assistantMessagePersisted",
      )
      .map((event) => event.type),
    nativeIds.flatMap(() => ["assistantMessageEnded", "assistantMessagePersisted"]),
  );
  const transcript = await h.driver.getTranscript(h.ref);
  const visibleAssistantIds = transcript
    .filter((item) => item.kind === "message" && item.role === "assistant")
    .map((item) => {
      assert.equal(
        item.sourceMessageId,
        item.id,
        "hydrated review actions retain the native source ID",
      );
      return item.id;
    });
  for (const entry of nativeAssistants) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const hasText = entry.message.content.some(
      (part) => part.type === "text" && part.text.length > 0,
    );
    assert.equal(
      visibleAssistantIds.includes(entry.id),
      hasText,
      "tool-only assistant identities must not create a visible text response",
    );
  }
}

await test(
  "opening capture is awaited before the provider or real write tool can change files",
  { timeout: 15000 },
  async (t) => {
    const entered = gate();
    const release = gate();
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, requests === 1 ? { write: "changed" } : {});
      },
      {
        capture: async (event) => {
          if (!event.opening) return;
          entered.release();
          await release.promise;
        },
      },
    );
    const sending = h.send();
    try {
      await entered.promise;
      await nextEventLoopTurn();
      assert.equal(requests, 0);
      assert.equal(await h.fileContent(), null);
      assert.equal(
        h.rawEvents.some((event) => event.type === "tool_execution_start"),
        false,
      );
    } finally {
      release.release();
      await sending;
    }
    assertSuccessfulWrites(h, 1);
    assert.deepEqual(
      h.boundaries.map(({ content }) => content),
      [null, "changed"],
    );
    assert.equal(h.openings().length, 1);
    assert.equal(h.closings().length, 1);
    assert.equal(
      h.openings()[0]!.event.opening!.checkpointId,
      h.closings()[0]!.event.closing!.checkpointId,
    );
    assert.equal(h.closings()[0]!.event.closing!.outcome, "completed");
    assertAnchors(h);
    await assertPersistedCaptureIdentity(h);
  },
);

await test(
  "consumed steering and follow-up each split at the actual file boundary",
  { timeout: 15000 },
  async (t) => {
    const firstRequest = gate();
    const releaseFirst = gate();
    let requests = 0;
    const h = await fixture(t, async (model) => {
      requests += 1;
      if (requests === 1) {
        firstRequest.release();
        await releaseFirst.promise;
        return response(model, { write: "initial" });
      }
      if (requests === 2) return response(model, { write: "steered" });
      if (requests === 4) return response(model, { write: "followed" });
      return response(model);
    });
    const sending = h.send("Initial input");
    try {
      await firstRequest.promise;
      await h.driver.sendUserMessage(h.ref, { text: "Steering input", deliverAs: "steer" });
      await h.driver.sendUserMessage(h.ref, { text: "Follow-up input", deliverAs: "followUp" });
      assert.equal(h.boundaries.length, 1, "queueing alone is not a capture boundary");
    } finally {
      releaseFirst.release();
      await sending;
    }
    assert.equal(requests, 5);
    assertSuccessfulWrites(h, 3);
    assert.deepEqual(
      h.boundaries.map(({ content }) => content),
      [null, "initial", "steered", "followed"],
    );
    assert.deepEqual(
      h.closings().map(({ event }) => event.closing!.reason),
      ["next-input", "next-input", "settled"],
    );
    assert.deepEqual(
      h.closings().map(({ event }) => event.closing!.userEntryIds.length),
      [1, 1, 1],
    );
    assert.equal(new Set(h.openings().map(({ event }) => event.opening!.checkpointId)).size, 3);
    assert.equal(new Set(h.boundaries.map(({ event }) => event.runId)).size, 1);
    assertAnchors(h);
    await assertPersistedCaptureIdentity(h);
  },
);

await test(
  "consecutive users before an assistant response coalesce into one interval",
  { timeout: 15000 },
  async (t) => {
    const openingEntered = gate();
    const releaseOpening = gate();
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, requests === 1 ? { write: "one-batch" } : {});
      },
      {
        capture: async (event) => {
          if (!event.opening) return;
          openingEntered.release();
          await releaseOpening.promise;
        },
      },
    );
    h.runtime.session.setSteeringMode("all");
    const sending = h.send("Initial input");
    try {
      await openingEntered.promise;
      await h.driver.sendUserMessage(h.ref, { text: "Additional input A", deliverAs: "steer" });
      await h.driver.sendUserMessage(h.ref, { text: "Additional input B", deliverAs: "steer" });
    } finally {
      releaseOpening.release();
      await sending;
    }
    assert.equal(requests, 2);
    assertSuccessfulWrites(h, 1);
    assert.equal(h.openings().length, 1);
    assert.equal(h.closings().length, 1);
    assert.equal(h.closings()[0]!.event.closing!.userEntryIds.length, 3);
    assertAnchors(h);
  },
);

await test(
  "retry and before-settle continuation retain the initial baseline and all assistant anchors",
  { timeout: 15000 },
  async (t) => {
    let requests = 0;
    let continued = false;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        if (requests === 1) return response(model, { error: "overloaded_error" });
        if (requests === 2) return response(model, { write: "recovered" });
        if (requests === 4) return response(model, { write: "continued" });
        return response(model);
      },
      {
        extension: (pi) => {
          pi.on("agent_before_settle", () => {
            if (continued) return;
            continued = true;
            return {
              entries: [
                {
                  type: "custom_message",
                  customType: "capture-continuation",
                  content: "Continue",
                  display: false,
                },
              ],
              continue: true,
            };
          });
        },
      },
    );
    await h.send();
    assert.equal(requests, 5);
    assertSuccessfulWrites(h, 2);
    assert.equal(h.rawEvents.filter((event) => event.type === "agent_start").length, 3);
    assert.deepEqual(
      h.boundaries.map(({ content }) => content),
      [null, "continued"],
    );
    assert.equal(h.closings()[0]!.event.closing!.assistantEntryIds.length, 5);
    assert.equal(h.closings()[0]!.event.closing!.outcome, "completed");
    assert.equal(new Set(h.boundaries.map(({ event }) => event.runId)).size, 1);
    assertAnchors(h);
    await assertPersistedCaptureIdentity(h);
  },
);

await test(
  "Stop after a partial file edit closes the interval as stopped",
  { timeout: 15000 },
  async (t) => {
    const waitingForStop = gate();
    let requests = 0;
    const h = await fixture(t, async (model, _context, options) => {
      requests += 1;
      if (requests === 1) return response(model, { write: "partial" });
      waitingForStop.release();
      if (!options?.signal?.aborted) {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return response(model, { aborted: true });
    });
    const sending = h.send();
    await waitingForStop.promise;
    await h.driver.cancelCurrentRun(h.ref);
    await sending;
    assertSuccessfulWrites(h, 1);
    assert.deepEqual(
      h.boundaries.map(({ content }) => content),
      [null, "partial"],
    );
    assert.equal(h.closings()[0]!.event.closing!.outcome, "stopped");
    assert.equal(h.closings()[0]!.event.closing!.reason, "settled");
    assertAnchors(h);
  },
);

await test(
  "extension abort in before-settle is stopped without an aborted assistant message",
  { timeout: 15000 },
  async (t) => {
    const h = await fixture(t, (model) => response(model), {
      extension: (pi) => {
        pi.on("agent_before_settle", (_event, ctx) => {
          ctx.abort();
        });
      },
    });
    await h.send();
    assert.equal(
      h.rawEvents.some(
        (event) => event.type === "turn_end" && event.message.stopReason === "aborted",
      ),
      false,
    );
    assert.equal(h.closings().length, 1);
    assert.equal(h.closings()[0]!.event.closing!.outcome, "stopped");
    assertAnchors(h);
  },
);

await test(
  "an extension abort while idle does not cancel its next custom-started activity",
  { timeout: 15000 },
  async (t) => {
    const h = await fixture(t, (model) => response(model), {
      extension: (pi) => {
        pi.registerCommand("abort-idle", {
          description: "Exercise an extension abort when no activity is running",
          handler: (_args, ctx) => {
            ctx.abort();
          },
        });
        pi.registerCommand("custom-run", {
          description: "Start an independent activity after the idle abort",
          handler: () => {
            pi.sendMessage(
              { customType: "capture-test", content: "Custom input", display: false },
              { triggerTurn: true },
            );
          },
        });
      },
    });
    await h.send("/abort-idle");
    await h.send("/custom-run");
    await h.until(() => h.rawEvents.some((event) => event.type === "agent_settled"));
    assert.equal(h.closings().length, 1);
    assert.equal(h.closings()[0]!.event.closing!.outcome, "completed");
    assertAnchors(h);
  },
);

await test(
  "closing a session during before-settle captures interruption after a successful assistant turn",
  { timeout: 15000 },
  async (t) => {
    const beforeSettle = gate();
    const releaseSettlement = gate();
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, requests === 1 ? { write: "before-close" } : {});
      },
      {
        extension: (pi) => {
          pi.on("agent_before_settle", async () => {
            beforeSettle.release();
            await releaseSettlement.promise;
          });
        },
      },
    );
    const sending = h.send();
    let closing = Promise.resolve();
    try {
      await beforeSettle.promise;
      closing = h.driver.closeSession(h.ref);
      await nextEventLoopTurn();
      assert.equal(h.closings().length, 0, "closing must await the in-flight settlement hook");
    } finally {
      releaseSettlement.release();
      await Promise.all([sending, closing]);
    }
    assertSuccessfulWrites(h, 1);
    assert.equal(
      h.rawEvents.some(
        (event) => event.type === "turn_end" && event.message.stopReason === "aborted",
      ),
      false,
    );
    assert.equal(h.closings().length, 1);
    assert.equal(h.closings()[0]!.event.closing!.outcome, "interrupted");
    assert.equal(h.closings()[0]!.content, "before-close");
    assertAnchors(h);
  },
);

await test(
  "custom extension starts and settled-triggered user prompts get distinct captured activities",
  { timeout: 15000 },
  async (t) => {
    let startedFollowUp = false;
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, { text: `Response ${requests}` });
      },
      {
        extension: (pi) => {
          pi.registerCommand("custom-run", {
            description: "Start through Pi's custom-message API",
            handler: () => {
              pi.sendMessage(
                { customType: "capture-test", content: "Custom input", display: false },
                { triggerTurn: true },
              );
            },
          });
          pi.on("agent_settled", () => {
            if (startedFollowUp) return;
            startedFollowUp = true;
            pi.sendUserMessage("Fresh activity after settlement");
          });
        },
      },
    );
    await h.send("/custom-run");
    await h.until(() => h.completed().length === 2);
    assert.equal(requests, 2);
    assert.deepEqual(
      h.boundaries.map(({ event }) => [Boolean(event.opening), Boolean(event.closing)]),
      [
        [true, false],
        [false, true],
        [true, false],
        [false, true],
      ],
    );
    assert.equal(new Set(h.boundaries.map(({ event }) => event.runId)).size, 2);
    assert.deepEqual(
      h.closings().map(({ event }) => event.closing!.userEntryIds.length),
      [0, 1],
    );
    assertAnchors(h);
  },
);

await test(
  "reloading the same Pi session creates a fresh runtime generation and checkpoint",
  { timeout: 15000 },
  async (t) => {
    const h = await fixture(t, (model) => response(model));
    await h.send("Before reload");
    await h.driver.reloadSession(h.ref);
    await h.send("After reload");
    const openings = h.openings().map(({ event }) => event);
    const closings = h.closings().map(({ event }) => event);
    assert.equal(openings.length, 2);
    assert.equal(closings.length, 2);
    assert.notEqual(openings[0]!.opening!.checkpointId, openings[1]!.opening!.checkpointId);
    assert.notEqual(openings[0]!.runtimeGeneration, openings[1]!.runtimeGeneration);
    for (let index = 0; index < 2; index += 1) {
      assert.deepEqual(openings[index]!.sessionRef, h.ref);
      assert.deepEqual(closings[index]!.sessionRef, h.ref);
      assert.equal(openings[index]!.runtimeGeneration, closings[index]!.runtimeGeneration);
      assert.equal(openings[index]!.opening!.checkpointId, closings[index]!.closing!.checkpointId);
    }
    assertAnchors(h);
  },
);

await test(
  "capture callback rejection does not block coding or reuse the failed activity",
  { timeout: 15000 },
  async (t) => {
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, requests % 2 === 1 ? { write: `write-${requests}` } : {});
      },
      {
        capture: async () => {
          throw new Error("Capture storage unavailable");
        },
      },
    );
    await h.send("First activity");
    await h.send("Second activity");
    await h.until(() => h.completed().length === 2);
    assertSuccessfulWrites(h, 2);
    assert.equal(await h.fileContent(), "write-3");
    assert.equal(h.openings().length, 2);
    assert.equal(h.closings().length, 2);
    assert.equal(new Set(h.openings().map(({ event }) => event.opening!.checkpointId)).size, 2);
    assert.deepEqual(
      h.closings().map(({ event }) => event.closing!.captureError),
      ["Capture storage unavailable", "Capture storage unavailable"],
      "failed baselines must remain explicitly unavailable when their intervals close",
    );
    assert.equal(h.failed().length, 0, "checkpoint failure must not claim the coding run failed");
    assertAnchors(h);
  },
);

await test(
  "capture deadline aborts its observer and records the missing baseline while coding proceeds",
  { timeout: 15000 },
  async (t) => {
    const observerAborted = gate();
    const lateObserver = gate();
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, requests === 1 ? { write: "after-timeout" } : {});
      },
      {
        driver: { turnCaptureTimeoutMs: 30 },
        capture: async (event, signal) => {
          if (!event.opening) return;
          if (signal.aborted) observerAborted.release();
          else signal.addEventListener("abort", () => observerAborted.release(), { once: true });
          await lateObserver.promise;
        },
      },
    );
    try {
      await h.send();
      await observerAborted.promise;
      assertSuccessfulWrites(h, 1);
      assert.equal(h.openings()[0]!.signal.aborted, true);
      assert.equal(await h.fileContent(), "after-timeout");
      assert.equal(h.closings().length, 1);
      assert.match(h.closings()[0]!.event.closing!.captureError ?? "", /timed out/i);
      assert.equal(h.closings()[0]!.event.closing!.outcome, "completed");
      assert.equal(h.failed().length, 0);
      assertAnchors(h);
    } finally {
      lateObserver.release();
    }
  },
);
