import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
} from "../helpers/electron-app";

test("supports keyboard shortcuts, slash menus, and topbar controls through the user surface", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("controls-workspace");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Controls session");
    await expect(window.locator(".topbar__session")).toHaveText("Controls session");

    const composer = window.getByTestId("composer");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await expect(window.locator(".view-header__title")).toContainText("General");

    await window.keyboard.press(desktopShortcut("Shift+O"));
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    await expect(window.getByTestId("new-thread-composer")).toBeFocused();

    await selectSession(window, "Controls session");
    await expect(composer).toBeFocused();

    await composer.fill("/st");
    const slashMenu = window.getByTestId("slash-menu");
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu).toContainText("Status");
    const slashMenuBox = await slashMenu.boundingBox();
    const composerBox = await composer.boundingBox();
    expect(slashMenuBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect((slashMenuBox?.y ?? 0) + (slashMenuBox?.height ?? 0)).toBeLessThanOrEqual((composerBox?.y ?? 0) + 2);

    await composer.press("Tab");
    await expect(slashMenu).toHaveCount(0);
    await expect(composer).toHaveValue("/status");
    await composer.press("Enter");
    await expect(window.getByTestId("transcript")).toContainText(/Model |No session overrides set/);
    await expect(composer).toHaveValue("");

    await composer.fill("/thinking");
    const optionsMenu = window.getByTestId("slash-options-menu");
    await expect(optionsMenu).toBeVisible();
    await expect(optionsMenu).toContainText("Low");
    await expect(optionsMenu).toContainText("Extra High");
    await composer.press("ArrowDown");
    await composer.press("ArrowDown");
    await composer.press("Enter");
    await expect(optionsMenu).toHaveCount(0);
    await expect(window.getByTestId("transcript")).toContainText("Thinking set to high");
    await expect(window.locator(".composer__hint")).toContainText("high");

    const selectedWorkspaceId = (await getDesktopState(window)).selectedWorkspaceId;
    expect(selectedWorkspaceId).toBeTruthy();
    await window.evaluate(async ({ workspaceId }) => {
      const app = window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.setScopedModelPatterns(workspaceId, ["fake-provider/fake-model"]);
    }, { workspaceId: selectedWorkspaceId });

    await composer.fill("/model");
    await expect(optionsMenu).toBeVisible();
    await expect(optionsMenu).toContainText("No models available");
    await expect(optionsMenu).toContainText("Open Settings to enable a model or log in to a provider.");
    await composer.fill("continue");
    await expect(optionsMenu).toHaveCount(0);

    const appRegions = await window.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>("[data-testid='topbar']");
      const addFolder = document.querySelector<HTMLElement>(".topbar__actions button");
      return {
        topbar: topbar ? getComputedStyle(topbar).getPropertyValue("-webkit-app-region") : "",
        addFolder: addFolder ? getComputedStyle(addFolder).getPropertyValue("-webkit-app-region") : "",
      };
    });
    expect(appRegions.topbar).toBe("drag");
    expect(appRegions.addFolder).toBe("no-drag");

    const maximizedBefore = await harness.electronApp.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false;
    });
    await window.getByTestId("topbar").dblclick({ position: { x: 140, y: 12 } });
    await expect
      .poll(() =>
        harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false),
      )
      .toBe(!maximizedBefore);
  } finally {
    await harness.close();
  }
});
