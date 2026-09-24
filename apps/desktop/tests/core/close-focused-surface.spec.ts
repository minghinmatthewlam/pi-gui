import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
  type DesktopHarness,
} from "../helpers/electron-app";

async function openWindowCount(harness: DesktopHarness): Promise<number> {
  try {
    return await harness.electronApp.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
  } catch {
    return 0;
  }
}

async function pressCloseShortcut(harness: DesktopHarness): Promise<void> {
  const modifier = process.platform === "darwin" ? "meta" : "control";
  await harness.electronApp.evaluate(({ BrowserWindow }, keyModifier) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "w",
      modifiers: [keyModifier],
    });
  }, modifier);
}

async function expectFocusWithin(window: Page, selector: string): Promise<void> {
  await expect
    .poll(() =>
      window.evaluate((rootSelector) => {
        const active = document.activeElement;
        return Boolean(active?.closest(rootSelector));
      }, selector),
    )
    .toBe(true);
}

test("Ctrl or Cmd+W closes the focused Files, Review, or Terminal surface", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("close-focused-surface");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Close surface thread");
    const files = window.getByTestId("file-workbench");
    const changes = window.locator(".diff-panel");
    const terminal = window.getByTestId("integrated-terminal");

    await selectSidePanel(window, "Files");
    await expect(files).toBeVisible();
    await files.locator(".file-workbench__tree-row--file").first().click();
    await expectFocusWithin(window, "[data-testid='file-workbench']");
    await pressCloseShortcut(harness);
    await expect(files).toHaveCount(0);
    await expect.poll(() => openWindowCount(harness)).toBe(1);

    await selectSidePanel(window, "Review");
    await expect(changes).toBeVisible();
    const refresh = changes.getByRole("button", { name: "Refresh" });
    await expect(refresh).toBeEnabled();
    await refresh.focus();
    await expectFocusWithin(window, ".diff-panel");
    await pressCloseShortcut(harness);
    await expect(changes).toHaveCount(0);
    await expect.poll(() => openWindowCount(harness)).toBe(1);

    await selectSidePanel(window, "Review");
    await selectSidePanel(window, "Terminal");
    await expect(changes).toHaveCount(0);
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await expectFocusWithin(window, "[data-pi-terminal]");
    await pressCloseShortcut(harness);
    await expect(terminal).toHaveCount(0);
    await expect(changes).toBeVisible();
    await expect.poll(() => openWindowCount(harness)).toBe(1);

    const refreshAgain = changes.getByRole("button", { name: "Refresh" });
    await expect(refreshAgain).toBeEnabled();
    await refreshAgain.focus();
    await expectFocusWithin(window, ".diff-panel");
    await pressCloseShortcut(harness);
    await expect(changes).toHaveCount(0);
    await expect.poll(() => openWindowCount(harness)).toBe(1);
  } finally {
    await harness.close();
  }
});

test("Ctrl or Cmd+W in the chat leaves the side panel open", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("close-focused-chat");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Close window thread");
    await selectSidePanel(window, "Files");
    const files = window.getByTestId("file-workbench");
    await expect(files).toBeVisible();
    await window.evaluate(() => {
      const marker = window as Window & { __closeKeySeen?: boolean };
      marker.__closeKeySeen = false;
      document.addEventListener(
        "keydown",
        (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
            marker.__closeKeySeen = true;
          }
        },
        { capture: true },
      );
    });
    await window.getByTestId("composer").click();
    await expectFocusWithin(window, "[data-testid='composer']");
    await pressCloseShortcut(harness);
    await expect.poll(() => openWindowCount(harness)).toBe(1);
    await expect(files).toBeVisible();
    await expect
      .poll(() =>
        window.evaluate(() => (window as Window & { __closeKeySeen?: boolean }).__closeKeySeen),
      )
      .toBe(true);
  } finally {
    await harness.close().catch(() => undefined);
  }
});
