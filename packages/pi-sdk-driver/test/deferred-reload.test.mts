import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

await test("a reload asked for during a turn waits for the turn to end", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-deferred-reload-"));
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
        "reload-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  // The model answers only when the test says so, so the turn is running meanwhile.
  let finishTurn!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  let streaming = false;
  const streamFunction: StreamFunction = (model) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "DONE" }],
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
    streaming = true;
    stream.push({ type: "start", partial: { ...message, content: [] } });
    turnFinished
      .then(() => stream.push({ type: "done", reason: "stop", message }))
      .catch(() => undefined);
    return stream;
  };

  let loads = 0;
  let runtime!: AgentSessionRuntime;
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    builtinExtensions: [
      {
        name: "pi-gui-load-counter",
        displayName: "Load counter",
        factory: () => {
          loads += 1;
        },
      },
    ],
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({ ...runtimeOptions, tools: [] });
      runtime.session.agent.streamFunction = streamFunction;
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "reload-workspace", path: cwd },
    { initialModel: { provider: "reload-test", modelId: "scripted" } },
  );
  t.after(() => driver.closeSession(ref));
  const loadsAtStart = loads;

  const sent = driver.sendUserMessage(ref, { text: "hello" });
  await waitFor(() => streaming, "the turn to start streaming");
  assert.equal(await driver.reloadSessionWhenIdle(ref), "deferred");
  assert.equal(loads, loadsAtStart, "a running turn keeps its extensions");

  finishTurn();
  await sent;
  await runtime.session.waitForIdle();
  await waitFor(() => loads === loadsAtStart + 1, "the deferred reload after the turn");

  assert.equal(await driver.reloadSessionWhenIdle(ref), "reloaded");
  assert.equal(loads, loadsAtStart + 2, "an idle session reloads right away");
});
