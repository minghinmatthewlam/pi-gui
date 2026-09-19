import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { acceptOpenFolderDialog, assertAccessibilityReady } from "../helpers/macos-ui";

test.skip(process.platform !== "darwin", "Real open-folder production coverage is macOS-only");

test("opens the real macOS folder picker from the empty state button and adds the selected workspace", async () => {
  test.setTimeout(60_000);

  try {
    await assertAccessibilityReady();
  } catch (error) {
    test.skip(true, String(error));
  }

  const userDataDir = await makeUserDataDir("pi-gui-real-open-folder-");
  const workspacePath = await makeWorkspace("real-open-folder-workspace");
  const harness = await launchDesktop(userDataDir, { testMode: "foreground" });

  try {
    const window = await harness.firstWindow();
    await expect(window.getByTestId("empty-state")).toBeVisible();
    await harness.focusWindow();

    await Promise.all([
      acceptOpenFolderDialog(workspacePath),
      window.getByRole("button", { name: "Open first folder" }).click(),
    ]);

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
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
  } finally {
    await harness.close();
  }
});
