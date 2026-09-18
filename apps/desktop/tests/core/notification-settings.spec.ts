import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

async function readSettingsLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

test("shows not enabled yet and enables via Ask macOS", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("notification-settings-default-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_STATUS: "default",
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT: "granted",
    },
  });

  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Notifications", exact: true }).click();

    await expect(window.locator(".settings-view")).toContainText("Not enabled yet");
    await expect(window.getByRole("button", { name: "Ask macOS", exact: true })).toHaveCount(1);
    await expect(
      window.getByRole("button", { name: "Open System Settings", exact: true }),
    ).toHaveCount(0);

    await window.getByRole("button", { name: "Ask macOS", exact: true }).click();

    await expect(window.locator(".settings-view")).toContainText("Enabled");
    await expect(window.getByRole("button", { name: "Ask macOS", exact: true })).toHaveCount(0);
    await expect(
      window.getByRole("button", { name: "Open System Settings", exact: true }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("shows turned off and opens System Settings when macOS notifications are denied", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("notification-settings-denied-workspace");
  const settingsLogPath = join(userDataDir, "notification-settings.log");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_STATUS: "denied",
      PI_APP_TEST_NOTIFICATION_SETTINGS_LOG_PATH: settingsLogPath,
    },
  });

  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Notifications", exact: true }).click();

    await expect(window.locator(".settings-view")).toContainText("Turned off");
    await expect(window.locator(".settings-view")).toContainText(
      "macOS notifications are turned off for pi-gui",
    );
    await expect(window.getByRole("button", { name: "Ask macOS", exact: true })).toHaveCount(0);
    await expect(
      window.getByRole("button", { name: "Open System Settings", exact: true }),
    ).toHaveCount(1);

    await window.getByRole("button", { name: "Open System Settings", exact: true }).click();
    await expect.poll(() => readSettingsLog(settingsLogPath), { timeout: 5_000 }).not.toBe("");
  } finally {
    await harness.close();
  }
});
