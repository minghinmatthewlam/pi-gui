import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  selectSidePanel,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("Changes and Terminal share one side workspace while the composer stays available", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("terminal-diff-layout");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Terminal and Changes layout");
    await selectSidePanel(window, "Changes");
    const changes = window.locator(".diff-panel");
    await expect(changes).toBeVisible();
    const changesBox = await changes.boundingBox();

    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await expect(changes).toHaveCount(0);
    await expect(window.getByTestId("composer")).toBeVisible();
    const terminalBox = await terminal.boundingBox();
    const composerBox = await window.getByTestId("composer").boundingBox();
    if (!changesBox || !terminalBox || !composerBox) {
      throw new Error("Expected visible tool and composer bounds");
    }
    expect(Math.abs(terminalBox.x - changesBox.x)).toBeLessThan(3);
    expect(terminalBox.width).toBeGreaterThanOrEqual(300);
    expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(terminalBox.x + 1);

    await window.getByRole("tab", { name: "Changes", exact: true }).click();
    await expect(changes).toBeVisible();
    await expect(terminal).toHaveCount(0);
    await expect(window.getByRole("tab", { name: "Terminal", exact: true })).toHaveCount(1);
    await expect(window.getByTestId("composer")).toBeVisible();
  } finally {
    await harness.close();
  }
});
