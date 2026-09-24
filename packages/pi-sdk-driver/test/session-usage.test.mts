import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";
import { parsePlanLimitHeaders } from "../dist/session-usage.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

const REQUEST_STARTED_AT = Date.parse("2026-09-24T12:00:00.000Z");

const reply: StreamFunction = (model) => {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 200,
      output: 50,
      cacheRead: 9000,
      cacheWrite: 800,
      totalTokens: 10050,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
    stopReason: "stop",
    timestamp: REQUEST_STARTED_AT,
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
};

async function runOneTurn(t: TestContext, promptCache: Record<string, number> | undefined) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-session-usage-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRetention = process.env.PI_CACHE_RETENTION;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CACHE_RETENTION;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousRetention !== undefined) process.env.PI_CACHE_RETENTION = previousRetention;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("session usage tests must never use the network");
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], cacheWarming: "off", compaction: { reserveTokens: 16000 } }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "usage-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [
            {
              id: "scripted",
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              ...(promptCache ? { promptCache } : {}),
            },
            {
              id: "other",
              input: ["text"],
              contextWindow: 64000,
              maxTokens: 4096,
              ...(promptCache ? { promptCache } : {}),
            },
          ],
        },
      },
    }),
  );

  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (options) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback({ ...options, tools: [] });
      runtime.session.agent.streamFunction = reply;
      return runtime;
    },
  });
  const snapshot = await driver.createSession(
    { workspaceId: "usage-workspace", path: cwd },
    { initialModel: { provider: "usage-test", modelId: "scripted" } },
  );
  const events: SessionDriverEvent[] = [];
  const completed = new Promise<Extract<SessionDriverEvent, { type: "runCompleted" }>>(
    (resolve) => {
      const unsubscribe = driver.subscribe(snapshot.ref, (event) => {
        events.push(event);
        if (event.type === "runCompleted") resolve(event);
      });
      t.after(async () => {
        unsubscribe();
        await driver.closeSession(snapshot.ref);
      });
    },
  );
  await driver.sendUserMessage(snapshot.ref, { text: "hello" });
  return { driver, opened: snapshot, completed: await completed, events };
}

await test("a fresh session reports its context window before any turn", async (t) => {
  const { opened } = await runOneTurn(t, undefined);
  assert.equal(opened.usage?.context?.contextWindow, 128000);
  assert.equal(opened.usage?.lastTurn, undefined);
  assert.deepEqual(opened.usage?.cache, {});
});

await test("a completed turn reports pi's context, cache and totals", async (t) => {
  const { completed } = await runOneTurn(t, { short: 300 });
  const usage = completed.snapshot.usage;
  assert.ok(usage);
  assert.ok(usage.context);
  // pi counts the last reply's input + output + cache read + cache write.
  assert.equal(usage.context.tokens, 10050);
  assert.equal(usage.context.contextWindow, 128000);
  assert.equal(usage.context.compactAtTokens, 128000 - 16000);
  assert.deepEqual(usage.lastTurn, { input: 200, output: 50, cacheRead: 9000, cacheWrite: 800 });
  assert.deepEqual(usage.totals, {
    input: 200,
    output: 50,
    cacheRead: 9000,
    cacheWrite: 800,
    cost: 0.25,
  });
  assert.equal(usage.subscription, false);
  // The cache entry lapses one lifetime after the request that last touched it.
  assert.deepEqual(usage.cache, {
    lifetimeSeconds: 300,
    expiresAt: new Date(REQUEST_STARTED_AT + 300_000).toISOString(),
  });
});

await test("switching models drops the old model's cache expiry", async (t) => {
  const { driver, completed, events } = await runOneTurn(t, { short: 300 });
  await driver.setSessionModel(completed.sessionRef, { provider: "usage-test", modelId: "other" });
  const latest = events.filter((event) => event.type === "sessionUpdated").at(-1);
  assert.ok(latest?.type === "sessionUpdated");
  assert.equal(latest.snapshot.usage?.context?.contextWindow, 64000);
  // The last reply was the other model's, so nothing is cached for this one.
  assert.deepEqual(latest.snapshot.usage?.cache, { lifetimeSeconds: 300 });
});

await test("a model without a declared cache lifetime reports unknown expiry", async (t) => {
  const { completed } = await runOneTurn(t, undefined);
  assert.deepEqual(completed.snapshot.usage?.cache, {});
});

await test("Codex plan-limit headers parse into windows", () => {
  // Shape captured from a live ChatGPT-subscription Codex response.
  const limits = parsePlanLimitHeaders({
    "x-codex-plan-type": "pro",
    "x-codex-primary-used-percent": "72",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "1790416878",
    "x-codex-primary-reset-after-seconds": "144545",
    "x-codex-secondary-used-percent": "0",
    "x-codex-secondary-window-minutes": "0",
    "x-codex-secondary-reset-at": "",
  });
  assert.deepEqual(limits, [
    {
      windowMinutes: 10080,
      usedPercent: 72,
      resetsAt: new Date(1790416878 * 1000).toISOString(),
    },
  ]);
});

await test("Claude unified limit headers parse as percentages", () => {
  const limits = parsePlanLimitHeaders({
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.41",
    "anthropic-ratelimit-unified-5h-reset": "1790416878",
  });
  assert.equal(limits.length, 1);
  assert.equal(limits[0]?.windowMinutes, 300);
  assert.ok(Math.abs((limits[0]?.usedPercent ?? 0) - 41) < 1e-9);
});

await test("responses without plan headers report nothing", () => {
  assert.deepEqual(parsePlanLimitHeaders({ "content-type": "text/event-stream" }), []);
});
