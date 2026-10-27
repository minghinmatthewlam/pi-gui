import { expect, test, type Page } from "@playwright/test";
import {
  chooseThreadGrouping,
  createSessionViaIpc,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  waitForWorkspaceByPath,
  type DesktopHarness,
} from "../helpers/electron-app";

const WINDOW_HEIGHT = 760;
/** `styles/sidebar.css` turns the sidebar into a drawer at `max-width: 760px`. */
const NARROW_WIDTHS = [560, 760] as const;

async function resizeWindow(harness: DesktopHarness, window: Page, width: number): Promise<void> {
  await harness.electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height: WINDOW_HEIGHT },
  );
  await expect.poll(() => window.evaluate(() => globalThis.window.innerWidth)).toBe(width);
}

async function expectSidebarCollapsed(window: Page, collapsed: boolean): Promise<void> {
  await expect(window.locator(".sidebar")).toHaveCount(collapsed ? 0 : 1);
  await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(collapsed);
}

/** The drawer overlays a full-width main surface, and the backdrop takes pointer input over it. */
async function expectDrawerOpen(window: Page): Promise<void> {
  await expectSidebarCollapsed(window, false);
  const backdrop = window.getByTestId("sidebar-drawer-backdrop");
  await expect(backdrop).toBeVisible();
  const layout = await window.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".main");
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    if (!main || !sidebar) return null;
    const mainRect = main.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const viewportWidth = globalThis.window.innerWidth;
    const probe = document.elementFromPoint(viewportWidth - 40, globalThis.window.innerHeight / 2);
    return {
      viewportWidth,
      mainLeft: mainRect.left,
      mainWidth: mainRect.width,
      sidebarRight: sidebarRect.right,
      probeIsBackdrop: probe?.getAttribute("data-testid") === "sidebar-drawer-backdrop",
    };
  });
  expect(layout).not.toBeNull();
  expect(layout?.mainLeft).toBeLessThanOrEqual(1);
  expect(layout?.mainWidth).toBeGreaterThanOrEqual((layout?.viewportWidth ?? 0) - 1);
  expect(layout?.sidebarRight).toBeLessThan(layout?.viewportWidth ?? 0);
  expect(layout?.probeIsBackdrop).toBe(true);
}

async function expectDrawerClosed(window: Page): Promise<void> {
  await expectSidebarCollapsed(window, true);
  await expect(window.getByTestId("sidebar-drawer-backdrop")).toHaveCount(0);
}

async function reopenDrawer(window: Page): Promise<void> {
  await window.getByTestId("sidebar-toggle").click();
  await expectDrawerOpen(window);
}

async function launchWithThreads(
  workspaceName: string,
): Promise<{ harness: DesktopHarness; window: Page }> {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace(workspaceName);
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, workspacePath);
  await createSessionViaIpc(window, workspacePath, "Drawer thread one");
  await createSessionViaIpc(window, workspacePath, "Drawer thread two");
  await selectSession(window, "Drawer thread one");
  return { harness, window };
}

for (const width of NARROW_WIDTHS) {
  test(`dismisses the narrow sidebar drawer at ${width}px`, async () => {
    test.setTimeout(90_000);
    const { harness, window } = await launchWithThreads(`sidebar-drawer-${width}`);
    try {
      await resizeWindow(harness, window, width);
      await expectDrawerOpen(window);

      // Escape closes the drawer and returns focus to the toggle.
      await window.keyboard.press("Escape");
      await expectDrawerClosed(window);
      await expect(window.getByTestId("sidebar-toggle")).toBeFocused();

      // Controls inside the drawer keep it open; Escape first closes their menu.
      await reopenDrawer(window);
      await window.getByRole("button", { name: "Customize Sidebar" }).click();
      await expect(window.getByRole("menu", { name: "Customize Sidebar" })).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(window.getByRole("menu", { name: "Customize Sidebar" })).toHaveCount(0);
      await expectDrawerOpen(window);

      // So does the workspace actions menu, which has no menu role of its own.
      await chooseThreadGrouping(window, "workspace");
      await window.getByRole("button", { name: /^Workspace actions for / }).click();
      await expect(window.locator(".workspace-menu")).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(window.locator(".workspace-menu")).toHaveCount(0);
      await expectDrawerOpen(window);

      // Clicking the backdrop closes the drawer.
      await window
        .getByTestId("sidebar-drawer-backdrop")
        .click({ position: { x: width - 40, y: WINDOW_HEIGHT / 2 } });
      await expectDrawerClosed(window);

      // Choosing a thread navigates to it and closes the drawer.
      await reopenDrawer(window);
      await selectSession(window, "Drawer thread two");
      await expectDrawerClosed(window);

      // Starting a new thread from the drawer closes it.
      await reopenDrawer(window);
      await window.locator(".sidebar").getByRole("button", { name: "New thread" }).first().click();
      await expect(window.getByTestId("new-thread-composer")).toBeVisible();
      await expectDrawerClosed(window);

      // Navigating without the sidebar (thread shortcut) also closes it.
      await reopenDrawer(window);
      await window.keyboard.press(desktopShortcut("1"));
      await expect(window.locator(".chat-header__title")).toHaveText(/Drawer thread/);
      await expectDrawerClosed(window);

      await reopenDrawer(window);
    } finally {
      await harness.close();
    }
  });
}

test("keeps the docked sidebar above the narrow breakpoint", async () => {
  test.setTimeout(90_000);
  const { harness, window } = await launchWithThreads("sidebar-drawer-docked");
  try {
    await resizeWindow(harness, window, 761);
    await expectSidebarCollapsed(window, false);
    await expect(window.getByTestId("sidebar-drawer-backdrop")).toHaveCount(0);
    const sidebarBox = await window.locator(".sidebar").boundingBox();
    const mainBox = await window.locator(".main").boundingBox();
    expect(mainBox?.x ?? 0).toBeGreaterThanOrEqual(
      (sidebarBox?.x ?? 0) + (sidebarBox?.width ?? 0) - 1,
    );

    await window.keyboard.press("Escape");
    await selectSession(window, "Drawer thread two");
    await expectSidebarCollapsed(window, false);
  } finally {
    await harness.close();
  }
});
