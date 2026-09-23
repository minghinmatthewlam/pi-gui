import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  spawnDesktopProcess,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("ignores persisted multiple app instance opt-in and hides the setting", async () => {
  const userDataDir = await makeUserDataDir();
  await writeFile(
    join(userDataDir, "ui-state.json"),
    `${JSON.stringify({ allowMultiple: true }, null, 2)}\n`,
    "utf8",
  );
  const workspacePath = await makeWorkspace("allow-multiple-instances-disabled");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let secondProcess: ChildProcess | undefined;

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await expect
      .poll(async () => harness.electronApp.evaluate(({ app }) => app.hasSingleInstanceLock()))
      .toBe(true);
    secondProcess = await spawnDesktopProcess(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });
    await expect(await waitForProcessExit(secondProcess)).toEqual({ code: 0, signal: null });
    await expect
      .poll(async () =>
        harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      )
      .toBe(1);
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(join(userDataDir, "ui-state.json"), "utf8"),
        ) as {
          readonly allowMultiple?: unknown;
        };
        return persisted.allowMultiple;
      })
      .toBeUndefined();

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();
    await expect(window.getByLabel("Shell of integrated terminal")).toBeVisible();
    await expect(window.getByText("Allow multiple app instances")).toHaveCount(0);
    await expect(window.getByLabel("Allow multiple app instances")).toHaveCount(0);
  } finally {
    if (secondProcess && secondProcess.exitCode === null && secondProcess.signalCode === null) {
      secondProcess.kill();
    }
    await harness.close();
  }
});

test("settings nav search filters sections, opens the first match and clears on Escape", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("settings-nav-search");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.keyboard.press(desktopShortcut(","));
    const surface = window.getByTestId("settings-surface");
    await expect(surface).toBeVisible();
    const nav = surface.getByRole("navigation", { name: "Settings sections" });
    const search = surface.getByLabel("Search settings");

    await search.fill("dark");
    await expect(nav.getByRole("button")).toHaveText(["Appearance"]);
    await search.press("Enter");
    await expect(window.locator(".view-header__title")).toHaveText("Appearance");

    await search.fill("zzz");
    await expect(nav.getByRole("button")).toHaveCount(0);
    await expect(nav).toContainText("No matches");

    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(surface).toBeVisible();
    await expect(nav.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();

    await search.press("Escape");
    await expect(surface).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs = 15_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for second app process to exit")),
          timeoutMs,
        );
      }),
    ]);
    const [code, signal] = result as [number | null, NodeJS.Signals | null];
    return { code, signal };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
