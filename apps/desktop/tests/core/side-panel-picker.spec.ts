import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
  createNamedThread,
  desktopShortcut,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

async function itemBoxes(menu: Locator): Promise<{ x: number; y: number }[]> {
  return menu.getByRole("menuitem").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y };
    }),
  );
}

async function openPicker(window: Page): Promise<Locator> {
  await window.getByRole("button", { name: "Open side panel" }).click();
  const menu = window.getByTestId("side-panel-picker-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("toggles the last side panel and switches from a vertical menu", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("side-panel-picker");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await writeFile(join(workspacePath, "README.md"), "# side-panel-picker\nchanged\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Picker thread");

    const files = window.getByTestId("file-workbench");
    const changes = window.locator(".diff-panel");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(files).toHaveCount(0);
    await expect(changes).toHaveCount(0);

    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(files).toBeVisible();
    await expect(changes).toHaveCount(0);
    await expect(window.locator(".sidebar")).toHaveCount(1);

    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(files).toHaveCount(0);

    await window.keyboard.press(desktopShortcut("D"));
    await expect(changes).toBeVisible();
    await expect(changes.locator(".diff-panel__title")).toContainText("Changes");
    await window.keyboard.press(desktopShortcut("D"));
    await expect(changes).toHaveCount(0);

    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(changes).toBeVisible();
    await expect(files).toHaveCount(0);

    await window.keyboard.press(desktopShortcut("B"));
    await expect(window.locator(".sidebar")).toHaveCount(0);
    await expect(changes).toBeVisible();
    await window.keyboard.press(desktopShortcut("B"));
    await expect(window.locator(".sidebar")).toHaveCount(1);

    const menu = await openPicker(window);
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Files");
    await expect(items.nth(1)).toContainText("Changes");
    await expect(items.nth(2)).toContainText("Terminal");
    await expect(menu).not.toContainText(/Review|Browser|Side chat/);
    const boxes = await itemBoxes(menu);
    expect(boxes).toHaveLength(3);
    expect(boxes[0]?.y ?? 0).toBeLessThan(boxes[1]?.y ?? 0);
    expect(boxes[1]?.y ?? 0).toBeLessThan(boxes[2]?.y ?? 0);
    expect(Math.abs((boxes[0]?.x ?? 0) - (boxes[1]?.x ?? 0))).toBeLessThan(2);
    expect(Math.abs((boxes[1]?.x ?? 0) - (boxes[2]?.x ?? 0))).toBeLessThan(2);

    await menu.getByRole("menuitem", { name: /^Files/ }).click();
    await expect(menu).toHaveCount(0);
    await expect(files).toBeVisible();
    await expect(changes).toHaveCount(0);

    const changesMenu = await openPicker(window);
    await changesMenu.getByRole("menuitem", { name: /^Changes/ }).click();
    await expect(changes).toBeVisible();
    await expect(files).toHaveCount(0);

    const terminalMenu = await openPicker(window);
    await terminalMenu.getByRole("menuitem", { name: /^Terminal/ }).click();
    await expect(terminal).toBeVisible();
    await expect(changes).toBeVisible();
  } finally {
    await harness.close();
  }
});
