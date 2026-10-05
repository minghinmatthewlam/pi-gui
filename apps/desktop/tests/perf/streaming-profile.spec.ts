/**
 * Diagnostic harness for issues #93 / #108 (UI stalls while a thread streams).
 * Not a regression test: it measures per-delta cost in main and in the renderer
 * on a realistic long thread and prints the numbers.
 */
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createSessionViaIpc,
  getDesktopState,
  launchElectronDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  seedTranscriptMessages,
  waitForWorkspaceByPath,
  type ElectronDesktopHarness,
} from "../helpers/electron-app";

test.describe.configure({ mode: "serial" });

const SEEDED_MESSAGES = Number(process.env.PERF_SEED ?? 120);
const DELTA_COUNT = Number(process.env.PERF_DELTAS ?? 150);
const LONG_BODY = Number(process.env.PERF_BODY ?? 2400);

function body(index: number): string {
  const filler = `paragraph ${index} `.repeat(Math.ceil(LONG_BODY / 14));
  return `## Step ${index}\n\n${filler.slice(0, LONG_BODY)}\n\n- bullet a\n- bullet b\n`;
}

interface MainCounters {
  readonly sends: Record<string, number>;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly wallMs: number;
  readonly cloneCount: number;
  readonly cloneMs: number;
  readonly sendMs: number;
}

async function patchMain(harness: ElectronDesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__perfSends = {} as Record<string, number>;
    if (!g.__perfClonePatched) {
      g.__perfClonePatched = true;
      g.__perfCloneCount = 0;
      g.__perfCloneMs = 0;
      g.__perfSendMs = 0;
      const originalClone: typeof structuredClone = globalThis.structuredClone;
      globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => {
        const started = performance.now();
        const result = originalClone(value, options);
        const store = globalThis as unknown as { __perfCloneCount: number; __perfCloneMs: number };
        store.__perfCloneCount += 1;
        store.__perfCloneMs += performance.now() - started;
        return result;
      };
    }
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents as unknown as Record<string, unknown> & {
        send: (channel: string, ...args: unknown[]) => void;
      };
      if (wc.__perfPatched) {
        continue;
      }
      wc.__perfPatched = true;
      const original = wc.send.bind(wc);
      wc.send = (channel: string, ...args: unknown[]) => {
        const sends = (globalThis as unknown as { __perfSends: Record<string, number> })
          .__perfSends;
        sends[channel] = (sends[channel] ?? 0) + 1;
        const started = performance.now();
        const result = original(channel, ...args);
        (globalThis as unknown as { __perfSendMs: number }).__perfSendMs +=
          performance.now() - started;
        return result;
      };
    }
  });
}

async function startMainSample(harness: ElectronDesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__perfSends = {};
    g.__perfCloneCount = 0;
    g.__perfCloneMs = 0;
    g.__perfSendMs = 0;
    g.__perfCpu = process.cpuUsage();
    g.__perfWall = Date.now();
  });
}

async function stopMainSample(harness: ElectronDesktopHarness): Promise<MainCounters> {
  return harness.electronApp.evaluate(() => {
    const g = globalThis as unknown as {
      __perfSends: Record<string, number>;
      __perfCpu: NodeJS.CpuUsage;
      __perfWall: number;
      __perfCloneCount: number;
      __perfCloneMs: number;
      __perfSendMs: number;
    };
    const delta = process.cpuUsage(g.__perfCpu);
    return {
      sends: { ...g.__perfSends },
      cpuUserMs: delta.user / 1000,
      cpuSystemMs: delta.system / 1000,
      wallMs: Date.now() - g.__perfWall,
      cloneCount: g.__perfCloneCount ?? 0,
      cloneMs: g.__perfCloneMs ?? 0,
      sendMs: g.__perfSendMs ?? 0,
    };
  });
}

async function startRendererSample(window: Page): Promise<void> {
  await window.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    const frames: number[] = [];
    g.__perfFrames = frames;
    g.__perfLongTaskMs = 0;
    g.__perfStopFrames = false;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (!(globalThis as unknown as { __perfStopFrames: boolean }).__perfStopFrames) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          (globalThis as unknown as { __perfLongTaskMs: number }).__perfLongTaskMs +=
            entry.duration;
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      g.__perfObserver = observer;
    } catch {
      // longtask unsupported; frame gaps still tell the story
    }
  });
}

async function stopRendererSample(window: Page): Promise<{
  readonly frameCount: number;
  readonly maxFrameGapMs: number;
  readonly p95FrameGapMs: number;
  readonly longTaskMs: number;
}> {
  return window.evaluate(() => {
    const g = globalThis as unknown as {
      __perfFrames: number[];
      __perfLongTaskMs: number;
      __perfStopFrames: boolean;
      __perfObserver?: PerformanceObserver;
    };
    g.__perfStopFrames = true;
    g.__perfObserver?.disconnect();
    const frames = [...g.__perfFrames].sort((a, b) => a - b);
    return {
      frameCount: frames.length,
      maxFrameGapMs: frames.at(-1) ?? 0,
      p95FrameGapMs: frames[Math.floor(frames.length * 0.95)] ?? 0,
      longTaskMs: g.__perfLongTaskMs,
    };
  });
}

async function emitNoWait(
  harness: ElectronDesktopHarness,
  event: SessionDriverEvent,
): Promise<void> {
  await harness.electronApp.evaluate(async (_, payload) => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: { emitSessionEvent?: (event: SessionDriverEvent) => Promise<void> };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.emitSessionEvent) {
      throw new Error("Test session-event hook is unavailable");
    }
    await hooks.emitSessionEvent(payload);
  }, event);
}

async function measure(label: string, seeded: number): Promise<void> {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace(`perf-${label}`);
  const harness = await launchElectronDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createSessionViaIpc(window, workspacePath, `perf-${label}`);
    await selectSession(window, `perf-${label}`);

    if (seeded > 0) {
      await seedTranscriptMessages(harness, window, { count: seeded, textFactory: body });
    }

    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
    expect(workspace && session).toBeTruthy();
    const sessionRef: SessionRef = {
      workspaceId: workspace!.id,
      sessionId: session!.id,
    };
    const workspaceRef = {
      workspaceId: workspace!.id,
      path: workspace!.path,
      displayName: workspace!.name,
    };
    const runId = `perf-run-${Date.now()}`;
    const startedAt = new Date().toISOString();

    await emitNoWait(harness, {
      type: "sessionUpdated",
      sessionRef,
      timestamp: startedAt,
      runId,
      snapshot: {
        ref: sessionRef,
        workspace: workspaceRef,
        title: session!.title,
        status: "running",
        updatedAt: startedAt,
        preview: "streaming",
        runningRunId: runId,
      },
    });

    const transcriptLength = await window.evaluate(async () => {
      const app = globalThis.window.piApp;
      const record = await app!.getSelectedTranscript();
      return record?.transcript.length ?? 0;
    });

    // Harness baseline: the same number of main-process CDP round trips doing
    // nothing, so the per-delta numbers can be read net of Playwright overhead.
    await startMainSample(harness);
    const baseT0 = Date.now();
    for (let index = 0; index < DELTA_COUNT * 2; index += 1) {
      await harness.electronApp.evaluate(() => undefined);
    }
    const baselineWallMs = Date.now() - baseT0;
    const baseline = await stopMainSample(harness);

    await patchMain(harness);
    await startRendererSample(window);
    const cdp = await window
      .context()
      .newCDPSession(window)
      .catch(() => null);
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    await startMainSample(harness);
    const t0 = Date.now();
    for (let index = 0; index < DELTA_COUNT; index += 1) {
      // Real streams emit a sessionUpdated alongside each assistant delta.
      await emitNoWait(harness, {
        type: "assistantDelta",
        sessionRef,
        timestamp: new Date().toISOString(),
        runId,
        text: `tok${index} `,
      });
      await emitNoWait(harness, {
        type: "sessionUpdated",
        sessionRef,
        timestamp: new Date().toISOString(),
        runId,
        snapshot: {
          ref: sessionRef,
          workspace: workspaceRef,
          title: session!.title,
          status: "running",
          updatedAt: new Date().toISOString(),
          preview: `tok${index}`,
          runningRunId: runId,
        },
      });
    }
    const streamWallMs = Date.now() - t0;

    // The user-visible symptom in #93: start a burst of deltas, then ask main to
    // do an unrelated piece of work (create a thread) and time how long it takes
    // to come back while the burst is still draining.
    const burst: Array<Promise<void>> = [];
    for (let index = 0; index < DELTA_COUNT; index += 1) {
      burst.push(
        emitNoWait(harness, {
          type: "assistantDelta",
          sessionRef,
          timestamp: new Date().toISOString(),
          runId,
          text: `burst${index} `,
        }),
      );
    }
    // Unpatched main does not reliably survive this probe -- the app context goes
    // away mid-burst -- so a failure is reported rather than failing the run.
    const createSessionDuringStreamMs = await window
      .evaluate(async (workspaceId) => {
        const app = globalThis.window.piApp;
        const started = performance.now();
        await app!.createSession({ workspaceId, title: `during-stream-${Date.now()}` });
        return performance.now() - started;
      }, workspace!.id)
      .catch(() => null);
    await Promise.allSettled(burst);

    const main = await stopMainSample(harness);
    const renderer = await stopRendererSample(window);
    let topRenderer: Array<{ fn: string; selfMs: number }> = [];
    if (cdp) {
      const { profile } = (await cdp.send("Profiler.stop")) as unknown as {
        profile: {
          nodes: Array<{
            id: number;
            callFrame: { functionName: string; url: string; lineNumber: number };
          }>;
          samples: number[];
          timeDeltas: number[];
        };
      };
      const selfByNode = new Map<number, number>();
      for (const [index, nodeId] of profile.samples.entries()) {
        selfByNode.set(
          nodeId,
          (selfByNode.get(nodeId) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000,
        );
      }
      const byName = new Map<string, number>();
      for (const node of profile.nodes) {
        const ms = selfByNode.get(node.id) ?? 0;
        if (ms <= 0) continue;
        const file = node.callFrame.url.split("/").slice(-1)[0] ?? "";
        const name = `${node.callFrame.functionName || "(anonymous)"} @ ${file}:${node.callFrame.lineNumber}`;
        byName.set(name, (byName.get(name) ?? 0) + ms);
      }
      topRenderer = [...byName.entries()]
        .map(([fn, selfMs]) => ({ fn, selfMs: Number(selfMs.toFixed(0)) }))
        .sort((a, b) => b.selfMs - a.selfMs)
        .slice(0, 15);
    }

    console.log(
      JSON.stringify(
        {
          label,
          seededMessages: seeded,
          transcriptLength,
          baselineWallMs,
          baselineMainCpuUserMs: Number(baseline.cpuUserMs.toFixed(0)),
          deltas: DELTA_COUNT,
          streamWallMs,
          createSessionDuringStreamMs:
            createSessionDuringStreamMs === null
              ? "unavailable (app context lost mid-burst)"
              : Number(createSessionDuringStreamMs.toFixed(0)),
          mainCpuMsPerDelta: Number((main.cpuUserMs / DELTA_COUNT).toFixed(2)),
          mainCpuUserMs: Number(main.cpuUserMs.toFixed(0)),
          mainSends: main.sends,
          mainStructuredClones: main.cloneCount,
          mainStructuredClonePerDelta: Number((main.cloneCount / DELTA_COUNT).toFixed(1)),
          mainStructuredCloneMs: Number(main.cloneMs.toFixed(0)),
          mainIpcSendMs: Number(main.sendMs.toFixed(0)),
          sendsPerDelta: Number(
            (
              Object.values(main.sends).reduce((sum, value) => sum + value, 0) / DELTA_COUNT
            ).toFixed(2),
          ),
          rendererLongTaskMs: Number(renderer.longTaskMs.toFixed(0)),
          rendererMaxFrameGapMs: Number(renderer.maxFrameGapMs.toFixed(0)),
          rendererP95FrameGapMs: Number(renderer.p95FrameGapMs.toFixed(0)),
          rendererFrames: renderer.frameCount,
          topRenderer,
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
}

test("streaming cost on a short thread", async () => {
  test.setTimeout(600_000);
  await measure("short", 10);
});

test("streaming cost on a long thread", async () => {
  test.setTimeout(600_000);
  await measure("long", SEEDED_MESSAGES);
});

// A paced stream and actual renderer wheel input, separate from the CPU-profile
// probe above. Run three times; timings are diagnostic, not CI pass thresholds.
test("paced wheel scrolling during a growing answer", async ({}, info) => {
  test.setTimeout(90_000);
  const h = await launchElectronDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("perf-wheel")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    const state = await getDesktopState(p);
    await createSessionViaIpc(p, state.selectedWorkspaceId!, "Paced wheel");
    const seeded = await seedTranscriptMessages(h, p, {
      count: SEEDED_MESSAGES,
      textFactory: body,
    });
    const sessionRef = seeded.sessionRef;
    const runId = `paced-${Date.now()}`;
    const seededState = await getDesktopState(p);
    const workspace = seededState.workspaces.find((w) => w.id === sessionRef.workspaceId)!;
    const session = workspace.sessions.find((s) => s.id === sessionRef.sessionId)!;
    const snapshot = {
      ref: sessionRef,
      workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
      title: session.title,
      status: "running" as const,
      updatedAt: new Date().toISOString(),
      preview: "streaming",
      runningRunId: runId,
    };
    await emitNoWait(h, {
      type: "sessionUpdated",
      sessionRef,
      runId,
      timestamp: snapshot.updatedAt,
      snapshot,
    });
    // Keep the growing row visible: virtualization alone cannot hide its cost.
    const initial =
      "```typescript\n" + "const item = { value: 'streaming example' };\n".repeat(700);
    await emitNoWait(h, {
      type: "assistantDelta",
      sessionRef,
      runId,
      timestamp: new Date().toISOString(),
      text: initial,
    });
    const pane = p.getByTestId("timeline-pane");
    await expect(pane).toContainText("streaming example");
    await pane.hover();
    await p.mouse.wheel(0, -1600);
    await expect
      .poll(() => pane.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeGreaterThan(1000);
    // Allow the initial wheel and estimates to settle before measuring.
    await p.waitForTimeout(300);
    const cdp = process.env.PERF_CPU === "1" ? await p.context().newCDPSession(p) : null;
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    await patchMain(h);
    await startMainSample(h);
    await p.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('[data-testid="timeline-pane"]')!;
      const frames: number[] = [],
        latencies: number[] = [],
        tasks: number[] = [];
      let previous = performance.now(),
        wheelAt: number | null = null,
        running = true,
        wheelEvents = 0;
      const frame = () => {
        const now = performance.now();
        frames.push(now - previous);
        previous = now;
        if (running) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const wheel = (event: WheelEvent) => {
        wheelAt ??= event.timeStamp;
        wheelEvents += 1;
      };
      const scroll = () => {
        if (wheelAt !== null) {
          latencies.push(performance.now() - wheelAt);
          wheelAt = null;
        }
      };
      pane.addEventListener("wheel", wheel, { passive: true });
      pane.addEventListener("scroll", scroll, { passive: true });
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
      (window as unknown as { finishWheelSample: () => unknown }).finishWheelSample = () => {
        running = false;
        observer.disconnect();
        pane.removeEventListener("wheel", wheel);
        pane.removeEventListener("scroll", scroll);
        return {
          frames,
          wheelEvents,
          latencies,
          tasks,
          mountedRows: pane.querySelectorAll("[data-message-id]").length,
        };
      };
    });
    const started = Date.now();
    let streaming = true;
    let streamDurationMs = 0;
    let wheelDurationMs = 0;
    await Promise.all([
      (async () => {
        try {
          for (let i = 0; i < 300; i++) {
            await emitNoWait(h, {
              type: "assistantDelta",
              sessionRef,
              runId,
              timestamp: new Date().toISOString(),
              text: `const next${i} = ${i};\n`,
            });
            await emitNoWait(h, {
              type: "sessionUpdated",
              sessionRef,
              runId,
              timestamp: new Date().toISOString(),
              snapshot: { ...snapshot, updatedAt: new Date().toISOString(), preview: `next${i}` },
            });
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await expect(pane).toContainText("const next299 = 299;");
        } finally {
          streamDurationMs = Date.now() - started;
          streaming = false;
        }
      })(),
      (async () => {
        for (let i = 0; streaming; i++) {
          await p.mouse.wheel(0, i % 20 < 10 ? -40 : 40);
          await p.waitForTimeout(25);
        }
        wheelDurationMs = Date.now() - started;
      })(),
    ]);
    const main = await stopMainSample(h);
    const sample = await p.evaluate(() =>
      (
        window as unknown as {
          finishWheelSample: () => {
            frames: number[];
            wheelEvents: number;
            latencies: number[];
            tasks: number[];
            mountedRows: number;
          };
        }
      ).finishWheelSample(),
    );
    const percentile = (values: number[], ratio: number) =>
      [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.floor(values.length * ratio))
      ] ?? 0;
    const result = {
      label: process.env.PERF_LABEL ?? "checkout",
      seeded: SEEDED_MESSAGES,
      eventPairs: 300,
      streamDurationMs,
      wheelDurationMs,
      wheelEvents: sample.wheelEvents,
      cpuProfileEnabled: Boolean(cdp),
      frameCount: sample.frames.length,
      p95FrameMs: percentile(sample.frames, 0.95),
      maxFrameMs: percentile(sample.frames, 1),
      over33Percent: (sample.frames.filter((n) => n > 33).length / sample.frames.length) * 100,
      wheelSamples: sample.latencies.length,
      p95WheelEventToScrollMs: percentile(sample.latencies, 0.95),
      longTasks: sample.tasks,
      mountedRows: sample.mountedRows,
      mainSends: main.sends,
    };
    console.log("PACED_WHEEL_RESULT " + JSON.stringify(result));
    const resultPath = info.outputPath("paced-wheel.json");
    await writeFile(resultPath, JSON.stringify({ ...result, ...sample }));
    await info.attach("paced-wheel.json", { path: resultPath, contentType: "application/json" });
    if (cdp) {
      const { profile } = await cdp.send("Profiler.stop");
      const profilePath = info.outputPath("paced-wheel.cpuprofile");
      await writeFile(profilePath, JSON.stringify(profile));
      await info.attach("paced-wheel.cpuprofile", {
        path: profilePath,
        contentType: "application/json",
      });
    }
    expect(sample.latencies.length).toBeGreaterThan(50);
    expect(sample.frames.length).toBeGreaterThan(100);
  } finally {
    await h.close();
  }
});
