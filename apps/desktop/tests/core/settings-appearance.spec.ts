import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("toggles and restores window transparency", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("appearance-transparency");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect.poll(() => hasTransparencyClass(window)).toBe(false);

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();

    const transparencyToggle = window.getByLabel("Window transparency");
    await expect(transparencyToggle).not.toBeChecked();
    await transparencyToggle.click();
    await expect.poll(async () => (await getDesktopState(window)).enableTransparency).toBe(true);
    await expect.poll(() => hasTransparencyClass(window)).toBe(true);
    await expect
      .poll(async () => {
        const persisted = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8")) as {
          readonly enableTransparency?: unknown;
        };
        return persisted.enableTransparency;
      })
      .toBe(true);
  } finally {
    await harness.close();
  }

  harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect.poll(async () => (await getDesktopState(window)).enableTransparency).toBe(true);
    await expect.poll(() => hasTransparencyClass(window)).toBe(true);
  } finally {
    await harness.close();
  }
});

async function hasTransparencyClass(window: { evaluate<R>(pageFunction: () => R): Promise<R> }): Promise<boolean> {
  return window.evaluate(() => document.documentElement.classList.contains("enable-transparency"));
}
