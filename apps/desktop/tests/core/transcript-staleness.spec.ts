import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

/**
 * The transcript shown after a relaunch must come straight from pi's session
 * file. An external writer (e.g. the pi CLI continuing the same session, or a
 * crash that outran a cache write) must be reflected on next launch.
 */
test("shows messages appended to the pi session file by an external writer after relaunch", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("staleness-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Staleness session");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    expect(workspaceId).toBeTruthy();
    expect(sessionId).toBeTruthy();
  } finally {
    await firstRun.close();
  }

  // Append a user message the way pi itself would, chaining off the current leaf.
  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await appendMessagesToSessionFile(sessionFilePath, [
    { role: "user", text: "external writer message survives relaunch" },
  ]);

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("transcript")).toContainText(
      "external writer message survives relaunch",
      {
        timeout: 15_000,
      },
    );
  } finally {
    await secondRun.close();
  }
});
