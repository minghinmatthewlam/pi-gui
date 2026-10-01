import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent, SessionTranscriptItem } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

function reply(model: Parameters<StreamFunction>[0], text: string) {
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

/** Real installed Pi and a real extension; only the provider is scripted. */
async function fixture(t: TestContext, streamFunction: StreamFunction) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-custom-message-"));
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
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "custom-message-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  let pi!: ExtensionAPI;
  let mode: string | undefined;
  const events: SessionDriverEvent[] = [];
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...runtimeOptions,
        resourceLoaderOptions: {
          ...runtimeOptions.resourceLoaderOptions,
          extensionFactories: [
            ...(runtimeOptions.resourceLoaderOptions?.extensionFactories ?? []),
            (api) => {
              pi = api;
              api.on("session_start", (_event, ctx) => {
                mode = ctx.mode;
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
    { workspaceId: "custom-message-workspace", path: cwd },
    { initialModel: { provider: "custom-message-test", modelId: "scripted" } },
  );
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });

  const settled = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const done = events.some((event) => event.type === "runCompleted");
      if (done) return;
    }
    throw new Error("run did not complete");
  };
  return {
    driver,
    ref,
    events,
    pi: () => pi,
    mode: () => mode,
    settled,
    appended: () =>
      events.flatMap((event) =>
        event.type === "transcriptItemAppended" && event.item.kind === "custom" ? [event.item] : [],
      ),
  };
}

const customRows = (items: readonly SessionTranscriptItem[]) =>
  items.filter((item) => item.kind === "custom");

await test("extensions see rpc mode and idle custom messages reach the live transcript with their entry id", async (t) => {
  const h = await fixture(t, (model) => reply(model, "unused"));
  assert.equal(h.mode(), "rpc");

  h.pi().sendMessage({ customType: "ci-status", content: "**Build** passed", display: true });
  h.pi().sendMessage({ customType: "ci-status", content: "model only", display: false });
  h.pi().sendMessage({ customType: "ci-status", content: "**Build** passed", display: true });
  // Each message reaches the app through the driver's event queue, which can lag under load.
  for (let attempt = 0; attempt < 500 && h.appended().length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const reloaded = customRows(await h.driver.getTranscript(h.ref));
  assert.equal(reloaded.length, 2, "display false stays hidden, like terminal pi");
  assert.deepEqual(
    h.appended().map(({ id, customType, text }) => ({ id, customType, text })),
    reloaded.map(({ id, customType, text }) => ({ id, customType, text })),
  );
  assert.notEqual(reloaded[0]!.id, reloaded[1]!.id);
});

await test("a hidden custom message never becomes the thread preview", async (t) => {
  const h = await fixture(t, (model) => reply(model, "unused"));
  h.pi().registerCommand("note", {
    description: "Show a note, then send a hidden one",
    handler: async () => {
      h.pi().sendMessage({ customType: "note", content: "Shown note", display: true });
      h.pi().sendMessage({ customType: "note", content: "model only", display: false });
    },
  });

  await h.driver.sendUserMessage(h.ref, { text: "/note" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const previews = h.events.flatMap((event) =>
    event.type === "sessionUpdated" && event.snapshot.preview ? [event.snapshot.preview] : [],
  );
  assert.ok(previews.includes("Shown note"));
  assert.ok(!previews.includes("model only"), previews.join(" | "));
});

await test("custom messages sent during a run keep their persisted entry ids", async (t) => {
  let calls = 0;
  let pi!: ExtensionAPI;
  const h = await fixture(t, (model) => {
    calls += 1;
    if (calls === 1) {
      // Streaming: a default send steers the run (persisted after message_end) and a
      // non-triggering one waits for turn_end (persisted before message_end).
      pi.sendMessage({ customType: "steer", content: "steered note", display: true });
      pi.sendMessage(
        { customType: "later", content: [{ type: "text", text: "after the turn" }], display: true },
        { triggerTurn: false },
      );
      // A hidden twin with equal text, flushed at turn_end before the steer is persisted.
      pi.sendMessage(
        { customType: "steer", content: "steered note", display: false },
        { triggerTurn: false },
      );
    }
    return reply(model, `reply ${calls}`);
  });
  pi = h.pi();
  let boundaryAdded = false;
  // A boundary result is announced as entry_appended rather than message_end.
  pi.on("turn_end", () => {
    if (boundaryAdded) return;
    boundaryAdded = true;
    return {
      entries: [
        { type: "custom_message", customType: "boundary", content: "from turn_end", display: true },
      ],
    };
  });

  await h.driver.sendUserMessage(h.ref, { text: "Start" });
  await h.settled();

  const reloaded = customRows(await h.driver.getTranscript(h.ref));
  assert.deepEqual(
    reloaded
      .map(({ customType, text }) => ({ customType, text }))
      .sort((a, b) => a.customType.localeCompare(b.customType)),
    [
      { customType: "boundary", text: "from turn_end" },
      { customType: "later", text: "after the turn" },
      { customType: "steer", text: "steered note" },
    ],
  );
  assert.deepEqual(
    h
      .appended()
      .map((item) => item.id)
      .sort(),
    reloaded.map((item) => item.id).sort(),
    "each live row carries its own entry id, once",
  );
  const run = h.events.find((event) => event.type === "transcriptItemAppended");
  assert.ok(run?.runId, "live rows carry the run they arrived in");
});
