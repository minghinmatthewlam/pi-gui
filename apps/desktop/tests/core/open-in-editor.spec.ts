import { expect, test } from "@playwright/test";
import { hasEditorIcon } from "../../src/ui/editor-icons";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * The "open in editor" control lives in the topbar actions cluster, next to the
 * side-panel toggle. The main half shows the target editor's short name and
 * opens it; the thin chevron half lists what main actually detected on this
 * machine. Detection is per-host, so the menu assertions allow either a
 * populated list or the empty notice plus the folder fallback.
 */
test("shows the detected editor beside the side panel toggle", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("open-in-editor");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspace);

    const mainButton = window.getByTestId("open-in-editor");
    const trigger = window.getByTestId("open-in-editor-menu-trigger");
    await expect(window.getByTestId("toggle-side-panel")).toBeVisible();
    await expect(mainButton).toBeVisible();
    await expect(trigger).toBeVisible();
    // The control sits in the topbar actions, next to the side-panel toggle.
    await expect(window.locator(".topbar__actions .open-in-editor")).toHaveCount(1);
    await expect(window.getByTestId("open-in-editor-menu")).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    // The main half stays disabled until the first probe settles.
    await expect(mainButton).toBeEnabled();

    const list = await window.evaluate(async () => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.listEditors();
    });

    // The main half shows the target editor's brand mark when the catalog has
    // one, its short name otherwise. Never both.
    const label = window.getByTestId("open-in-editor-label");
    if (list.editors.length === 0) {
      await expect(label).toHaveText("Folder");
      await expect(mainButton.locator("svg")).toHaveCount(0);
    } else {
      const preferredId = list.preferredEditorId ?? list.editors[0]?.id;
      const preferred = list.editors.find((editor) => editor.id === preferredId);
      if (hasEditorIcon(preferredId)) {
        await expect(mainButton.locator("svg")).toHaveCount(1);
        await expect(label).toHaveCount(0);
      } else {
        await expect(mainButton.locator("svg")).toHaveCount(0);
        await expect(label).toHaveText(preferred?.shortLabel ?? "Folder");
      }
    }

    await trigger.click();
    const menu = window.getByTestId("open-in-editor-menu");
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await trigger.click();
    await expect(menu).toBeVisible();
    await trigger.click();
    await expect(menu).toHaveCount(0);

    // The menu has to match what main reported: every detected editor is listed,
    // or the empty notice and the folder fallback are. Branching on the real
    // result keeps the assertion meaningful on an empty machine too.
    await trigger.click();
    await expect(menu).toBeVisible();
    if (list.editors.length === 0) {
      await expect(window.getByTestId("open-in-editor-empty")).toBeVisible();
      await expect(window.getByTestId("open-in-editor-folder")).toBeVisible();
    } else {
      for (const editor of list.editors) {
        const item = window.getByTestId(`open-in-editor-${editor.id}`);
        await expect(item).toBeVisible();
        await expect(item).toContainText(editor.label);
        await expect(item.locator("svg")).toHaveCount(hasEditorIcon(editor.id) ? 1 : 0);
      }
    }
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Choosing from the menu only re-targets the main button; nothing opens.
    if (list.editors.length > 1) {
      const currentId = list.preferredEditorId ?? list.editors[0]?.id;
      const other = list.editors.find((editor) => editor.id !== currentId);
      if (other) {
        await trigger.click();
        await expect(menu).toBeVisible();
        await window.getByTestId(`open-in-editor-${other.id}`).click();
        await expect(menu).toHaveCount(0);
        if (hasEditorIcon(other.id)) {
          await expect(label).toHaveCount(0);
          await expect(mainButton.locator("svg")).toHaveCount(1);
        } else {
          await expect(label).toHaveText(other.shortLabel);
        }
        const refreshed = await window.evaluate(async () => {
          const app = globalThis.window.piApp;
          if (!app) {
            throw new Error("piApp IPC bridge is unavailable");
          }
          return app.listEditors();
        });
        expect(refreshed.preferredEditorId).toBe(other.id);
      }
    }

    const state = await getDesktopState(window);
    const selected = state.workspaces.find((entry) => entry.path === workspace);
    expect(selected).toBeDefined();
    const rejection = await window.evaluate(async (workspaceId: string) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      try {
        await app.openWorkspaceInEditor(workspaceId, "not-a-real-editor");
        return "resolved";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, selected?.id ?? "");
    expect(rejection).toContain("Unknown editor");
  } finally {
    await harness.close();
  }
});
