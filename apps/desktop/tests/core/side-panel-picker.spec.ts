import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

test("one icon and keyboard shortcuts toggle the selected workspace tool", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("workbench-shortcuts");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Shortcut thread");
    const topbarActions = window.locator(".topbar__actions");
    const toggle = topbarActions.getByRole("button", { name: "Toggle side panel" });
    await expect(topbarActions.locator(".topbar__icon")).toHaveCount(1);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("");
    await selectSidePanel(window, "Files");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await window.getByTestId("composer").click();
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.getByTestId("file-workbench")).toBeVisible();

    await selectSidePanel(window, "Changes");
    await expect(window.locator(".diff-panel")).toBeVisible();
    await expect(window.getByTestId("file-workbench")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("D"));
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.locator(".diff-panel")).toBeVisible();

    await window.keyboard.press(desktopShortcut("B"));
    await expect(window.locator(".sidebar")).toHaveCount(0);
    await expect(window.locator(".diff-panel")).toBeVisible();
    await window.keyboard.press(desktopShortcut("B"));
    await expect(window.locator(".sidebar")).toHaveCount(1);

    await window.keyboard.press(desktopShortcut("J"));
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await expect(window.locator(".diff-panel")).toHaveCount(0);
    await terminal.locator(".xterm").click();
    const modifier = process.platform === "darwin" ? "meta" : "control";
    const pressSidePanelShortcut = () =>
      harness.electronApp.evaluate(({ BrowserWindow }, keyModifier) => {
        BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "b",
          modifiers: [keyModifier, "alt"],
        });
      }, modifier);
    await pressSidePanelShortcut();
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await pressSidePanelShortcut();
    await expect(terminal).toBeVisible();
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveCount(3);
  } finally {
    await harness.close();
  }
});
