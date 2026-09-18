import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";
import { emitRunningEvent, readOptionalLog } from "../helpers/notification-events";
import {
  createThread,
  selectSessionByTitle,
  setSessionVisibilityOverride,
} from "../helpers/session-event-test-helpers";

test("requests notification permission when the user minimizes a running session window", async () => {
  const userDataDir = await makeUserDataDir();
  const requestLogPath = join(userDataDir, "notification-onboarding-minimize.log");
  const workspacePath = await makeWorkspace("notification-onboarding-minimize-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_STATUS: "default",
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT: "granted",
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_LOG_PATH: requestLogPath,
    },
  });

  try {
    const window = await harness.firstWindow();
    await setSessionVisibilityOverride(harness, "active");
    const session = await createThread(window, "Onboarding Minimize Session");
    await selectSessionByTitle(window, "Onboarding Minimize Session");
    await emitRunningEvent(harness, session, "Minimize");

    await expect.poll(() => readOptionalLog(requestLogPath), { timeout: 5_000 }).toBe("");
    await setSessionVisibilityOverride(harness, null);
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      const appWindow = BrowserWindow.getAllWindows()[0];
      appWindow?.minimize();
    });
    await expect.poll(() => readOptionalLog(requestLogPath), { timeout: 5_000 }).not.toBe("");
  } finally {
    await harness.close();
  }
});
