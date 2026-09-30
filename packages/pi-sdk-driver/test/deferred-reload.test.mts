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

/** Lets a little time pass, to show that something did not happen. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function assistantMessage(
  model: Parameters<StreamFunction>[0],
  stopReason: "stop" | "aborted",
): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text: "DONE" }] : [],
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
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * A driver with one session on a scripted model that answers only when the test opens the
 * current turn's gate, and a builtin extension that counts how often it is loaded.
 */
async function startHarness(t: test.TestContext) {
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

  const state = {
    loads: 0,
    turnGate: gate(),
    streaming: false,
    /** Extension loads counted when the model was last called. */
    loadsAtLastTurn: -1,
  };
  const streamFunction: StreamFunction = (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    state.streaming = true;
    state.loadsAtLastTurn = state.loads;
    stream.push({ type: "start", partial: { ...assistantMessage(model, "stop"), content: [] } });
    const finish = (message: AssistantMessage) => {
      state.streaming = false;
      if (message.stopReason === "aborted") {
        stream.push({ type: "error", reason: "aborted", error: message });
      } else {
        stream.push({ type: "done", reason: "stop", message });
      }
    };
    options?.signal?.addEventListener("abort", () => finish(assistantMessage(model, "aborted")));
    state.turnGate.wait.then(() => finish(assistantMessage(model, "stop"))).catch(() => undefined);
    return stream;
  };

  let runtime!: AgentSessionRuntime;
  const commandGate = { current: gate() };
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    builtinExtensions: [
      {
        name: "pi-gui-load-counter",
        displayName: "Load counter",
        factory: (pi) => {
          state.loads += 1;
          pi.registerCommand("hold", {
            description: "Waits until the test lets it finish",
            handler: async () => {
              await commandGate.current.wait;
            },
          });
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
  return { driver, ref, state, commandGate, session: () => runtime.session };
}

await test("a reload asked for during a turn waits for the turn to end", async (t) => {
  const { driver, ref, state, session } = await startHarness(t);
  const loadsAtStart = state.loads;

  const sent = driver.sendUserMessage(ref, { text: "hello" });
  await waitFor(() => state.streaming, "the turn to start streaming");
  assert.equal(await driver.reloadSessionWhenIdle(ref), "deferred");
  assert.equal(state.loads, loadsAtStart, "a running turn keeps its extensions");

  state.turnGate.open();
  await sent;
  await session().waitForIdle();
  await waitFor(() => state.loads === loadsAtStart + 1, "the deferred reload after the turn");

  assert.equal(await driver.reloadSessionWhenIdle(ref), "reloaded");
  assert.equal(state.loads, loadsAtStart + 2, "an idle session reloads right away");
});

await test("a deferred reload runs once when Stop ends the turn", async (t) => {
  const { driver, ref, state, session } = await startHarness(t);
  const loadsAtStart = state.loads;

  const sent = driver.sendUserMessage(ref, { text: "hello" });
  await waitFor(() => state.streaming, "the turn to start streaming");
  assert.equal(await driver.reloadSessionWhenIdle(ref), "deferred");

  // Stop and pi's own end of the turn both ask for the pending reload.
  await driver.cancelCurrentRun(ref);
  await sent.catch(() => undefined);
  await session().waitForIdle();
  await waitFor(() => state.loads === loadsAtStart + 1, "the deferred reload after Stop");
  await settle();
  assert.equal(state.loads, loadsAtStart + 1, "the reload runs once, not once per request");
});
