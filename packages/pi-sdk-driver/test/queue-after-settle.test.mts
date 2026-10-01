import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

const streamFunction: StreamFunction = (model) => {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ANSWER" }],
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
  setTimeout(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: "stop", message });
  }, 10);
  return stream;
};

async function setUp(t: TestContext, extensionFactories: ExtensionFactory[] = []) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-queue-settle-"));
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
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("This test must never use the network");
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "queue-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  let runtime!: AgentSessionRuntime;
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...runtimeOptions,
        tools: [],
        resourceLoaderOptions: {
          ...runtimeOptions.resourceLoaderOptions,
          extensionFactories: [
            ...(runtimeOptions.resourceLoaderOptions?.extensionFactories ?? []),
            ...extensionFactories,
          ],
        },
      });
      runtime.session.agent.streamFunction = streamFunction;
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "queue-workspace", path: cwd },
    { initialModel: { provider: "queue-test", modelId: "scripted" } },
  );

  // The driver awaits listeners, so holding the first run's completion holds every event after
  // it: the app still sees that run as running, as it does when its events lag behind pi.
  let holdCompletion = false;
  let releaseCompletion!: () => void;
  const completionHeld = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const events: SessionDriverEvent[] = [];
  let lastSnapshot: Extract<SessionDriverEvent, { type: "sessionUpdated" }>["snapshot"] | undefined;
  const unsubscribe = driver.subscribe(ref, async (event) => {
    events.push(event);
    if (event.type === "sessionUpdated") lastSnapshot = event.snapshot;
    if (holdCompletion && event.type === "runCompleted") await completionHeld;
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });

  const count = (type: SessionDriverEvent["type"]) =>
    events.filter((event) => event.type === type).length;
  return {
    driver,
    ref,
    runtime: () => runtime,
    events,
    lastSnapshot: () => lastSnapshot,
    holdCompletion: () => {
      holdCompletion = true;
    },
    releaseCompletion: () => {
      holdCompletion = false;
      releaseCompletion();
    },
    queue: (...texts: string[]) => {
      const now = new Date().toISOString();
      return driver.replaceQueuedMessages(
        ref,
        texts.map((text) => ({
          id: text,
          mode: "followUp" as const,
          text,
          createdAt: now,
          updatedAt: now,
        })),
      );
    },
    async waitForRuns(runs: number) {
      const deadline = Date.now() + 5_000;
      while (count("runCompleted") < runs && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await runtime.session.waitForIdle();
      // Anything still on its way would show here.
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    turns: () =>
      runtime.session.messages.flatMap((message) =>
        message.role === "user"
          ? [
              typeof message.content === "string"
                ? message.content
                : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
            ]
          : message.role === "assistant"
            ? ["-"]
            : [],
      ),
    started: () =>
      events.flatMap((event) =>
        event.type === "queuedMessageStarted" ? [event.message.text] : [],
      ),
    count,
  };
}

await test("a message queued after pi settled, before the app heard, starts the next turn", async (t) => {
  const app = await setUp(t);
  app.holdCompletion();
  await app.driver.sendUserMessage(app.ref, { text: "first" });
  assert.equal(app.runtime().session.isStreaming, false, "pi has settled");
  assert.equal(app.lastSnapshot()?.status, "running", "the app has not heard yet");

  await app.queue("Again.");
  setTimeout(app.releaseCompletion, 50);
  await app.waitForRuns(2);

  assert.deepEqual(app.turns(), ["first", "-", "Again.", "-"]);
  const order = app.events.flatMap((event) =>
    event.type === "runCompleted" || event.type === "queuedMessageStarted" ? [event.type] : [],
  );
  // The first run's completion reaches the app before the message starts the next turn, which
  // shows it in the transcript like any queued message.
  assert.deepEqual(order, ["runCompleted", "queuedMessageStarted", "runCompleted"]);
  assert.deepEqual(app.started(), ["Again."]);
  assert.deepEqual(app.lastSnapshot()?.queuedMessages ?? [], []);
  assert.equal(app.lastSnapshot()?.status, "idle");
  assert.equal(app.count("runFailed"), 0);
});

await test("a message queued while pi's settle hooks run starts the next turn", async (t) => {
  // pi stops streaming before it runs extensions' agent_settled handlers (pi-gui's own turn
  // capture is one) and tells the driver only after them, so the driver still counts the run.
  let holdSettle = false;
  let releaseSettle!: () => void;
  const settleHeld = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });
  let reachedSettle!: () => void;
  const settleReached = new Promise<void>((resolve) => {
    reachedSettle = resolve;
  });
  const app = await setUp(t, [
    (pi) => {
      pi.on("agent_settled", async () => {
        if (!holdSettle) return;
        holdSettle = false;
        reachedSettle();
        await settleHeld;
      });
    },
  ]);
  holdSettle = true;
  const sent = app.driver.sendUserMessage(app.ref, { text: "first" });
  await settleReached;
  assert.equal(app.runtime().session.isStreaming, false, "pi has stopped streaming");

  await app.queue("Again.");
  releaseSettle();
  await sent;
  await app.waitForRuns(2);

  assert.deepEqual(app.turns(), ["first", "-", "Again.", "-"]);
  assert.deepEqual(app.started(), ["Again."]);
  assert.deepEqual(app.lastSnapshot()?.queuedMessages ?? [], []);
});

await test("queue changes in that gap start one turn, then deliver the rest in order", async (t) => {
  const app = await setUp(t);
  app.holdCompletion();
  await app.driver.sendUserMessage(app.ref, { text: "first" });

  // A second send while the first is still on its way: the store passes the whole queue each time.
  await Promise.all([app.queue("A"), app.queue("A", "B")]);
  setTimeout(app.releaseCompletion, 50);
  await app.waitForRuns(2);

  assert.deepEqual(app.turns(), ["first", "-", "A", "-", "B", "-"]);
  assert.deepEqual(app.started(), ["A", "B"]);
  assert.equal(app.count("runFailed"), 0);
  assert.deepEqual(app.lastSnapshot()?.queuedMessages ?? [], []);
});

await test("a queued message that fails to start goes back on the queue until the next change", async (t) => {
  const app = await setUp(t);
  app.holdCompletion();
  await app.driver.sendUserMessage(app.ref, { text: "first" });

  // pi refuses the prompt before any run starts, as with a missing sign-in.
  const session = app.runtime().session;
  const prompt = session.prompt.bind(session);
  session.prompt = () => Promise.reject(new Error("No API key"));
  await app.queue("A", "B");
  setTimeout(app.releaseCompletion, 50);
  const deadline = Date.now() + 5_000;
  while (app.count("runFailed") === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(app.count("runFailed"), 1, "it is not retried on its own");
  assert.deepEqual(
    (app.lastSnapshot()?.queuedMessages ?? []).map((message) => message.text),
    ["A", "B"],
  );
  assert.equal(session.pendingMessageCount, 2);
  assert.deepEqual(app.turns(), ["first", "-"]);

  session.prompt = prompt;
  await app.queue("A", "B");
  await app.waitForRuns(2);
  assert.deepEqual(app.turns(), ["first", "-", "A", "-", "B", "-"]);
  assert.deepEqual(app.lastSnapshot()?.queuedMessages ?? [], []);
});

await test("a queue change from a list that still shows the started message does not resend it", async (t) => {
  const app = await setUp(t);
  app.holdCompletion();
  await app.driver.sendUserMessage(app.ref, { text: "first" });
  await app.queue("A");
  setTimeout(app.releaseCompletion, 50);
  const deadline = Date.now() + 5_000;
  while (!app.started().includes("A") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // The app has not caught up with A starting, so its list still holds it.
  await app.queue("A", "B");
  await app.waitForRuns(3);

  assert.deepEqual(app.turns(), ["first", "-", "A", "-", "B", "-"]);
  assert.deepEqual(app.started(), ["A", "B"]);
});
