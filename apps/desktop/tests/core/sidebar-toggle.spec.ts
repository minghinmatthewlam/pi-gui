import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const NARROW_WINDOW_WIDTH = 1200;
const NARROW_WINDOW_HEIGHT = 760;

interface SidebarLayout {
  readonly viewportWidth: number;
  readonly mainLeft: number;
  readonly mainRight: number;
  readonly mainWidth: number;
  readonly toggleRight: number;
  readonly topbarLeft: number;
  readonly topbarRight: number;
}

async function expectSidebarCollapsed(window: Page, collapsed: boolean): Promise<void> {
  await expect(window.locator(".sidebar")).toHaveCount(collapsed ? 0 : 1);
  await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(collapsed);
}

async function restoreSidebarIfNeeded(window: Page): Promise<void> {
  if ((await getDesktopState(window)).sidebarCollapsed) {
    await window.getByTestId("sidebar-toggle").click();
    await expectSidebarCollapsed(window, false);
  }
}

async function readSidebarLayout(window: Page): Promise<SidebarLayout | null> {
  return window.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".main");
    const toggle = document.querySelector<HTMLElement>("[data-testid='sidebar-toggle']");
    const topbar = document.querySelector<HTMLElement>(".topbar");
    if (!main || !toggle || !topbar) {
      return null;
    }
    const mainRect = main.getBoundingClientRect();
    const toggleRect = toggle.getBoundingClientRect();
    const topbarRect = topbar.getBoundingClientRect();
    return {
      viewportWidth: globalThis.window.innerWidth,
      mainLeft: mainRect.left,
      mainRight: mainRect.right,
      mainWidth: mainRect.width,
      toggleRight: toggleRect.right,
      topbarLeft: topbarRect.left,
      topbarRight: topbarRect.right,
    };
  });
}

async function expectToggleClearOfTopbarDragRegion(window: Page): Promise<void> {
  const layout = await readSidebarLayout(window);
  if (!layout) {
    throw new Error("Expected main, sidebar toggle, and topbar to be present");
  }
  expect(layout.toggleRight).toBeLessThanOrEqual(layout.topbarLeft);
}

async function setElectronWindowSize(
  app: Awaited<ReturnType<typeof launchDesktop>>["electronApp"],
  window: Page,
  width: number,
  height: number,
): Promise<void> {
  const didSetSize = await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        return false;
      }
      window.setSize(size.width, size.height);
      return true;
    },
    { width, height },
  );
  expect(didSetSize).toBe(true);
  await expect
    .poll(() =>
      window.evaluate(() => ({
        height: globalThis.window.innerHeight,
        width: globalThis.window.innerWidth,
      })),
    )
    .toEqual({ height, width });
}

async function writeProofScreenshot(window: Page, name: string): Promise<void> {
  const proofDir = process.env.PI_APP_SIDEBAR_PROOF_DIR;
  if (!proofDir) {
    return;
  }
  await window.screenshot({ path: join(proofDir, name), fullPage: false });
}

async function expectSecondaryTakeover(window: Page, testId: string): Promise<void> {
  await expect(window.getByTestId(testId)).toBeVisible();
  await expect(window.locator(".secondary-surface__sidebar")).toBeVisible();
  await expect(window.locator(".shell, .sidebar, .main")).toHaveCount(0);
  await expect(window.getByTestId("sidebar-toggle")).toHaveCount(0);
}

async function writeTakeoverProof(window: Page, name: string): Promise<void> {
  const proofDir = process.env.PI_APP_TAKEOVER_PROOF_DIR;
  if (proofDir) {
    await window.screenshot({ path: join(proofDir, name), fullPage: false });
  }
}

test("toggles and persists the primary sidebar from the button and keyboard shortcut", async () => {
  test.setTimeout(90_000);
  const takeoverProofDir = process.env.PI_APP_TAKEOVER_PROOF_DIR;
  if (takeoverProofDir) {
    await mkdir(takeoverProofDir, { recursive: true });
  }
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("sidebar-toggle-workspace");
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    const toggle = window.getByTestId("sidebar-toggle");
    await expect(toggle).toBeVisible();
    await expect(window.locator(".sidebar")).toBeVisible();
    const expandedMainBox = await window.locator(".main").boundingBox();
    expect(expandedMainBox).not.toBeNull();

    await toggle.click();
    await expectSidebarCollapsed(window, true);
    await expectToggleClearOfTopbarDragRegion(window);
    const collapsedMainBox = await window.locator(".main").boundingBox();
    expect(collapsedMainBox).not.toBeNull();
    expect(collapsedMainBox?.x ?? 999).toBeLessThan(expandedMainBox?.x ?? 0);
    expect(collapsedMainBox?.width ?? 0).toBeGreaterThan(expandedMainBox?.width ?? 9999);

    await toggle.click();
    await expectSidebarCollapsed(window, false);

    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, true);
    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, false);

    await window.keyboard.press(desktopShortcut("Shift+O"));
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, true);
    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, false);

    await window.keyboard.press(desktopShortcut(","));
    await expectSecondaryTakeover(window, "settings-surface");
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await window
      .locator(".settings-row", { hasText: "Light" })
      .locator('input[type="radio"]')
      .click();
    await writeTakeoverProof(window, "settings-light.png");
    await window.keyboard.press(desktopShortcut("B"));
    await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(false);
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await restoreSidebarIfNeeded(window);
    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expectSecondaryTakeover(window, "skills-surface");
    await writeTakeoverProof(window, "skills-light.png");
    await window.keyboard.press(desktopShortcut("B"));
    await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(false);
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await restoreSidebarIfNeeded(window);
    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expectSecondaryTakeover(window, "extensions-surface");
    await writeTakeoverProof(window, "extensions-light.png");
    await window.keyboard.press(desktopShortcut("B"));
    await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(false);
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await window.keyboard.press(desktopShortcut(","));
    await expectSecondaryTakeover(window, "settings-surface");
    await window
      .locator(".settings-row", { hasText: "Dark" })
      .locator('input[type="radio"]')
      .click();
    await writeTakeoverProof(window, "settings-dark.png");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expectSecondaryTakeover(window, "skills-surface");
    await writeTakeoverProof(window, "skills-dark.png");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expectSecondaryTakeover(window, "extensions-surface");
    await writeTakeoverProof(window, "extensions-dark.png");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await restoreSidebarIfNeeded(window);
    await window.getByTestId("sidebar-toggle").click();
    await expectSidebarCollapsed(window, true);
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expectSidebarCollapsed(window, true);
    await expect(window.getByTestId("sidebar-toggle")).toBeVisible();
    await expectToggleClearOfTopbarDragRegion(window);
    await window.getByTestId("sidebar-toggle").click();
    await expectSidebarCollapsed(window, false);
  } finally {
    await secondRun.close();
  }
});

test("keeps collapsed sidebar out of narrow windows and reopens from the button", async () => {
  test.setTimeout(90_000);
  const proofDir = process.env.PI_APP_SIDEBAR_PROOF_DIR;
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("sidebar-narrow-workspace");
  const run = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    ...(proofDir
      ? {
          recordVideoDir: join(proofDir, "videos"),
          recordVideoSize: { width: NARROW_WINDOW_WIDTH, height: NARROW_WINDOW_HEIGHT },
        }
      : {}),
  });
  let window: Page | undefined;

  try {
    window = await run.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await setElectronWindowSize(run.electronApp, window, NARROW_WINDOW_WIDTH, NARROW_WINDOW_HEIGHT);
    await expect(window.getByTestId("sidebar-toggle")).toBeVisible();

    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, true);
    await expectToggleClearOfTopbarDragRegion(window);
    await writeProofScreenshot(window, "narrow-sidebar-collapsed.png");

    const collapsedLayout = await readSidebarLayout(window);
    if (!collapsedLayout) {
      throw new Error(
        "Expected collapsed narrow layout to include main, topbar, and sidebar toggle",
      );
    }
    expect(collapsedLayout.viewportWidth).toBeLessThanOrEqual(NARROW_WINDOW_WIDTH);
    expect(collapsedLayout.mainLeft).toBeLessThanOrEqual(1);
    expect(collapsedLayout.mainRight).toBeGreaterThanOrEqual(collapsedLayout.viewportWidth - 1);
    expect(collapsedLayout.mainWidth).toBeGreaterThanOrEqual(collapsedLayout.viewportWidth - 1);
    expect(collapsedLayout.topbarLeft).toBeGreaterThanOrEqual(collapsedLayout.toggleRight);
    expect(collapsedLayout.topbarRight).toBeLessThanOrEqual(collapsedLayout.mainRight);

    await window.getByTestId("sidebar-toggle").click();
    await expectSidebarCollapsed(window, false);
    await expect(window.locator(".sidebar")).toBeVisible();
    const sidebarBox = await window.locator(".sidebar").boundingBox();
    const reopenedMainBox = await window.locator(".main").boundingBox();
    if (!sidebarBox || !reopenedMainBox) {
      throw new Error("Expected reopened layout to include sidebar and main regions");
    }
    expect(reopenedMainBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1);
    await writeProofScreenshot(window, "narrow-sidebar-reopened.png");
  } finally {
    await run.close();
    const video = window?.video();
    if (proofDir && video) {
      await video.saveAs(join(proofDir, "narrow-sidebar-reopen-flow.webm"));
    }
  }
});
