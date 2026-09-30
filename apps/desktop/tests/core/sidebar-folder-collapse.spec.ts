import { expect, test } from "@playwright/test";
import {
  chooseThreadGrouping,
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("folds a folder group from its row and keeps it folded across restart", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const alphaPath = await makeWorkspace("collapse-alpha");
  const betaPath = await makeWorkspace("collapse-beta");
  const emptyPath = await makeWorkspace("collapse-empty");
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [alphaPath, betaPath, emptyPath],
    testMode: "background",
  });

  let workspaceId = "";
  try {
    const window = await firstRun.firstWindow();
    const alpha = await waitForWorkspaceByPath(window, alphaPath);
    await waitForWorkspaceByPath(window, betaPath);
    workspaceId = alpha.id;
    await createSessionViaIpc(window, alphaPath, "Alpha planning");
    await createSessionViaIpc(window, betaPath, "Beta planning");
    await chooseThreadGrouping(window, "workspace");

    const group = window.locator(`.workspace-group[data-workspace-id="${workspaceId}"]`);
    const folderRow = group.locator(".workspace-row__select");
    await expect(group.locator(".session-row__title")).toHaveText(["Alpha planning"]);
    await expect(folderRow).toHaveAttribute("aria-expanded", "true");
    const selectedBefore = (await getDesktopState(window)).selectedSessionId;

    // Clicking the folder row folds it without leaving the open thread.
    await folderRow.click();
    await expect(folderRow).toHaveAttribute("aria-expanded", "false");
    await expect(group.locator(".session-row")).toHaveCount(0);
    await expect(window.locator(".workspace-group .session-row__title")).toHaveText([
      "Beta planning",
    ]);
    await expect
      .poll(async () => (await getDesktopState(window)).collapsedWorkspaceIds)
      .toEqual([workspaceId]);
    expect((await getDesktopState(window)).selectedSessionId).toBe(selectedBefore);

    // A folder with no threads has nothing to fold, so its row still selects it.
    const empty = await waitForWorkspaceByPath(window, emptyPath);
    const emptyRow = window.locator(
      `.workspace-group[data-workspace-id="${empty.id}"] .workspace-row__select`,
    );
    await expect(emptyRow).not.toHaveAttribute("aria-expanded", /.*/);
    await emptyRow.click();
    await expect
      .poll(async () => (await getDesktopState(window)).selectedWorkspaceId)
      .toBe(empty.id);
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, alphaPath);
    const group = window.locator(`.workspace-group[data-workspace-id="${workspaceId}"]`);
    const folderRow = group.locator(".workspace-row__select");
    await expect(folderRow).toHaveAttribute("aria-expanded", "false");
    await expect(group.locator(".session-row")).toHaveCount(0);

    await folderRow.click();
    await expect(folderRow).toHaveAttribute("aria-expanded", "true");
    await expect(group.locator(".session-row__title")).toHaveText(["Alpha planning"]);
    await expect
      .poll(async () => (await getDesktopState(window)).collapsedWorkspaceIds)
      .toEqual([]);

    // Starting a thread in a folded folder opens it so the new row stays in view.
    await folderRow.click();
    await expect(folderRow).toHaveAttribute("aria-expanded", "false");
    await group.getByRole("button", { name: /^New thread in / }).click();
    await expect(folderRow).toHaveAttribute("aria-expanded", "true");
  } finally {
    await secondRun.close();
  }
});
