/**
 * Benchmark for parallel child-thread streaming (PR #297). Not a regression test:
 * it streams N orchestration children at once from a local OpenAI-compatible
 * endpoint and prints main-process event-loop lag and state-push counts.
 *
 *   PERF_CHILDREN=12 PERF_TOKENS=300 PERF_TOKEN_MS=15 pnpm run test:perf:parallel-children
 */
import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
  seedNamedTextSessionFixture,
} from "../helpers/electron-app";

const CHILDREN = Number(process.env.PERF_CHILDREN ?? 12);
const TOKENS = Number(process.env.PERF_TOKENS ?? 300);
const TOKEN_MS = Number(process.env.PERF_TOKEN_MS ?? 15);
const PARENT_LINES = Number(process.env.PERF_PARENT_LINES ?? 4000);
const SAMPLE_MS = 10;

interface GatedStreamingServer {
  readonly baseUrl: string;
  readonly waiting: () => number;
  readonly finished: () => number;
  readonly release: () => void;
  readonly close: () => Promise<void>;
}

/** Holds every chat request until release(), then streams TOKENS chunks to each at once. */
async function startGatedStreamingServer(): Promise<GatedStreamingServer> {
  const held: ServerResponse[] = [];
  const sockets = new Set<Socket>();
  let released = false;
  let finished = 0;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "bench",
      object: "chat.completion.chunk",
      created: 0,
      model: "stream",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const stream = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(chunk({ role: "assistant", content: "" }));
    let sent = 0;
    const timer = setInterval(() => {
      if (response.destroyed) {
        clearInterval(timer);
        return;
      }
      if (sent < TOKENS) {
        response.write(chunk({ content: `word${sent} ` }));
        sent++;
        return;
      }
      clearInterval(timer);
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
      finished++;
    }, TOKEN_MS);
  };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (released) stream(response);
      else held.push(response);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    waiting: () => held.length,
    finished: () => finished,
    release: () => {
      released = true;
      for (const response of held.splice(0)) stream(response);
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

test("parallel children: main-process event-loop lag while N children stream", async ({}, info) => {
  test.setTimeout(180_000);
  const server = await startGatedStreamingServer();
  const userDataDir = await makeUserDataDir("pi-parallel-bench-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("parallel-children-bench");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["bench/stream"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "bench",
      defaultModel: "stream",
      enabledModels: ["bench/stream"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        bench: {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "stream" }],
        },
      },
    }),
  );
  // A long orchestrator thread, so rescanning parent evidence has real cost.
  const parent = await seedNamedTextSessionFixture(agentDir, workspacePath, {
    title: "Bench parent",
    userText: "Coordinate the workers",
    assistantText: Array.from({ length: PARENT_LINES }, (_, n) => `Planning note ${n}.`).join("\n"),
  });
  await writeFile(
    join(userDataDir, "ui-state.json"),
    JSON.stringify({
      version: 19,
      selectedWorkspaceId: workspacePath,
      selectedSessionId: parent.sessionId,
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await expect
      .poll(async () => (await getDesktopState(window)).selectedSessionId)
      .toBe(parent.sessionId);
    const parentRef = { workspaceId: workspacePath, sessionId: parent.sessionId };
    for (let index = 0; index < CHILDREN; index++) {
      await runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: `bench-child-${index}`,
        sessionRef: parentRef,
        params: { prompt: `Worker ${index}: write a long report.` },
      });
    }
    await expect.poll(() => server.waiting(), { timeout: 30_000 }).toBeGreaterThanOrEqual(CHILDREN);

    await harness.electronApp.evaluate(({ BrowserWindow }, sampleMs) => {
      const g = globalThis as unknown as Record<string, unknown>;
      const lags: number[] = [];
      const sends: Record<string, number> = {};
      g.__benchLags = lags;
      g.__benchSends = sends;
      let expected = performance.now() + sampleMs;
      g.__benchTimer = setInterval(() => {
        const now = performance.now();
        lags.push(Math.max(0, now - expected));
        expected = now + sampleMs;
      }, sampleMs);
      for (const win of BrowserWindow.getAllWindows()) {
        const wc = win.webContents as unknown as {
          send: (channel: string, ...args: unknown[]) => void;
        };
        const original = wc.send.bind(wc);
        wc.send = (channel: string, ...args: unknown[]) => {
          sends[channel] = (sends[channel] ?? 0) + 1;
          original(channel, ...args);
        };
      }
    }, SAMPLE_MS);
    await window.evaluate((sampleMs) => {
      const g = globalThis as unknown as Record<string, unknown>;
      const lags: number[] = [];
      g.__benchLags = lags;
      let expected = performance.now() + sampleMs;
      g.__benchTimer = setInterval(() => {
        const now = performance.now();
        lags.push(Math.max(0, now - expected));
        expected = now + sampleMs;
      }, sampleMs);
    }, SAMPLE_MS);
    const started = Date.now();
    server.release();
    await expect
      .poll(() => server.finished(), { timeout: 120_000, intervals: [100] })
      .toBeGreaterThanOrEqual(CHILDREN);
    const serverMs = Date.now() - started;
    // Sample until every child completed with its last token applied, so a failed or
    // truncated run cannot produce a cheaper-looking measurement.
    const lastWord = `word${TOKENS - 1}`;
    await expect
      .poll(
        async () =>
          (await getDesktopState(window)).orchestrationChildren.filter(
            (child) =>
              child.status === "complete" &&
              child.transcript.some((message) => message.text.includes(lastWord)),
          ).length,
        { timeout: 120_000, intervals: [100] },
      )
      .toBe(CHILDREN);
    const streamMs = Date.now() - started;
    const sample = await harness.electronApp.evaluate(() => {
      const g = globalThis as unknown as Record<string, unknown>;
      clearInterval(g.__benchTimer as ReturnType<typeof setInterval>);
      return { lags: g.__benchLags as number[], sends: g.__benchSends as Record<string, number> };
    });
    const rendererLags = await window.evaluate(() => {
      const g = globalThis as unknown as Record<string, unknown>;
      clearInterval(g.__benchTimer as ReturnType<typeof setInterval>);
      return g.__benchLags as number[];
    });
    const rendererSorted = [...rendererLags].sort((a, b) => a - b);
    const sorted = [...sample.lags].sort((a, b) => a - b);
    const blockedMs = sample.lags.reduce((sum, lag) => sum + lag, 0);
    const result = {
      children: CHILDREN,
      tokensPerChild: TOKENS,
      tokenMs: TOKEN_MS,
      parentLines: PARENT_LINES,
      serverMs,
      streamMs,
      samples: sorted.length,
      lagP50Ms: Number(percentile(sorted, 50).toFixed(1)),
      lagP95Ms: Number(percentile(sorted, 95).toFixed(1)),
      lagP99Ms: Number(percentile(sorted, 99).toFixed(1)),
      lagMaxMs: Number((sorted.at(-1) ?? 0).toFixed(1)),
      blockedShare: Number((blockedMs / streamMs).toFixed(3)),
      rendererSamples: rendererSorted.length,
      rendererLagP95Ms: Number(percentile(rendererSorted, 95).toFixed(1)),
      rendererLagMaxMs: Number((rendererSorted.at(-1) ?? 0).toFixed(1)),
      rendererBlockedShare: Number(
        (rendererLags.reduce((sum, lag) => sum + lag, 0) / streamMs).toFixed(3),
      ),
      stateSendsPerSec: Number(
        (((sample.sends["pi-gui:state-changed"] ?? 0) * 1000) / streamMs).toFixed(1),
      ),
      sends: sample.sends,
    };
    console.log(`PARALLEL_BENCH ${JSON.stringify(result)}`);
    await info.attach("parallel-children-profile", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    expect(sorted.length).toBeGreaterThan(0);
  } finally {
    await harness.close();
    await server.close();
  }
});
