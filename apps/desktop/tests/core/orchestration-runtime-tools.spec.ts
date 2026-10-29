import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
} from "../helpers/electron-app";
import { startHangingOpenAiServer } from "../helpers/hanging-openai-server";

async function selectedSessionRef(
  window: Parameters<typeof getDesktopState>[0],
): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("create_child_thread returns after a slow worker starts, before its turn completes", async () => {
  test.setTimeout(60_000);
  const proofDir = process.env.PI_APP_ORCHESTRATION_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  // create_child_thread must return after the running acknowledgement rather than
  // await a model turn this server never answers.
  const server = await startHangingOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-start-ack");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["slow-test/slow"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "slow-test",
        defaultModel: "slow",
        enabledModels: ["slow-test/slow"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "slow-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "slow" }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    // Record what state pushes carry: child links, and never child transcripts.
    await window.evaluate(() => {
      const record = globalThis as typeof globalThis & {
        pushes?: { transcriptRows: number; linkedChildIds: string[] }[];
      };
      record.pushes = [];
      globalThis.window.piApp?.onStateChanged((state) => {
        record.pushes?.push({
          transcriptRows: state.orchestrationChildren.reduce(
            (rows, child) => rows + child.transcript.length + (child.latestTranscript ? 1 : 0),
            0,
          ),
          linkedChildIds: state.childThreadLinks.map((link) => link.childSessionId),
        });
      });
    });
    const prompt = "Keep this delegated worker running slowly.";
    // The server never answers, so the child's first turn cannot complete. A tool
    // that awaited the turn would never return, and the test timeout names this step.
    const result = await test.step("create_child_thread returns while the turn is in flight", () =>
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-start-ack",
        sessionRef: parentRef,
        params: { prompt },
      }));

    expect(result.details).toMatchObject({ deliveryStatus: "running", prompt });
    // The worker's model request reached the server and is still unanswered.
    await expect.poll(() => server.pendingRequestCount()).toBeGreaterThan(0);
    const child = (await getDesktopState(window)).orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "create-child-start-ack",
    );
    expect(child?.status).toBe("running");
    expect(child?.transcript.length).toBeGreaterThan(0);
    const childRunningIndicator = window.locator(
      `.session-row[data-session-id="${child?.childSessionId}"] .session-row__status--running`,
    );
    await expect(childRunningIndicator).toBeVisible();
    const archivedWhileRunning = await runOrchestrationRuntimeTool(harness, {
      toolName: "archive_child_threads",
      sessionRef: parentRef,
      params: { thread_ids: [child!.id] },
    });
    expect(archivedWhileRunning.details?.archived).toEqual([]);
    expect(archivedWhileRunning.details?.skipped).toEqual([
      {
        threadId: child!.id,
        reason: "Child thread is running or has queued messages; it was not archived.",
      },
    ]);
    const queued = await runOrchestrationRuntimeTool(harness, {
      toolName: "send_message_to_thread",
      sessionRef: parentRef,
      params: { thread_id: child!.id, message: "Finish the current work, then verify it." },
    });
    expect(queued.details?.queuedMessageCount).toBeGreaterThan(0);
    const skippedQueue = await runOrchestrationRuntimeTool(harness, {
      toolName: "archive_child_threads",
      sessionRef: parentRef,
      params: { thread_ids: [child!.id] },
    });
    expect(skippedQueue.details?.archived).toEqual([]);
    expect(skippedQueue.details?.skipped).toHaveLength(1);
    expect(server.pendingRequestCount()).toBeGreaterThan(0);
    const afterArchiveAttempt = await getDesktopState(window);
    expect(
      afterArchiveAttempt.workspaces
        .flatMap((ws) => ws.sessions)
        .find((session) => session.id === child?.childSessionId)?.archivedAt,
    ).toBeUndefined();
    // getState() returns the full child; pushes carry only its link, never its transcript.
    const pushes = () =>
      window.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              pushes?: { transcriptRows: number; linkedChildIds: string[] }[];
            }
          ).pushes ?? [],
      );
    const nestedChildRow = window.locator(
      `.session-tree__children[data-parent-session-id="${parentRef.sessionId}"] .session-row[data-session-id="${child?.childSessionId}"]`,
    );
    await expect(nestedChildRow).toBeVisible();
    const pushesBefore = (await pushes()).length;
    // Pin and unpin the parent: each sends a push. The tree must survive them.
    const parentRow = window
      .locator(`.session-row[data-session-id="${parentRef.sessionId}"]`)
      .first();
    await parentRow.hover();
    await parentRow.getByRole("button", { name: /^Pin / }).click();
    await expect(nestedChildRow).toBeVisible();
    await parentRow.hover();
    await parentRow.getByRole("button", { name: /^Unpin / }).click();
    await expect.poll(async () => (await pushes()).length).toBeGreaterThan(pushesBefore + 1);
    await expect(nestedChildRow).toBeVisible();
    const pushed = await pushes();
    expect(pushed.every((push) => push.transcriptRows === 0)).toBe(true);
    expect(pushed.at(-1)?.linkedChildIds).toContain(child?.childSessionId);
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "orchestration-child-running.png"),
        fullPage: true,
      });
    }
  } finally {
    await harness.close();
    await server.close();
  }
});

test("create_child_thread surfaces deterministic initial-prompt delivery failures", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-tools");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const prompt = "Child must start this delegated task.";

    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-delivery-failure",
        sessionRef: parentRef,
        params: { prompt },
      }),
    ).rejects.toThrow(/API key|authentication|credential/i);

    const state = await getDesktopState(window);
    const matchingChildren = state.orchestrationChildren.filter(
      (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
    );
    expect(matchingChildren).toHaveLength(1);
    expect(matchingChildren[0]?.status).toBe("failed");
    expect(matchingChildren[0]?.latestTranscript).toMatch(/API key|authentication|credential/i);
    expect(matchingChildren[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Initial prompt delivery failed", status: "failed" }),
      ]),
    );

    // Replaying the same tool call must re-surface the failed launch, not treat
    // the already-created session record as proof of success or create a duplicate.
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-delivery-failure",
        sessionRef: parentRef,
        params: { prompt },
      }),
    ).rejects.toThrow(/API key|authentication|credential/i);
    expect(
      (await getDesktopState(window)).orchestrationChildren.filter(
        (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
      ),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
