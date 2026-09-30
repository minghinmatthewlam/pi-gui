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

await test("a card button's failing command leaves the thread's running turn alone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-button-run-"));
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
        "button-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  // The model's reply streams until the test lets it finish.
  let finishReply!: () => void;
  const replyFinished = new Promise<void>((resolve) => {
    finishReply = resolve;
  });
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
    stream.push({ type: "start", partial: { ...message, content: [] } });
    replyFinished.then(
      () => stream.push({ type: "done", reason: "stop", message }),
      () => undefined,
    );
    return stream;
  };

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
              pi.registerCommand("broken", {
                description: "Always fails",
                handler: async () => {
                  throw new Error("CI is unreachable");
                },
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
    { workspaceId: "button-workspace", path: cwd },
    { initialModel: { provider: "button-test", modelId: "scripted" } },
  );
  const events: SessionDriverEvent[] = [];
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });
  const snapshot = async () =>
    (await driver.listSessions()).sessions.find(
      (session) => session.sessionRef.sessionId === ref.sessionId,
    );

  const turn = driver.sendUserMessage(ref, { text: "hello" });
  const deadline = Date.now() + 5_000;
  while (!runtime?.session.isStreaming && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(runtime.session.isStreaming, true, "the model's turn is running");
  const before = await snapshot();
  assert.equal(before?.status, "running");

  // Pi reports a command's own error as an extension error, which the app shows as a toast.
  await driver.sendUserMessage(ref, { text: "/broken", extensionCommandOnly: true });
  const reported = () =>
    events.some(
      (event) =>
        event.type === "hostUiRequest" &&
        event.request.kind === "notify" &&
        event.request.message.includes("CI is unreachable"),
    );
  const reportedBy = Date.now() + 5_000;
  while (!reported() && Date.now() < reportedBy) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(reported(), "the command's error is reported");
  // If running the command itself fails, the button's caller gets the error instead.
  const prompt = runtime.session.prompt.bind(runtime.session);
  t.mock.method(runtime.session, "prompt", async (text: string, options?: unknown) => {
    if (text === "/broken") throw new Error("could not run /broken");
    return prompt(text, options as Parameters<typeof prompt>[1]);
  });
  await assert.rejects(
    driver.sendUserMessage(ref, { text: "/broken", extensionCommandOnly: true }),
    /could not run \/broken/,
  );

  const after = await snapshot();
  assert.equal(after?.status, "running", "the turn is still running");
  assert.equal(after?.previewSnippet, before?.previewSnippet, "no error became the preview");
  assert.equal(
    events.some((event) => event.type === "runFailed"),
    false,
    "the running turn did not fail",
  );

  finishReply();
  await turn;
  await runtime.session.waitForIdle();
  const completedBy = Date.now() + 5_000;
  while (!events.some((event) => event.type === "runCompleted") && Date.now() < completedBy) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(events.filter((event) => event.type === "runCompleted").length, 1);
});
