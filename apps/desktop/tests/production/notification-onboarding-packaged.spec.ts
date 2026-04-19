import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { getDesktopState, launchPackagedDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";
import { emitRunningEvent, readOptionalLog } from "../helpers/notification-events";
import { createThread, selectSessionByTitle, setSessionVisibilityOverride } from "../live/session-event-test-helpers";

async function installNotificationRequestSpy(window: Page): Promise<void> {
  await window.evaluate(() => {
    const NotificationCtor = globalThis.Notification;
    if (!NotificationCtor) {
      throw new Error("Notification API is unavailable");
    }

    let permissionState = "default";
    (globalThis as typeof globalThis & { __piNotificationRequestCount?: number }).__piNotificationRequestCount = 0;
    Object.defineProperty(NotificationCtor, "permission", {
      configurable: true,
      get: () => permissionState,
    });
    Object.defineProperty(NotificationCtor, "requestPermission", {
      configurable: true,
      value: async () => {
        (globalThis as typeof globalThis & { __piNotificationRequestCount?: number }).__piNotificationRequestCount =
          ((globalThis as typeof globalThis & { __piNotificationRequestCount?: number }).__piNotificationRequestCount ??
            0) + 1;
        permissionState = "granted";
        return permissionState;
      },
    });
  });
}

test("requests notification permission in the packaged app when active work moves to the background", async () => {
  const userDataDir = await makeUserDataDir();
  const requestLogPath = join(userDataDir, "notification-onboarding-packaged.log");
  const workspacePath = await makeWorkspace("notification-onboarding-packaged-workspace");
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_LOG_PATH: requestLogPath,
    },
  });

  try {
    const window = await harness.firstWindow();
    await installNotificationRequestSpy(window);
    const sessionA = await createThread(window, "Packaged Session A");
    await createThread(window, "Packaged Session B");
    await setSessionVisibilityOverride(harness, "active");
    await selectSessionByTitle(window, "Packaged Session A");
    await emitRunningEvent(harness, sessionA, "Packaged");

    await expect((await getDesktopState(window)).activeView).toBe("threads");
    await expect.poll(() => readOptionalLog(requestLogPath), { timeout: 5_000 }).toBe("");
    await expect
      .poll(
        () =>
          window.evaluate(
            () =>
              (globalThis as typeof globalThis & { __piNotificationRequestCount?: number }).__piNotificationRequestCount ??
              0,
          ),
        { timeout: 5_000 },
      )
      .toBe(0);

    await selectSessionByTitle(window, "Packaged Session B");
    await expect.poll(() => readOptionalLog(requestLogPath), { timeout: 5_000 }).not.toBe("");
    await expect
      .poll(
        () =>
          window.evaluate(
            () =>
              (globalThis as typeof globalThis & { __piNotificationRequestCount?: number }).__piNotificationRequestCount ??
              0,
          ),
        { timeout: 5_000 },
      )
      .toBe(1);

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Notifications", exact: true }).click();
    await expect(window.locator(".settings-view")).toContainText("Enabled");
  } finally {
    await harness.close();
  }
});
