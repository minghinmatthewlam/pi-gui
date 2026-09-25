import { expect, test } from "@playwright/test";
import {
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("runs /tree summarize flow against a real provider and surfaces the branch summary", async () => {
  test.setTimeout(240_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("live-tree-command-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
  });

  try {
    const window = await harness.firstWindow();
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();

    const newThreadComposer = window.getByTestId("new-thread-composer");
    await newThreadComposer.fill("Reply with exactly ROOT-ONE.");
    await window.getByRole("button", { name: "Start thread" }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("ROOT-ONE", { timeout: 150_000 });

    const composer = window.getByTestId("composer");
    await composer.fill("Reply with exactly BETA-TWO.");
    await composer.press("Enter");
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("BETA-TWO", { timeout: 150_000 });

    await composer.fill("/tree");
    await composer.press("Enter");

    const treeModal = window.getByTestId("tree-modal");
    await expect(treeModal).toBeVisible();
    await treeModal
      .locator(".tree-row__content", { hasText: "Reply with exactly ROOT-ONE." })
      .click();
    await treeModal.getByRole("button", { name: "Continue" }).click();
    await expect(window.getByTestId("tree-summary-step")).toBeVisible();
    await treeModal.getByRole("button", { name: /^Summarize Generate a branch summary/ }).click();
    await treeModal.getByRole("button", { name: "Switch branch" }).click();

    await expect(treeModal).toHaveCount(0, { timeout: 150_000 });
    await expect(window.locator(".timeline-item--summary-card")).toContainText("Branch summary", {
      timeout: 150_000,
    });
    await expect(composer).toHaveValue("Reply with exactly ROOT-ONE.");
  } finally {
    await harness.close();
  }
});
