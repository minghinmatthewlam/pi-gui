import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  commitAllInGitRepo,
  createNamedThread,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSidePanel,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("Review picks up outside edits when the window regains focus, without blanking", async () => {
  const workspacePath = await makeWorkspace("review-auto-refresh");
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "notes.txt"), "first\n");
  await commitAllInGitRepo(workspacePath, "Baseline");
  await writeFile(join(workspacePath, "notes.txt"), "first\nsecond\n");

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Review auto refresh", { workspaceName: workspace.name });
    await selectSidePanel(window, "Review");
    const panel = window.getByRole("region", { name: "Review", exact: true });
    const diff = panel.getByRole("region", { name: "Diff", exact: true });
    await expect(diff.locator(".diff-line--added .diff-line__content")).toHaveText(["second"]);
    await expect(panel.getByTestId("review-line-totals")).toHaveText("+1-0");

    // Record whether the panel ever falls back to a loading state during the refresh.
    const diffHandle = await diff.elementHandle();
    await window.evaluate(() => {
      const state = window as unknown as { reviewBlanked?: boolean };
      state.reviewBlanked = false;
      const region = document.querySelector('[aria-label="Review"]')!;
      new MutationObserver(() => {
        if (/Loading (comparison|diff)/.test(region.textContent ?? "")) state.reviewBlanked = true;
      }).observe(region, { childList: true, subtree: true, characterData: true });
    });

    // Edits made outside pi-gui while it was in the background, then its window regains focus.
    await writeFile(join(workspacePath, "notes.txt"), "first\nsecond\nthird\n");
    await writeFile(join(workspacePath, "extra.txt"), "added elsewhere\n");
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.emit("focus");
    });

    await expect(diff.locator(".diff-line--added .diff-line__content")).toHaveText([
      "second",
      "third",
    ]);
    await expect(panel.locator('[data-file-path="extra.txt"]')).toBeVisible();
    await expect(panel.getByTestId("review-line-totals")).toHaveText("+3-0");
    expect(await diffHandle!.evaluate((element) => element.isConnected)).toBe(true);
    expect(
      await window.evaluate(() => (window as unknown as { reviewBlanked: boolean }).reviewBlanked),
    ).toBe(false);
  } finally {
    await harness.close();
  }
});
