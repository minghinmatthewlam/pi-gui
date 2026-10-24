import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";
import {
  emitTestSessionEvent,
  emitTestSessionEvents,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
} from "../helpers/electron-app";

test("24 parallel children keep drafts and final states without per-token full-state clones", async ({}, info) => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("pi-parallel-perf-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("parallel-orchestration-perf");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const parent = await seedNamedTextSessionFixture(agentDir, workspacePath, {
    title: "Parallel parent",
    userText: "Synthetic performance fixture",
    assistantText: "Parent history without private data.\n".repeat(3000),
  });
  const children: OrchestrationChildThread[] = [];
  const now = new Date().toISOString();
  for (let index = 0; index < 24; index++) {
    const session = await seedNamedTextSessionFixture(agentDir, workspacePath, {
      title: `Worker ${index}`,
      userText: "Synthetic worker",
      assistantText: "Initial worker output",
    });
    const id = `child-${index}`;
    children.push({
      id,
      parentWorkspaceId: workspacePath,
      parentSessionId: parent.sessionId,
      childWorkspaceId: workspacePath,
      childSessionId: session.sessionId,
      title: session.title,
      goal: "Verify parallel UI updates",
      status: "running",
      latestTranscript: "Initial worker output",
      transcript: [],
      evidence: Array.from({ length: 80 }, (_, n) => ({
        id: `${id}-evidence-${n}`,
        childThreadId: id,
        kind: "worker_report",
        source: "worker-reported",
        status: "reported",
        title: "Historical report",
        detail: "Synthetic retained evidence. ".repeat(35),
        parentSessionId: parent.sessionId,
        childSessionId: session.sessionId,
        createdAt: now,
      })),
      createdAt: now,
      updatedAt: now,
    });
  }
  await writeFile(
    join(userDataDir, "ui-state.json"),
    JSON.stringify({
      version: 19,
      selectedWorkspaceId: workspacePath,
      selectedSessionId: parent.sessionId,
      orchestrationChildren: children,
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    scrubProviderEnv: true,
  });
  try {
    const window = await harness.firstWindow();
    await expect
      .poll(async () => (await getDesktopState(window)).orchestrationChildren.length)
      .toBe(24);
    const identity = await harness.electronApp.evaluate(({ app }) => ({
      pid: process.pid,
      userData: app.getPath("userData"),
      agentDir: process.env.PI_CODING_AGENT_DIR,
    }));
    expect(identity.userData).toBe(userDataDir);
    expect(identity.agentDir).toBe(agentDir);
    const workspace = { workspaceId: workspacePath, path: workspacePath, displayName: "fixture" };
    const snapshots = children.map((child, index) => ({
      ref: { workspaceId: workspacePath, sessionId: child.childSessionId },
      workspace,
      title: child.title,
      status: "running" as const,
      updatedAt: now,
      runningRunId: `parallel-${index}`,
    }));
    await emitTestSessionEvents(
      harness,
      snapshots.map((snapshot) => ({
        type: "sessionUpdated",
        sessionRef: snapshot.ref,
        timestamp: now,
        snapshot,
      })),
    );
    await harness.electronApp.evaluate(() => {
      const g = globalThis as unknown as { __parallelCloneCount: number };
      g.__parallelCloneCount = 0;
      const original = globalThis.structuredClone;
      globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => {
        g.__parallelCloneCount++;
        return original(value, options);
      };
    });
    const events: SessionDriverEvent[] = [];
    for (let n = 0; n < 40; n++) {
      for (const snapshot of snapshots) {
        events.push({
          type: "assistantDelta",
          sessionRef: snapshot.ref,
          timestamp: now,
          text: `片段${n} `,
        });
        events.push({ type: "sessionUpdated", sessionRef: snapshot.ref, timestamp: now, snapshot });
      }
    }
    const started = Date.now();
    await Promise.all([
      emitTestSessionEvents(harness, events),
      window.getByTestId("composer").fill("中文草稿：后台任务继续运行，不要丢失这段文字。"),
    ]);
    await expect(window.getByTestId("composer")).toHaveValue(
      "中文草稿：后台任务继续运行，不要丢失这段文字。",
    );
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.orchestrationChildren.every((child) =>
          child.transcript.some((message) => message.text.includes("片段39")),
        );
      })
      .toBe(true);
    const clones = await harness.electronApp.evaluate(
      () => (globalThis as unknown as { __parallelCloneCount: number }).__parallelCloneCount,
    );
    await info.attach("parallel-performance", {
      body: JSON.stringify({
        identity,
        children: children.length,
        events: events.length,
        cloneCount: clones,
        burstElapsedMs: Date.now() - started,
      }),
      contentType: "application/json",
    });
    expect(clones, "token events must not clone the full app/children state").toBeLessThan(40);
    const completed = snapshots[0]!;
    await emitTestSessionEvent(harness, {
      type: "runCompleted",
      sessionRef: completed.ref,
      timestamp: now,
      snapshot: { ...completed, status: "idle", runningRunId: undefined },
    });
    const failed = snapshots[1]!;
    await emitTestSessionEvent(harness, {
      type: "runFailed",
      sessionRef: failed.ref,
      timestamp: now,
      error: { message: "Synthetic failure" },
    });
    await expect
      .poll(async () =>
        (await getDesktopState(window)).orchestrationChildren
          .slice(0, 2)
          .map((child) => child.status),
      )
      .toEqual(["complete", "failed"]);
    const active = snapshots[10]!;
    await selectSession(window, active.title);
    await expect(window.getByTestId("transcript")).toContainText("片段39");
    await selectSession(window, parent.title);
    await expect(window.getByTestId("composer")).toHaveValue(
      "中文草稿：后台任务继续运行，不要丢失这段文字。",
    );
    // A second background window must receive its own selected transcript while
    // the first keeps the parent's draft, even when global publishes are batched.
    const existing = new Set(harness.electronApp.windows());
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "n",
        modifiers: [process.platform === "darwin" ? "meta" : "control", "shift"],
      });
    });
    await expect.poll(() => harness.electronApp.windows().length).toBe(2);
    const second = harness.electronApp.windows().find((candidate) => !existing.has(candidate))!;
    await second.waitForLoadState("domcontentloaded");
    await selectSession(second, active.title);
    await emitTestSessionEvents(harness, [
      {
        type: "assistantDelta",
        sessionRef: active.ref,
        timestamp: now,
        text: "second window update",
      },
      {
        type: "toolStarted",
        sessionRef: active.ref,
        timestamp: now,
        callId: "tool-proof",
        toolName: "bash",
        input: { command: "synthetic" },
      },
      ...Array.from({ length: 40 }, (_, n): SessionDriverEvent => ({
        type: "toolUpdated",
        sessionRef: active.ref,
        timestamp: now,
        callId: "tool-proof",
        text: `progress-${n}`,
      })),
      {
        type: "toolFinished",
        sessionRef: active.ref,
        timestamp: now,
        callId: "tool-proof",
        success: true,
        output: "synthetic tool finished",
      },
    ]);
    await expect(second.getByTestId("transcript")).toContainText("second window update");
    await expect
      .poll(async () => {
        return (await getSelectedTranscript(second))?.transcript.find(
          (message) => message.kind === "tool" && message.callId === "tool-proof",
        );
      })
      .toMatchObject({ status: "success", output: "synthetic tool finished" });
    await expect(window.getByTestId("transcript")).not.toContainText("second window update");
    await expect(window.getByTestId("composer")).toHaveValue(
      "中文草稿：后台任务继续运行，不要丢失这段文字。",
    );
    await selectSession(second, parent.title);
    await expect(second.getByTestId("composer")).toHaveValue(
      "中文草稿：后台任务继续运行，不要丢失这段文字。",
    );
  } finally {
    await harness.close();
  }
});
