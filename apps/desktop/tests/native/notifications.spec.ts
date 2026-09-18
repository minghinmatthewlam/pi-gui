import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";
import { emitCompletedEvent, emitRunningEvent } from "../helpers/notification-events";
import {
  createThread,
  selectSessionByTitle,
  setSessionVisibilityOverride,
} from "../helpers/session-event-test-helpers";

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
