import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  expectNewThreadWorkspace,
  getApplicationMenuItemInfo,
  getDesktopState,
  getOpenDialogInvocationCount,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  stubNextOpenDialog,
  stubNextOpenDialogResult,
  triggerApplicationMenuItem,
  triggerNativeOpenFolderShortcut,
} from "../helpers/electron-app";

const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";

test.skip(process.platform !== "darwin", "Open Folder native coverage is macOS-only");

test("opens the native folder picker from the empty state button and adds the selected workspace", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("native-open-folder-workspace");
  const harness = await launchDesktop(userDataDir, { testMode: "foreground" });

  try {
    const window = await harness.firstWindow();
    await expect(window.getByTestId("empty-state")).toBeVisible();
    await harness.focusWindow();

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

test("opens a folder from Cmd+O even when the composer is focused", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const initialWorkspacePath = await makeWorkspace("native-open-folder-initial-workspace");
  const openedWorkspacePath = await makeWorkspace("native-open-folder-shortcut-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [initialWorkspacePath],
    testMode: "foreground",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Shortcut open folder session");
    await harness.focusWindow();

    const composer = window.getByTestId("composer");
    await composer.click();
    await expect(composer).toBeFocused();

    await stubNextOpenDialog(harness, [openedWorkspacePath]);
    await triggerNativeOpenFolderShortcut(harness);

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const selectedWorkspace = state.workspaces.find(
            (workspace) => workspace.id === state.selectedWorkspaceId,
          );
          return {
            selectedPath: selectedWorkspace?.path ?? null,
            workspaceCount: state.workspaces.length,
          };
        },
        { timeout: 20_000 },
      )
      .toEqual({
        selectedPath: openedWorkspacePath,
        workspaceCount: 2,
      });

    await expect(window.getByTestId("workspace-list")).toContainText(basename(openedWorkspacePath));
    await expectNewThreadWorkspace(window, openedWorkspacePath);
  } finally {
    await harness.close();
  }
});

test("exposes File > Open Folder… with Command+O and reuses the same open-folder action", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("native-open-folder-menu-workspace");
  const harness = await launchDesktop(userDataDir, { testMode: "foreground" });

  try {
    const window = await harness.firstWindow();
    await expect(window.getByTestId("empty-state")).toBeVisible();
    await harness.focusWindow();

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

test("canceling the open-folder dialog from Cmd+O leaves workspace state unchanged", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("native-open-folder-cancel-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Cancel open folder session");
    await harness.focusWindow();

    const composer = window.getByTestId("composer");
    await composer.click();
    await expect(composer).toBeFocused();

    const before = await getDesktopState(window);
    const selectedBefore = before.workspaces.find(
      (workspace) => workspace.id === before.selectedWorkspaceId,
    );

    await stubNextOpenDialogResult(harness, { canceled: true, filePaths: [] });
    await triggerNativeOpenFolderShortcut(harness);

    await expect.poll(() => getOpenDialogInvocationCount(harness)).toBe(1);
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const selectedWorkspace = state.workspaces.find(
            (workspace) => workspace.id === state.selectedWorkspaceId,
          );
          return {
            workspaceCount: state.workspaces.length,
            selectedPath: selectedWorkspace?.path ?? null,
            emptyStateVisible: await window
              .getByTestId("empty-state")
              .isVisible()
              .catch(() => false),
          };
        },
        { timeout: 20_000 },
      )
      .toEqual({
        workspaceCount: before.workspaces.length,
        selectedPath: selectedBefore?.path ?? null,
        emptyStateVisible: false,
      });
  } finally {
    await harness.close();
  }
});
