import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

const isMac = process.platform === "darwin";
/** Control on macOS, where Command switches threads, and Alt elsewhere. */
const tabModifier = isMac ? "Control" : "Alt";
const tabLabel = (slot: number) => `${isMac ? "⌃" : "Alt+"}${slot}`;

test("Control or Alt with 1-9 selects side panel tabs while Cmd or Ctrl keeps switching threads", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("side-panel-tab-shortcuts");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const title = window.locator(".chat-header__title");
    await createNamedThread(window, "Tab Alpha");
    await createNamedThread(window, "Tab Bravo");
    await selectSidePanel(window, "Files");
    await selectSidePanel(window, "Terminal");
    const tabs = window.getByRole("tablist", { name: "Workspace tools" });
    const tab = (name: string) => tabs.getByRole("tab", { name, exact: true });
    await expect(tabs.getByRole("tab")).toHaveCount(3);
    await expect(tab("Review")).toHaveAttribute("title", `Review (${tabLabel(1)})`);
    await expect(tab("Files")).toHaveAttribute("title", `Files (${tabLabel(2)})`);

    // Renderer keydown path, from the composer.
    const composer = window.getByTestId("composer");
    await composer.click();
    await window.keyboard.press(`${tabModifier}+1`);
    await expect(tab("Review")).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press(`${tabModifier}+2`);
    await expect(tab("Files")).toHaveAttribute("aria-selected", "true");
    await expect(title).toHaveText("Tab Bravo");
    // No tab 5: nothing changes.
    await window.keyboard.press(`${tabModifier}+5`);
    await expect(tab("Files")).toHaveAttribute("aria-selected", "true");

    // Holding the tab modifier shows the tab numbers until it is released.
    await composer.click();
    await window.keyboard.down(tabModifier);
    await expect(tabs.locator("[data-tab-shortcut]")).toHaveCount(3);
    await expect(tab("Terminal").locator(".workbench__tab-shortcut")).toHaveText(tabLabel(3));
    await window.keyboard.press("3");
    await expect(tab("Terminal")).toHaveAttribute("aria-selected", "true");
    await expect(tabs.locator("[data-tab-shortcut]")).toHaveCount(3);
    await window.keyboard.up(tabModifier);
    await expect(tabs.locator("[data-tab-shortcut]")).toHaveCount(0);

    // A hidden side panel opens on the chosen tab.
    await composer.click();
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await window.keyboard.press(`${tabModifier}+1`);
    await expect(tab("Review")).toHaveAttribute("aria-selected", "true");

    // Main-process path, from inside the terminal, which is itself a side panel tab.
    await tab("Terminal").click();
    const terminal = window.getByTestId("integrated-terminal");
    await terminal.locator(".xterm").click();
    const sendDigit = (keyCode: string, modifiers: string[]) =>
      harness.electronApp.evaluate(
        ({ BrowserWindow }, input) => {
          BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: input.keyCode,
            modifiers: input.modifiers as Electron.InputEvent["modifiers"],
          });
        },
        { keyCode, modifiers },
      );
    const mainModifier = isMac ? "control" : "alt";
    await window.evaluate(() => {
      const review = document.querySelector('[data-testid="workbench-tab-changes"]');
      const record = window as unknown as { reviewSelected?: boolean };
      record.reviewSelected = false;
      new MutationObserver(() => {
        if (review?.getAttribute("aria-selected") === "true") record.reviewSelected = true;
      }).observe(review!, { attributes: true, attributeFilter: ["aria-selected"] });
    });
    // Auto-repeat from a held chord is ignored; the next real press still acts.
    await sendDigit("1", [mainModifier, "isAutoRepeat"]);
    await sendDigit("2", [mainModifier]);
    await expect(tab("Files")).toHaveAttribute("aria-selected", "true");
    expect(
      await window.evaluate(
        () => (window as unknown as { reviewSelected?: boolean }).reviewSelected,
      ),
    ).toBe(false);
    await sendDigit("1", [mainModifier]);
    await expect(tab("Review")).toHaveAttribute("aria-selected", "true");

    // Cmd+1-9 on macOS and Ctrl+1-9 elsewhere still switch threads.
    await composer.click();
    await window.keyboard.press(desktopShortcut("2"));
    await expect(title).toHaveText("Tab Alpha");

    await window.keyboard.press(desktopShortcut(","));
    await window.getByRole("button", { name: "Keyboard shortcuts" }).click();
    const row = window.locator(".settings-row", { hasText: "Switch to side panel tab" });
    await expect(row.locator("kbd")).toHaveText([isMac ? "⌃" : "Alt", "1–9"]);
  } finally {
    await harness.close();
  }
});
