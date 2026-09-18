import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { emitRunningEvent, readOptionalLog } from "../helpers/notification-events";
import {
  createThread,
  selectSessionByTitle,
  setSessionVisibilityOverride,
} from "../live/session-event-test-helpers";

test("requests notification permission in the packaged app when active work moves to the background", async () => {
  const userDataDir = await makeUserDataDir();
  const requestLogPath = join(userDataDir, "notification-onboarding-packaged.log");
  const helperStatusFilePath = join(userDataDir, "notification-onboarding-packaged-status.txt");
  const workspacePath = await makeWorkspace("notification-onboarding-packaged-workspace");
  await writeFile(helperStatusFilePath, "default\n", "utf8");
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS_FILE: helperStatusFilePath,
      PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_FOLLOWS_REQUEST: "1",
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT: "granted",
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_LOG_PATH: requestLogPath,
    },
  });

  try {
    const window = await harness.firstWindow();
    await expect
      .poll(() => window.evaluate(() => globalThis.window.piApp.getNotificationPermissionStatus()))
      .toBe("default");
    const sessionA = await createThread(window, "Packaged Session A");
    await createThread(window, "Packaged Session B");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Packaged Session A");
    await emitRunningEvent(harness, sessionA, "Packaged");

    await expect((await getDesktopState(window)).activeView).toBe("threads");
    await expect.poll(() => readOptionalLog(requestLogPath), { timeout: 5_000 }).toBe("");

    await selectSessionByTitle(window, "Packaged Session B");
    await expect.poll(() => readOptionalLog(requestLogPath), { timeout: 5_000 }).not.toBe("");

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Notifications", exact: true }).click();
    await expect(window.locator(".settings-view")).toContainText("Enabled");
  } finally {
    await harness.close();
  }
});
