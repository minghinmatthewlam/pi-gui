import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("submits a real prompt and shows the response in the transcript", async () => {
  test.setTimeout(180_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("live-run-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
  });

  try {
    const window = await harness.firstWindow();

    await window.getByRole("complementary").getByRole("button", { name: "New thread" }).click();
    await window.getByLabel("New thread prompt").fill("Reply with only the uppercase word READY.");
    await window.getByRole("button", { name: "Start thread" }).click();

    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText(/READY/, { timeout: 150_000 });

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          return state.workspaces[0]?.sessions[0]?.status ?? "";
        },
        { timeout: 150_000 },
      )
      .toBe("idle");
  } finally {
    await harness.close();
  }
});
