import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  pasteTinyPngViaClipboard,
} from "../helpers/electron-app";

test("pastes an image from the real Electron clipboard into the composer", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("native-paste-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Native paste session");
    await harness.focusWindow();

    await pasteTinyPngViaClipboard(harness, window);
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.composerAttachments.map((attachment) => attachment.mimeType);
      })
      .toEqual(["image/png"]);

    await window.getByTestId("composer").fill("test with clipboard image");
    await window.getByTestId("composer").press("Enter");
    await expect(window.locator(".composer-attachment")).toHaveCount(0, { timeout: 2_000 });
  } finally {
    await harness.close();
  }
});

test("pastes an image from the real Electron clipboard into the new thread composer", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("native-new-thread-paste-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);
    await harness.focusWindow();

    await pasteTinyPngViaClipboard(harness, window, "new-thread-composer");
    await expect(window.locator(".composer-attachment")).toHaveCount(1);

    await window.getByRole("button", { name: "Start thread" }).click();
    await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
    await expect(window.locator(".timeline-item__attachment")).toBeVisible({ timeout: 15_000 });
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
