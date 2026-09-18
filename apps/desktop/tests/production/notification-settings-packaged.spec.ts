import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPackagedDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

async function readSettingsLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function openNotificationSettings(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Settings", exact: true }).click();
  await window.getByRole("button", { name: "Notifications", exact: true }).click();
}

test("shows not enabled yet in the packaged app and enables after Ask macOS updates the authoritative macOS status", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("notification-settings-packaged-default-workspace");
  const helperStatusFilePath = join(
    userDataDir,
    "notification-settings-packaged-default-status.txt",
  );
  await writeFile(helperStatusFilePath, "default\n", "utf8");
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS_FILE: helperStatusFilePath,
      PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_FOLLOWS_REQUEST: "1",
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT: "granted",
    },
  });

  try {
    const window = await harness.firstWindow();
    await openNotificationSettings(window);

    await expect
      .poll(() => window.evaluate(() => globalThis.window.piApp.getNotificationPermissionStatus()))
      .toBe("default");
    await expect(window.locator(".settings-view")).toContainText("Not enabled yet");
    await expect(window.getByRole("button", { name: "Ask macOS", exact: true })).toHaveCount(1);
    await expect(
      window.getByRole("button", { name: "Open System Settings", exact: true }),
    ).toHaveCount(0);

    await window.getByRole("button", { name: "Ask macOS", exact: true }).click();

    await expect
      .poll(() => window.evaluate(() => globalThis.window.piApp.getNotificationPermissionStatus()))
      .toBe("granted");
    await expect(window.locator(".settings-view")).toContainText("Enabled");
    await expect(window.getByRole("button", { name: "Ask macOS", exact: true })).toHaveCount(0);
    await expect(
      window.getByRole("button", { name: "Open System Settings", exact: true }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("keeps showing not enabled yet when Ask macOS does not change packaged macOS notification access", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace(
    "notification-settings-packaged-stale-request-workspace",
  );
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS: "default",
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT: "granted",
    },
  });

  try {
    const window = await harness.firstWindow();
    await openNotificationSettings(window);

    await expect
      .poll(() => window.evaluate(() => globalThis.window.piApp.getNotificationPermissionStatus()))
      .toBe("default");
    await expect(window.locator(".settings-view")).toContainText("Not enabled yet");

    await window.getByRole("button", { name: "Ask macOS", exact: true }).click();

    await expect
      .poll(() => window.evaluate(() => globalThis.window.piApp.getNotificationPermissionStatus()))
      .toBe("default");
    await expect(window.locator(".settings-view")).toContainText("Not enabled yet");
    await expect(window.getByRole("button", { name: "Ask macOS", exact: true })).toHaveCount(1);
    await expect(
      window.getByRole("button", { name: "Open System Settings", exact: true }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("refreshes packaged notification status after returning from System Settings", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("notification-settings-packaged-refresh-workspace");
  const helperStatusFilePath = join(
    userDataDir,
    "notification-settings-packaged-refresh-status.txt",
  );
  const settingsLogPath = join(userDataDir, "notification-settings-packaged-refresh.log");
  await writeFile(helperStatusFilePath, "denied\n", "utf8");
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS_FILE: helperStatusFilePath,
      PI_APP_TEST_NOTIFICATION_SETTINGS_LOG_PATH: settingsLogPath,
    },
  });

  try {
    const window = await harness.firstWindow();
    await harness.focusWindow();
    await openNotificationSettings(window);

    await expect
      .poll(() => window.evaluate(() => globalThis.window.piApp.getNotificationPermissionStatus()))
      .toBe("denied");
    await expect(window.locator(".settings-view")).toContainText("Turned off");
    await expect(window.getByRole("button", { name: "Ask macOS", exact: true })).toHaveCount(0);
    await expect(
      window.getByRole("button", { name: "Open System Settings", exact: true }),
    ).toHaveCount(1);

    await window.getByRole("button", { name: "Open System Settings", exact: true }).click();
    await expect.poll(() => readSettingsLog(settingsLogPath), { timeout: 5_000 }).not.toBe("");

    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      const appWindow = BrowserWindow.getAllWindows()[0];
      appWindow?.hide();
    });
    await writeFile(helperStatusFilePath, "granted\n", "utf8");
    await harness.focusWindow();

    await expect
      .poll(() => window.evaluate(() => globalThis.window.piApp.getNotificationPermissionStatus()))
      .toBe("granted");
    await expect(window.locator(".settings-view")).toContainText("Enabled");
    await expect(window.getByRole("button", { name: "Ask macOS", exact: true })).toHaveCount(0);
    await expect(
      window.getByRole("button", { name: "Open System Settings", exact: true }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
