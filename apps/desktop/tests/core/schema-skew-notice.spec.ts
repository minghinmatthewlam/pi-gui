import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { bumpSessionFileSchemaVersion, sessionFilePathFromCatalog } from "../helpers/session-file";

test("shows a version-skew notice for a session written by a newer pi, dismissible per session", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("schema-skew-workspace");

  let workspaceId = "";
  let sessionId = "";
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Skewed session");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    expect(workspaceId).toBeTruthy();
    expect(sessionId).toBeTruthy();
  } finally {
    await firstRun.close();
  }

  // Simulate a file authored by a newer pi than the bundled runtime.
  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await bumpSessionFileSchemaVersion(sessionFilePath);

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.locator(".chat-header__title")).toHaveText("Skewed session");

    // The projection is part of the contract: missing schema data must fail this test.
    await expect
      .poll(async () => (await getSelectedTranscript(window))?.schemaInfo?.writtenByNewerRuntime, {
        timeout: 10_000,
        message: "The selected transcript must expose newer-runtime schema information",
      })
      .toBe(true);

    const notice = window.getByTestId("schema-skew-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText("written by a newer version of pi");

    await notice.getByRole("button", { name: "Dismiss notice" }).click();
    await expect(notice).toHaveCount(0);
  } finally {
    await secondRun.close();
  }

  // Dismissal is in-memory only: the notice reappears after a restart.
  const thirdRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await thirdRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.locator(".chat-header__title")).toHaveText("Skewed session");
    await expect(window.getByTestId("schema-skew-notice")).toBeVisible({ timeout: 15_000 });
  } finally {
    await thirdRun.close();
  }
});

test("does not show the version-skew notice for a current-version session", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("schema-current-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Current session");
    await expect(window.locator(".chat-header__title")).toHaveText("Current session");
    await expect(window.getByTestId("transcript")).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("schema-skew-notice")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
