import { expect, test, type Page } from "@playwright/test";
import { desktopIpc } from "../../contracts/ipc";
import {
  HYDRATE_TEST_SENTINEL,
  createNamedThread,
  desktopShortcut,
  installIpcInvokeControl,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  reloadDesktopRenderer,
  waitForWorkspaceByPath,
  type DesktopHarness,
} from "../helpers/electron-app";

/**
 * Linux windows are frameless, so the app draws one title bar with minimize,
 * maximize and close above every screen. macOS and Windows keep native chrome
 * and must not get it.
 */
const drawsWindowControls = process.platform === "linux";

async function expectWindowControls(window: Page): Promise<void> {
  const titlebar = window.getByTestId("window-titlebar");
  if (!drawsWindowControls) {
    await expect(titlebar).toHaveCount(0);
    return;
  }
  await expect(titlebar.getByRole("button", { name: "Minimize window" })).toBeVisible();
  await expect(titlebar.getByRole("button", { name: "Maximize or restore window" })).toBeVisible();
  await expect(titlebar.getByRole("button", { name: "Close window" })).toBeVisible();
  // Pinned to the top-right corner of the window, whatever the screen shows.
  const position = await window.evaluate(() => {
    const close = document.querySelector('[aria-label="Close window"]')?.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="window-titlebar"]')?.getBoundingClientRect();
    return {
      closeRight: close?.right,
      barTop: bar?.top,
      barWidth: bar?.width,
      windowWidth: document.documentElement.clientWidth,
    };
  });
  expect(position.barTop).toBe(0);
  expect(position.barWidth).toBe(position.windowWidth);
  expect(position.closeRight).toBe(position.windowWidth);
}

function isWindow(harness: DesktopHarness, state: "maximized" | "minimized") {
  return harness.electronApp.evaluate(({ BrowserWindow }, state) => {
    const window = BrowserWindow.getAllWindows()[0];
    return state === "maximized" ? window?.isMaximized() : window?.isMinimized();
  }, state);
}

test("every screen has window controls on Linux and none elsewhere", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("window-controls-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Window controls session");
    await expectWindowControls(window);

    // Dialogs open below the bar, so it never covers their content.
    await window.keyboard.press(desktopShortcut("K"));
    await expect(window.getByTestId("command-palette")).toBeVisible();
    const backdropTop = await window
      .locator(".command-palette-backdrop")
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(backdropTop).toBe(drawsWindowControls ? 32 : 0);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("command-palette")).toHaveCount(0);

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await expectWindowControls(window);
    await window.getByRole("button", { name: "Back to app" }).click();

    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(window.getByTestId("skills-surface")).toBeVisible();
    await expectWindowControls(window);
    await window.getByRole("button", { name: "Back to app" }).click();

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expect(window.getByTestId("extensions-surface")).toBeVisible();
    await expectWindowControls(window);
    await window.getByRole("button", { name: "Back to app" }).click();
    await expect(window.getByTestId("composer")).toBeVisible();

    // Startup failure and the crash fallback replace the whole app.
    await installIpcInvokeControl(harness, desktopIpc.stateRequest, { mode: "reject" });
    await reloadDesktopRenderer(window);
    await expect(window.getByTestId("shell-status-card")).toHaveAttribute("data-status", "failed");
    await expectWindowControls(window);

    await installIpcInvokeControl(harness, desktopIpc.stateRequest, {
      mode: "replace",
      replacement: { revision: 1, lastError: HYDRATE_TEST_SENTINEL },
    });
    await reloadDesktopRenderer(window);
    await expect(window.getByTestId("shell-status-card")).toHaveAttribute("data-status", "crashed");
    await expectWindowControls(window);

    if (!drawsWindowControls) {
      return;
    }

    // The menu bar is hidden, but the application menu stays so its edit
    // accelerators keep working.
    const menuState = await harness.electronApp.evaluate(({ BrowserWindow, Menu }) => {
      const roles: string[] = [];
      const collect = (items: Electron.MenuItem[]) => {
        for (const item of items) {
          if (item.role) roles.push(item.role.toLowerCase());
          if (item.submenu) collect(item.submenu.items);
        }
      };
      collect(Menu.getApplicationMenu()?.items ?? []);
      return { roles, menuBarVisible: BrowserWindow.getAllWindows()[0]?.isMenuBarVisible() };
    });
    expect(menuState.roles).toEqual(
      expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectall"]),
    );
    expect(menuState.menuBarVisible).toBe(false);

    const titlebar = window.getByTestId("window-titlebar");
    const maximizedBefore = await isWindow(harness, "maximized");
    await titlebar.getByRole("button", { name: "Maximize or restore window" }).click();
    await expect.poll(() => isWindow(harness, "maximized")).toBe(!maximizedBefore);

    await titlebar.getByRole("button", { name: "Minimize window" }).click();
    await expect.poll(() => isWindow(harness, "minimized")).toBe(true);
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.restore();
    });

    const windowClosed = window.waitForEvent("close");
    await titlebar.getByRole("button", { name: "Close window" }).click();
    await windowClosed;
  } finally {
    await harness.close();
  }
});
