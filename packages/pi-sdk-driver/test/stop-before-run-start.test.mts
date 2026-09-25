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

/** A fake provider that, like a real one, ends with "aborted" once its signal fires. */
const streamFunction: StreamFunction = (model, _context, options) => {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "FULL ANSWER" }],
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
    if (options?.signal?.aborted) {
      const aborted = { ...message, content: [], stopReason: "aborted" as const };
      stream.push({ type: "start", partial: aborted });
      stream.push({ type: "error", reason: "aborted", error: aborted });
      return;
    }
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: "stop", message });
  }, 20);
  return stream;
};

await test("Stop pressed while Pi is still starting a run cancels that run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-stop-start-"));
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
        "stop-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  // Hold the first prompt in before_agent_start, one of Pi's steps before its run begins.
  let holdNext = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedHold!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedHold = resolve;
  });
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
            (pi) => {
              pi.on("before_agent_start", async () => {
                if (!holdNext) return;
                holdNext = false;
                reachedHold();
                await held;
              });
            },
          ],
        },
      });
      runtime.session.agent.streamFunction = streamFunction;
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "stop-workspace", path: cwd },
    { initialModel: { provider: "stop-test", modelId: "scripted" } },
  );
  const events: SessionDriverEvent[] = [];
  let stopWhenMarkedRunning = false;
  const unsubscribe = driver.subscribe(ref, async (event) => {
    events.push(event);
    if (
      stopWhenMarkedRunning &&
      event.type === "sessionUpdated" &&
      event.snapshot.status === "running"
    ) {
      // The driver awaits listeners, so this Stop lands before it calls session.prompt().
      stopWhenMarkedRunning = false;
      await driver.cancelCurrentRun(ref);
    }
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });
  const assistantReplies = () =>
    runtime.session.messages.flatMap((message) =>
      message.role === "assistant"
        ? [
            [
              message.stopReason,
              message.content.map((part) => ("text" in part ? part.text : "")).join(""),
            ],
          ]
        : [],
    );

  const sent = driver.sendUserMessage(ref, { text: "first" });
  await reached;
  assert.equal(runtime.session.isStreaming, false, "Pi has not started the run yet");
  await driver.cancelCurrentRun(ref);
  release();
  await sent;
  await runtime.session.waitForIdle();

  assert.deepEqual(assistantReplies(), [["aborted", ""]]);

  // The Stop is used up: the next message runs and completes normally.
  await driver.sendUserMessage(ref, { text: "second" });
  await runtime.session.waitForIdle();
  assert.deepEqual(assistantReplies().at(-1), ["stop", "FULL ANSWER"]);
  // Driver events are delivered asynchronously; wait for the second run's completion.
  const deadline = Date.now() + 5_000;
  while (!events.some((event) => event.type === "runCompleted") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    events.filter((event) => event.type === "runCompleted").length,
    1,
    "only the second, unstopped run reports completion",
  );

  // Stop while the driver is still saving the running state, before it hands the prompt to Pi.
  stopWhenMarkedRunning = true;
  await driver.sendUserMessage(ref, { text: "third" });
  await runtime.session.waitForIdle();
  assert.equal(stopWhenMarkedRunning, false, "Stop was pressed");
  assert.deepEqual(assistantReplies().at(-1), ["aborted", ""]);
});
