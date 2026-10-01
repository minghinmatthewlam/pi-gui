import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  pasteTinyPng,
  selectSession,
} from "../helpers/electron-app";

// A typed local command (/status, /model x, /name …) is not a message, so attachments stay in the
// composer. They used to vanish from the screen but stay on disk, then return on the next visit.
test("a typed slash command keeps composer attachments across thread switch and restart", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("slash-command-attachments");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Other thread");
    await createNamedThread(window, "Image thread");
    const composer = window.getByTestId("composer");
    const chips = window.locator(".composer-attachment--image");
    await pasteTinyPng(window);
    await expect(chips).toHaveCount(1);

    await composer.fill("/status");
    await composer.press("Enter");
    await expect(window.getByTestId("transcript")).toContainText(/Model |No session overrides set/);
    await expect(composer).toHaveValue("");
    expect((await getDesktopState(window)).composerAttachments).toHaveLength(1);
    await expect(chips).toHaveCount(1);

    await selectSession(window, "Other thread");
    await expect(chips).toHaveCount(0);
    await selectSession(window, "Image thread");
    await expect(chips).toHaveCount(1);
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, "Image thread");
    await expect(window.locator(".composer-attachment--image")).toHaveCount(1);
  } finally {
    await secondRun.close();
  }
});
