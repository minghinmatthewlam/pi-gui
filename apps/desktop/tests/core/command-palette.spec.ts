import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

function palette(window: Page) {
  return window.getByTestId("command-palette");
}

function paletteOptions(window: Page) {
  return palette(window).getByRole("option");
}

async function openPalette(window: Page, key: "K" | "P"): Promise<void> {
  await window.keyboard.press(desktopShortcut(key));
  await expect(palette(window)).toBeVisible();
  await expect(window.getByTestId("command-palette-input")).toBeFocused();
}

test("Cmd/Ctrl+K finds chats and actions, Cmd/Ctrl+P opens files", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("command-palette");
  await mkdir(join(workspacePath, "docs"), { recursive: true });
  await writeFile(join(workspacePath, "docs", "beta-notes.md"), "# Beta notes\n", "utf8");
  await writeFile(join(workspacePath, "alpha.ts"), "export const alpha = 1;\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Alpha planning thread");
    await createNamedThread(window, "Beta review thread");
    const title = window.locator(".chat-header__title");
    await expect(title).toHaveText("Beta review thread");

    // Recents list every workspace's threads, most recent first, then actions.
    await openPalette(window, "K");
    const recents = palette(window).getByRole("group", { name: "Recents" });
    await expect(recents.getByRole("option")).toHaveText([
      /Beta review thread.*Current/,
      /Alpha planning thread/,
    ]);
    await expect(palette(window).getByRole("group", { name: "Actions" })).toContainText(
      "New thread",
    );

    // Typing ranks chat titles; Enter opens the highlighted one.
    await window.keyboard.type("alpha plan");
    await expect(paletteOptions(window).first()).toContainText("Alpha planning thread");
    await expect(paletteOptions(window).first()).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("Enter");
    await expect(palette(window)).toHaveCount(0);
    await expect(title).toHaveText("Alpha planning thread");
    await expect(window.getByTestId("composer")).toBeFocused();

    // Tab cycles the filter tabs; Escape closes. Cmd/Ctrl+K again toggles it closed.
    await openPalette(window, "K");
    await window.keyboard.press("Tab");
    await window.keyboard.press("Tab");
    await expect(palette(window).getByRole("tab", { name: "Workspaces" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(paletteOptions(window)).toHaveText([/command-palette/]);
    await window.keyboard.press("Escape");
    await expect(palette(window)).toHaveCount(0);
    await openPalette(window, "K");
    await window.keyboard.press(desktopShortcut("K"));
    await expect(palette(window)).toHaveCount(0);

    // Actions run from the palette, and the palette also works over Settings.
    await openPalette(window, "K");
    await window.keyboard.type("appearance");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await expect(window.locator(".view-header__title")).toHaveText("Appearance");
    await openPalette(window, "K");
    await window.keyboard.type("beta review");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("settings-surface")).toHaveCount(0);
    await expect(title).toHaveText("Beta review thread");

    // Cmd/Ctrl+P searches the thread's files and opens the pick in the Files panel.
    await openPalette(window, "P");
    await window.keyboard.type("beta notes");
    await expect(paletteOptions(window).first()).toContainText("beta-notes.md");
    await expect(paletteOptions(window).first()).toContainText("docs");
    await window.keyboard.press("Enter");
    await expect(palette(window)).toHaveCount(0);
    const files = window.getByTestId("file-workbench");
    await expect(files).toBeVisible();
    await expect(files.locator(".file-editor__tab--active")).toContainText("beta-notes.md");
    await expect(files.getByTestId("file-editor-breadcrumb")).toContainText("docs");

    // With no query, Cmd/Ctrl+P lists the open tabs. "Go to file" switches K to P.
    await openPalette(window, "K");
    await window.keyboard.type("go to file");
    await window.keyboard.press("Enter");
    await expect(palette(window)).toHaveAttribute("aria-label", "Go to file");
    await expect(palette(window).getByRole("group", { name: "Open files" })).toContainText(
      "beta-notes.md",
    );
    await window.keyboard.type("alpha");
    await paletteOptions(window).filter({ hasText: "alpha.ts" }).click();
    await expect(files.locator(".file-editor__tab--active")).toContainText("alpha.ts");
    await expect(files.getByTestId("file-workbench-tab")).toHaveCount(2);
  } finally {
    await harness.close();
  }
});
