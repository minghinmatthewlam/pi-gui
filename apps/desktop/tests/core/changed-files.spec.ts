import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { reviewedFilesKey } from "../../src/reviewed-files-store";
import {
  commitAllInGitRepo,
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);
const proofDir = process.env.PI_APP_CHANGED_FILES_PROOF_DIR;

test("preserves an exact changed-file path through diff and stage actions", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("changed-file-path");
  const filePath = ' leading\t"quoted" -> destination\n.txt ';
  const displayCollisionPath = JSON.stringify(filePath);
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await writeFile(join(workspacePath, filePath), "exact path contents\n", "utf8");
  await writeFile(join(workspacePath, displayCollisionPath), "distinct path contents\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Changed path test");
    await window.keyboard.press(desktopShortcut("D"));

    const diffPanel = window.locator(".diff-panel");
    const changedRows = diffPanel.locator(".diff-panel__file");
    await expect(changedRows).toHaveCount(2);
    const rowPaths = await changedRows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-file-path")),
    );
    const changedRow = changedRows.nth(rowPaths.indexOf(filePath));
    await expect(changedRow).toHaveAttribute("data-file-path", filePath);
    expect(await changedRow.locator(".diff-panel__file-path").textContent()).toBe(
      JSON.stringify(filePath),
    );
    expect(await changedRows.locator(".diff-panel__file-path").allTextContents()).toEqual(
      expect.arrayContaining([JSON.stringify(filePath), JSON.stringify(displayCollisionPath)]),
    );

    await changedRow.locator(".diff-panel__file-name").click();
    await expect(diffPanel.locator(".diff-inline")).toContainText("exact path contents");

    await changedRow.getByRole("button", { name: "Stage", exact: true }).click();
    await expect(changedRow.getByRole("button", { name: "Staged", exact: true })).toBeDisabled();

    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached", "--name-only", "-z", "--", filePath],
      { cwd: workspacePath },
    );
    expect(stdout).toBe(`${filePath}\0`);

    await saveProof(window, "exact-path-staged.png");
  } finally {
    await harness.close();
  }
});

test("shows Git status as unavailable without losing reviewed files", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("changed-files-reviewed");
  const filePath = "reviewed.txt";
  const gitPath = join(workspacePath, ".git");
  const unavailableGitPath = join(workspacePath, "..", ".git-changed-files-reviewed");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await writeFile(join(workspacePath, filePath), "review this\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let gitMoved = false;

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Reviewed unavailable status test");
    const state = await getDesktopState(window);
    if (!state.selectedWorkspaceId || !state.selectedSessionId) {
      throw new Error("Expected a selected session");
    }
    const storageKey = reviewedFilesKey(state.selectedWorkspaceId, state.selectedSessionId);

    await window.keyboard.press(desktopShortcut("D"));
    const diffPanel = window.locator(".diff-panel");
    await diffPanel.getByTestId(`diff-panel-reviewed-${filePath}`).check();
    const reviewedBeforeFailure = await window.evaluate(
      (key) => globalThis.localStorage.getItem(key),
      storageKey,
    );
    expect(reviewedBeforeFailure).not.toBeNull();

    await rename(gitPath, unavailableGitPath);
    gitMoved = true;
    await diffPanel.locator('button[aria-label="Refresh"]').click();
    await expect(diffPanel.getByTestId("changed-files-unavailable")).toHaveText(
      "Git status is unavailable for this workspace.",
    );
    await expect(diffPanel.locator(".file-workbench__section-header")).toContainText(
      /unavailable/i,
    );
    await expect(diffPanel.getByText("No changes", { exact: true })).toHaveCount(0);
    await expect
      .poll(() => window.evaluate((key) => globalThis.localStorage.getItem(key), storageKey))
      .toBe(reviewedBeforeFailure);
    await saveProof(window, "git-status-unavailable.png");
  } finally {
    await harness.close();
    if (gitMoved) {
      await rename(unavailableGitPath, gitPath);
    }
  }
});

async function saveProof(window: Page, fileName: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await window.screenshot({ path: join(proofDir, fileName) });
}
