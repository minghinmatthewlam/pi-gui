import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  fireDueScheduledTasks,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";
import { SCHEDULED_TASK_INTERVIEW_PROMPT } from "../../contracts/scheduled-tasks";

test("manual create, tabs, pause, and restart keep scheduled tasks", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("scheduled-tasks-list");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await first.firstWindow();
    await window.getByTestId("sidebar-scheduled").click();
    await expect(window.getByTestId("scheduled-tasks-view")).toBeVisible();
    await window.getByTestId("scheduled-task-create").click();
    await window.getByTestId("scheduled-task-setup-manually").click();
    await expect(window.getByTestId("scheduled-task-editor")).toBeVisible();
    await window.getByTestId("scheduled-task-title").fill("Standup ping");
    await window.getByTestId("scheduled-task-instruction").fill("Ask for yesterday's work");
    await window.getByTestId("scheduled-task-frequency").selectOption("interval");
    await window.getByTestId("scheduled-task-interval").fill("10");
    await window.getByTestId("scheduled-task-save").click();
    await expect(window.getByTestId("scheduled-task-editor")).toHaveCount(0);
    await expect(window.getByTestId("scheduled-task-row")).toContainText("Standup ping");
    await expect(window.getByTestId("scheduled-task-row")).toContainText("Every 10 minutes");
    await window.getByTestId("scheduled-task-filter-active").click();
    await expect(window.getByTestId("scheduled-task-row")).toBeVisible();

    const created = await getDesktopState(window);
    expect(created.scheduledTasks).toHaveLength(1);
    await window.getByRole("button", { name: "Actions for Standup ping" }).click();
    await window.getByRole("button", { name: "Pause" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).scheduledTasks[0]?.status)
      .toBe("paused");
  } finally {
    await first.close();
  }

  const second = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await second.firstWindow();
    await window.getByTestId("sidebar-scheduled").click();
    await expect(window.getByTestId("scheduled-task-row")).toContainText("Standup ping");
    await expect(window.getByTestId("scheduled-task-row")).toContainText("Paused");
    expect((await getDesktopState(window)).scheduledTasks[0]?.status).toBe("paused");
  } finally {
    await second.close();
  }
});

test("create with pi prefills the interview draft and does not send", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("scheduled-interview");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await window.getByTestId("sidebar-scheduled").click();
    await window.getByTestId("scheduled-task-create").click();
    await window.getByTestId("scheduled-task-create-with-pi").click();
    await expect(window.getByTestId("composer")).toHaveValue(SCHEDULED_TASK_INTERVIEW_PROMPT, {
      timeout: 15_000,
    });
    const transcript = await getSelectedTranscript(window);
    expect(
      transcript?.transcript.some((item) => item.kind === "message" && item.role === "assistant"),
    ).toBe(false);
    expect((await getDesktopState(window)).activeView).toBe("threads");
  } finally {
    await harness.close();
  }
});

test("firing a due existing-thread task labels the user bubble and shows a chip", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("scheduled-fire");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Fire target");
    const composerDraft = "keep this unsent draft";
    await window.getByTestId("composer").fill(composerDraft);
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(composerDraft);
    const before = await getDesktopState(window);
    const workspaceId = before.selectedWorkspaceId;
    const sessionId = before.selectedSessionId;
    expect(workspaceId).toBeTruthy();
    expect(sessionId).toBeTruthy();
    await window.evaluate(
      async ({ targetWorkspaceId, targetSessionId }) => {
        const app = globalThis.window.piApp;
        if (!app) {
          throw new Error("piApp IPC bridge is unavailable");
        }
        await app.createScheduledTask({
          title: "Due ping",
          instruction: "Say ping from scheduled task",
          schedule: { kind: "interval", everyMs: 60_000 },
          target: {
            kind: "existing-thread",
            workspaceId: targetWorkspaceId,
            sessionId: targetSessionId,
          },
        });
      },
      { targetWorkspaceId: workspaceId, targetSessionId: sessionId },
    );
    await expect.poll(async () => (await getDesktopState(window)).scheduledTasks).toHaveLength(1);
    await fireDueScheduledTasks(harness, new Date(Date.now() + 10 * 60_000).toISOString());
    await expect(window.getByTestId("sent-by-scheduled-task")).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("transcript")).toContainText("Say ping from scheduled task");
    await expect(window.getByTestId("composer")).toHaveValue(composerDraft);
    await expect(window.getByTestId("scheduled-task-chip")).toBeVisible();
    const after = await getDesktopState(window);
    expect(after.selectedSessionId).toBe(sessionId);
    expect(after.composerDraft).toBe(composerDraft);
    expect(after.scheduledTasks[0]?.runs[0]?.sessionId).toBe(sessionId);
  } finally {
    await harness.close();
  }
});

test("a second active bind to the same thread is rejected", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("scheduled-bind");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Bind target");
    const state = await getDesktopState(window);
    const payload = {
      title: "First bind",
      instruction: "First",
      schedule: { kind: "interval" as const, everyMs: 60_000 },
      target: {
        kind: "existing-thread" as const,
        workspaceId: state.selectedWorkspaceId,
        sessionId: state.selectedSessionId,
      },
    };
    await window.evaluate(async (input) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.createScheduledTask(input);
    }, payload);
    const second = await window.evaluate(async (input) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.createScheduledTask({ ...input, title: "Second bind", instruction: "Second" });
    }, payload);
    expect(second.lastError).toMatch(/already has a scheduled task/i);
    expect(second.scheduledTasks).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

test("past once create is rejected and title-only edit keeps timezone and nextRunAt", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("scheduled-edit-timing");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Edit target");
    const state = await getDesktopState(window);
    const past = await window.evaluate(
      async (input) => {
        const app = globalThis.window.piApp;
        if (!app) {
          throw new Error("piApp IPC bridge is unavailable");
        }
        return app.createScheduledTask(input);
      },
      {
        title: "Late ping",
        instruction: "Should not fire now",
        schedule: { kind: "once" as const, at: "2020-01-01T00:00:00.000Z" },
        target: {
          kind: "existing-thread" as const,
          workspaceId: state.selectedWorkspaceId,
          sessionId: state.selectedSessionId,
        },
      },
    );
    expect(past.lastError).toMatch(/future/i);
    expect(past.scheduledTasks).toHaveLength(0);

    const created = await window.evaluate(
      async (input) => {
        const app = globalThis.window.piApp;
        if (!app) {
          throw new Error("piApp IPC bridge is unavailable");
        }
        return app.createScheduledTask(input);
      },
      {
        title: "Morning ping",
        instruction: "Ask for yesterday",
        schedule: {
          kind: "daily" as const,
          hour: 9,
          minute: 0,
          timeZone: "America/Los_Angeles",
        },
        target: {
          kind: "existing-thread" as const,
          workspaceId: state.selectedWorkspaceId,
          sessionId: state.selectedSessionId,
        },
      },
    );
    expect(created.lastError).toBeUndefined();
    expect(created.scheduledTasks).toHaveLength(1);
    const nextRunAt = created.scheduledTasks[0]?.nextRunAt;
    expect(nextRunAt).toBeTruthy();

    const renamed = await window.evaluate(
      async ({ id }) => {
        const app = globalThis.window.piApp;
        if (!app) {
          throw new Error("piApp IPC bridge is unavailable");
        }
        return app.updateScheduledTask(id, { title: "Renamed morning ping" });
      },
      { id: created.scheduledTasks[0]!.id },
    );
    expect(renamed.lastError).toBeUndefined();
    expect(renamed.scheduledTasks[0]?.title).toBe("Renamed morning ping");
    expect(renamed.scheduledTasks[0]?.nextRunAt).toBe(nextRunAt);
    expect(renamed.scheduledTasks[0]?.schedule).toEqual({
      kind: "daily",
      hour: 9,
      minute: 0,
      timeZone: "America/Los_Angeles",
    });

    await window.getByTestId("sidebar-scheduled").click();
    await window.getByTestId("scheduled-task-row").click();
    await expect(window.getByTestId("scheduled-task-editor")).toBeVisible();
    await window.getByTestId("scheduled-task-title").fill("Editor renamed morning ping");
    await window.getByTestId("scheduled-task-save").click();
    await expect(window.getByTestId("scheduled-task-editor")).toHaveCount(0);
    const afterEditor = await getDesktopState(window);
    expect(afterEditor.scheduledTasks[0]?.title).toBe("Editor renamed morning ping");
    expect(afterEditor.scheduledTasks[0]?.nextRunAt).toBe(nextRunAt);
    expect(afterEditor.scheduledTasks[0]?.schedule).toEqual({
      kind: "daily",
      hour: 9,
      minute: 0,
      timeZone: "America/Los_Angeles",
    });
  } finally {
    await harness.close();
  }
});
