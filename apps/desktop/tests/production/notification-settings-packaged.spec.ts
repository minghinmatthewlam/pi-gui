import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchPackagedDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

async function readSettingsLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

test("shows notification recovery actions in the packaged app", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("notification-settings-packaged-workspace");
  const settingsLogPath = join(userDataDir, "notification-settings-packaged.log");
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_NOTIFICATION_PERMISSION_STATUS: "denied",
      PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT: "granted",
      PI_APP_TEST_NOTIFICATION_SETTINGS_LOG_PATH: settingsLogPath,
    },
  });

  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Notifications", exact: true }).click();

    await expect(window.locator(".settings-view")).toContainText("macOS notifications are turned off for pi-gui");
    await expect(window.locator(".settings-view")).toContainText(
      "pi-gui asks macOS when active work first moves into the background",
    );
    await window.getByRole("button", { name: "Open System Settings", exact: true }).click();
    await expect.poll(() => readSettingsLog(settingsLogPath), { timeout: 5_000 }).not.toBe("");

    await window.getByRole("button", { name: "Ask macOS", exact: true }).click();
    await expect(window.locator(".settings-view")).toContainText("Enabled");
  } finally {
    await harness.close();
  }
});
