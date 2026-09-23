import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  expectNewThreadWorkspace,
  getApplicationMenuItemInfo,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  stubNextOpenDialog,
  triggerApplicationMenuItem,
} from "../helpers/electron-app";

const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";

test("adds a workspace from the empty state button using a stubbed folder selection", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("native-open-folder-workspace");
  const harness = await launchDesktop(userDataDir, { testMode: "background" });

  try {
    const window = await harness.firstWindow();
    await expect(window.getByTestId("empty-state")).toBeVisible();

    await stubNextOpenDialog(harness, [workspacePath]);
    await window.getByRole("button", { name: "Open first folder" }).click();

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const selectedWorkspace = state.workspaces.find(
            (workspace) => workspace.id === state.selectedWorkspaceId,
          );
          return selectedWorkspace?.path ?? null;
        },
        { timeout: 20_000 },
      )
      .toBe(workspacePath);

    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));
    await expectNewThreadWorkspace(window, workspacePath);
  } finally {
    await harness.close();
  }
});

test("exposes File > Open Folder… with Command+O and reuses the same open-folder action", async () => {
  test.skip(process.platform !== "darwin", "The application menu is only installed on macOS.");
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("native-open-folder-menu-workspace");
  const harness = await launchDesktop(userDataDir, { testMode: "background" });

  try {
    const window = await harness.firstWindow();
    await expect(window.getByTestId("empty-state")).toBeVisible();

    const menuItem = await getApplicationMenuItemInfo(harness, OPEN_FOLDER_MENU_ITEM_ID);

    expect(menuItem).toEqual({
      id: OPEN_FOLDER_MENU_ITEM_ID,
      label: "Open Folder…",
      accelerator: "Command+O",
      parentLabel: "File",
    });

    await stubNextOpenDialog(harness, [workspacePath]);
    const triggered = await triggerApplicationMenuItem(harness, OPEN_FOLDER_MENU_ITEM_ID);
    expect(triggered).toBe(true);

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const selectedWorkspace = state.workspaces.find(
            (workspace) => workspace.id === state.selectedWorkspaceId,
          );
          return selectedWorkspace?.path ?? null;
        },
        { timeout: 20_000 },
      )
      .toBe(workspacePath);

    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));
    await expectNewThreadWorkspace(window, workspacePath);
  } finally {
    await harness.close();
  }
});
