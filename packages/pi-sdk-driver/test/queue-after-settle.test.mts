import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
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

await test("a message queued after pi settled, before the app heard, starts the next turn", async (t) => {
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
      runtime = await createAgentSessionRuntimeWithNpmFallback({ ...runtimeOptions, tools: [] });
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
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  const events: SessionDriverEvent[] = [];
  let lastSnapshot: Extract<SessionDriverEvent, { type: "sessionUpdated" }>["snapshot"] | undefined;
  const unsubscribe = driver.subscribe(ref, async (event) => {
    events.push(event);
    if (event.type === "sessionUpdated") lastSnapshot = event.snapshot;
    if (holding && event.type === "runCompleted") await held;
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });

  await driver.sendUserMessage(ref, { text: "first" });
  assert.equal(runtime.session.isStreaming, false, "pi has settled");
  assert.equal(lastSnapshot?.status, "running", "the app has not heard yet");

  const now = new Date().toISOString();
  const queued = driver.replaceQueuedMessages(ref, [
    { id: "again", mode: "followUp", text: "Again.", createdAt: now, updatedAt: now },
  ]);
  setTimeout(() => {
    holding = false;
    release();
  }, 50);
  await queued;
  await runtime.session.waitForIdle();

  assert.deepEqual(
    runtime.session.messages.flatMap((message) =>
      message.role === "user" || message.role === "assistant" ? [message.role] : [],
    ),
    ["user", "assistant", "user", "assistant"],
    "pi ran a second turn for the queued message",
  );

  const deadline = Date.now() + 5_000;
  while (
    events.filter((event) => event.type === "runCompleted").length < 2 &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const order = events.flatMap((event) =>
    event.type === "runCompleted" || event.type === "queuedMessageStarted" ? [event.type] : [],
  );
  // The first run's completion reaches the app before the message starts the next turn, which
  // shows it in the transcript like any queued message.
  assert.deepEqual(order, ["runCompleted", "queuedMessageStarted", "runCompleted"]);
  const started = events.find((event) => event.type === "queuedMessageStarted");
  assert.equal(started?.type === "queuedMessageStarted" && started.message.text, "Again.");
  assert.deepEqual(lastSnapshot?.queuedMessages ?? [], []);
  assert.equal(lastSnapshot?.status, "idle");
});
