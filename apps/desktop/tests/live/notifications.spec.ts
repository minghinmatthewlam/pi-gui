import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";
import {
  emitAttentionRequest,
  emitCompletedEvent,
  emitFailedEvent,
  emitRunningEvent,
  readOptionalLog,
} from "../helpers/notification-events";
import { createThread, selectSessionByTitle, setSessionVisibilityOverride } from "./session-event-test-helpers";

test("does not log a notification or blue dot for a focused selected session completion", async () => {
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, "notifications.jsonl");
  const workspacePath = await makeWorkspace("notifications-focused-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const session = await createThread(window, "Focused Session");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Focused Session");

    const row = window.locator(".session-row", { hasText: "Focused Session" });
    const runId = await emitRunningEvent(harness, session, "Focused");
    await emitCompletedEvent(harness, session, "Focused", runId);

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces[0]?.sessions.find((entry) => entry.title === "Focused Session")?.status ?? "";
      })
      .toBe("idle");

    await expect(row).toHaveAttribute("data-sidebar-indicator", "none");
    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 5_000 }).toBe("");
  } finally {
    await harness.close();
  }
});

test("logs a completion notification and blue dot for a focused different session", async () => {
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, "notifications.jsonl");
  const workspacePath = await makeWorkspace("notifications-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const sessionA = await createThread(window, "Session A");
    await createThread(window, "Session B");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Session A");
    await selectSessionByTitle(window, "Session B");

    const runId = await emitRunningEvent(harness, sessionA, "Completion");
    await emitCompletedEvent(harness, sessionA, "Completion", runId);

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces[0]?.sessions.find((entry) => entry.title === "Session A")?.status ?? "";
      })
      .toBe("idle");

    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 }).toContain("Session A");
    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 }).toContain(
      '"body":"Agent finished responding"',
    );
    await expect(window.locator(".session-row", { hasText: "Session A" })).toHaveAttribute(
      "data-sidebar-indicator",
      "unseen",
    );
    await expect(window.locator(".session-row", { hasText: "Session B" })).toHaveAttribute(
      "data-sidebar-indicator",
      "none",
    );
  } finally {
    await harness.close();
  }
});

test("logs a completion notification and blue dot for a selected session after the window is hidden", async () => {
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, "notifications-hidden.jsonl");
  const workspacePath = await makeWorkspace("notifications-hidden-selected-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const session = await createThread(window, "Selected Session");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Selected Session");
    await setSessionVisibilityOverride(harness, "inactive");

    const row = window.locator(".session-row", { hasText: "Selected Session" });
    const runId = await emitRunningEvent(harness, session, "Hidden");
    await emitCompletedEvent(harness, session, "Hidden", runId);

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces[0]?.sessions.find((entry) => entry.title === "Selected Session")?.status ?? "";
      })
      .toBe("idle");

    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 }).toContain("Selected Session");
    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 }).toContain(
      '"body":"Agent finished responding"',
    );
    await expect(row).toHaveAttribute("data-sidebar-indicator", "unseen");
  } finally {
    await harness.close();
  }
});

test("logs a failure notification and blue dot for a focused different session", async () => {
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, "notifications-failed.jsonl");
  const workspacePath = await makeWorkspace("notifications-failed-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const sessionA = await createThread(window, "Failed Session A");
    await createThread(window, "Failed Session B");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Failed Session A");
    await selectSessionByTitle(window, "Failed Session B");

    await emitFailedEvent(harness, sessionA, "Failure", "The run failed");

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces[0]?.sessions.find((entry) => entry.title === "Failed Session A")?.status ?? "";
      })
      .toBe("failed");

    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 }).toContain("Failed Session A");
    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 }).toContain("The run failed");
    await expect(window.locator(".session-row", { hasText: "Failed Session A" })).toHaveAttribute(
      "data-sidebar-indicator",
      "unseen",
    );
  } finally {
    await harness.close();
  }
});

test("logs an attention-needed notification and blue dot for a focused different session", async () => {
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, "notifications-attention.jsonl");
  const workspacePath = await makeWorkspace("notifications-attention-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const sessionA = await createThread(window, "Attention Session A");
    await createThread(window, "Attention Session B");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Attention Session A");
    await selectSessionByTitle(window, "Attention Session B");

    await emitAttentionRequest(harness, sessionA, "Attention", "Needs your approval");

    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 }).toContain("Attention Session A");
    await expect.poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 }).toContain(
      "Needs your approval",
    );
    await expect(window.locator(".session-row", { hasText: "Attention Session A" })).toHaveAttribute(
      "data-sidebar-indicator",
      "running",
    );
  } finally {
    await harness.close();
  }
});

test("clears a selected session blue dot when the window regains focus", async () => {
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, "notifications-refocus.jsonl");
  const workspacePath = await makeWorkspace("notifications-refocus-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const session = await createThread(window, "Refocus Session");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Refocus Session");
    await setSessionVisibilityOverride(harness, null);
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      const appWindow = BrowserWindow.getAllWindows()[0];
      appWindow?.minimize();
    });
    await expect
      .poll(() =>
        harness.electronApp.evaluate(({ BrowserWindow }) => {
          const appWindow = BrowserWindow.getAllWindows()[0];
          return {
            focused: appWindow?.isFocused() ?? false,
            minimized: appWindow?.isMinimized() ?? false,
          };
        }),
      )
      .toEqual({ focused: false, minimized: true });

    const row = window.locator(".session-row", { hasText: "Refocus Session" });
    const runId = await emitRunningEvent(harness, session, "Refocus");
    await emitCompletedEvent(harness, session, "Refocus", runId);

    await expect(row).toHaveAttribute("data-sidebar-indicator", "unseen");

    await harness.focusWindow();

    await expect(row).toHaveAttribute("data-sidebar-indicator", "none");
  } finally {
    await harness.close();
  }
});
