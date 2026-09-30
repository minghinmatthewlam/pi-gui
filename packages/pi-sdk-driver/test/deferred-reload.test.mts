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
    commandRunning: false,
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
  /** When set, loading the extension waits on it, so a reload stays in flight. */
  const loadGate: { current: ReturnType<typeof gate> | undefined } = { current: undefined };
  /** Wraps the next session.prompt() call, to hold it or fail it. */
  const promptHook: { current: ((prompt: () => Promise<void>) => Promise<void>) | undefined } = {
    current: undefined,
  };
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    builtinExtensions: [
      {
        name: "pi-gui-load-counter",
        displayName: "Load counter",
        factory: async (pi) => {
          state.loads += 1;
          await loadGate.current?.wait;
          pi.registerCommand("hold", {
            description: "Waits until the test lets it finish",
            handler: async () => {
              state.commandRunning = true;
              await commandGate.current.wait;
              state.commandRunning = false;
            },
          });
        },
      },
    ],
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({ ...runtimeOptions, tools: [] });
      runtime.session.agent.streamFunction = streamFunction;
      const prompt = runtime.session.prompt.bind(runtime.session);
      runtime.session.prompt = async (...args) => {
        const around = promptHook.current;
        promptHook.current = undefined;
        return around ? around(() => prompt(...args)) : prompt(...args);
      };
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "reload-workspace", path: cwd },
    { initialModel: { provider: "reload-test", modelId: "scripted" } },
  );
  t.after(() => driver.closeSession(ref));
  return {
    driver,
    ref,
    state,
    commandGate,
    loadGate,
    promptHook,
    session: () => runtime.session,
  };
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

await test("a deferred reload runs when prompt() returns after its events are delivered", async (t) => {
  const { driver, ref, state, promptHook, session } = await startHarness(t);
  const loadsAtStart = state.loads;
  // pi emits agent_settled inside prompt(); holding prompt() open after the turn lets the event
  // queue drain while the send is still starting.
  const returnGate = gate();
  let turnDone = false;
  promptHook.current = async (prompt) => {
    await prompt();
    turnDone = true;
    await returnGate.wait;
  };

  const sent = driver.sendUserMessage(ref, { text: "hello" });
  await waitFor(() => state.streaming, "the turn to start streaming");
  assert.equal(await driver.reloadSessionWhenIdle(ref), "deferred");
  state.turnGate.open();
  await waitFor(() => turnDone, "the turn to end inside prompt()");
  await session().waitForIdle();
  await settle();
  assert.equal(state.loads, loadsAtStart, "no reload while prompt() has not returned");

  returnGate.open();
  await sent;
  await waitFor(() => state.loads === loadsAtStart + 1, "the deferred reload after prompt()");
});

await test("a deferred reload runs when the prompt fails before a run starts", async (t) => {
  const { driver, ref, state, promptHook } = await startHarness(t);
  const loadsAtStart = state.loads;
  const failGate = gate();
  let entered = false;
  promptHook.current = async () => {
    entered = true;
    await failGate.wait;
    throw new Error("prompt failed before the run");
  };

  const sent = driver.sendUserMessage(ref, { text: "hello" });
  await waitFor(() => entered, "prompt() to be called");
  assert.equal(await driver.reloadSessionWhenIdle(ref), "deferred");

  failGate.open();
  await assert.rejects(sent, /prompt failed before the run/);
  await waitFor(() => state.loads === loadsAtStart + 1, "the deferred reload after the failure");
});

await test("a message sent during a reload starts its turn after the reload", async (t) => {
  const { driver, ref, state, loadGate } = await startHarness(t);
  const loadsAtStart = state.loads;
  loadGate.current = gate();

  const reloaded = driver.reloadSessionWhenIdle(ref);
  await waitFor(() => state.loads === loadsAtStart + 1, "the reload to load extensions");
  const sent = driver.sendUserMessage(ref, { text: "hello" });
  await settle();
  assert.equal(state.streaming, false, "the turn waits for the reload");

  loadGate.current.open();
  assert.equal(await reloaded, "reloaded");
  await waitFor(() => state.streaming, "the turn to start after the reload");
  assert.equal(state.loadsAtLastTurn, loadsAtStart + 1);
  state.turnGate.open();
  await sent;
});

await test("a reload waits for a running extension command", async (t) => {
  const { driver, ref, state, commandGate } = await startHarness(t);
  const loadsAtStart = state.loads;

  // Like `/mcp login` waiting in its sign-in dialog.
  const sent = driver.sendUserMessage(ref, { text: "/hold" });
  await waitFor(() => state.commandRunning, "the command to start");
  assert.equal(await driver.reloadSessionWhenIdle(ref), "deferred");
  await settle();
  assert.equal(state.loads, loadsAtStart, "the command keeps its extension");

  commandGate.current.open();
  await sent;
  await waitFor(() => state.loads === loadsAtStart + 1, "the deferred reload after the command");
});

await test("a message sent before a pending reload has started runs after that reload", async (t) => {
  const { driver, ref, state, session } = await startHarness(t);
  const loadsAtStart = state.loads;
  // Holding the listener on the turn's completion keeps the event queue, and with it the
  // queued pending reload, from running: the gap between a turn's end and its reload.
  const listenerGate = gate();
  let completionHeld = false;
  const unsubscribe = driver.subscribe(ref, async (event) => {
    if (event.type !== "runCompleted" || completionHeld) return;
    completionHeld = true;
    await listenerGate.wait;
  });
  t.after(unsubscribe);

  const first = driver.sendUserMessage(ref, { text: "first" });
  await waitFor(() => state.streaming, "the first turn to start");
  assert.equal(await driver.reloadSessionWhenIdle(ref), "deferred");
  state.turnGate.open();
  await first;
  await session().waitForIdle();
  await waitFor(() => completionHeld, "the event queue to be held");
  assert.equal(state.loads, loadsAtStart, "the pending reload has not started");

  state.turnGate = gate();
  const second = driver.sendUserMessage(ref, { text: "second" });
  await waitFor(() => state.streaming, "the second turn to start");
  assert.equal(state.loadsAtLastTurn, loadsAtStart + 1, "the second turn has the new tools");

  listenerGate.open();
  state.turnGate.open();
  await second;
  await session().waitForIdle();
  await settle();
  assert.equal(state.loads, loadsAtStart + 1, "the queued pending reload does not run again");
});
