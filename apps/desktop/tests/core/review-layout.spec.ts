import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  chooseReviewScope,
  commitAllInGitRepo,
  createNamedThread,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  reviewScopeButton,
  seedAgentDir,
  selectSidePanel,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

test("Review shows the diff beside a filterable file tree with Staged and Unstaged scopes", async () => {
  const workspacePath = await makeWorkspace("review-layout");
  await initGitRepo(workspacePath);
  await mkdir(join(workspacePath, "outputs"), { recursive: true });
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(workspacePath, "outputs", "report.md"), `${lines.join("\n")}\n`);
  await writeFile(join(workspacePath, "notes.txt"), "first\n");
  await commitAllInGitRepo(workspacePath, "Baseline");
  // report.md: a staged edit near the end. notes.txt: an unstaged edit. todo.txt: untracked.
  const edited = [...lines.slice(0, 9), "line 10 staged", ...lines.slice(10)];
  await writeFile(join(workspacePath, "outputs", "report.md"), `${edited.join("\n")}\n`);
  await execFileAsync("git", ["add", "outputs/report.md"], { cwd: workspacePath });
  await writeFile(join(workspacePath, "notes.txt"), "first\nsecond\n");
  await writeFile(join(workspacePath, "todo.txt"), "one\ntwo\nthree\n");

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
    await createNamedThread(window, "Review layout task", { workspaceName: workspace.name });
    await selectSidePanel(window, "Review");
    const panel = window.getByRole("region", { name: "Review", exact: true });
    await expect(reviewScopeButton(window)).toHaveText("Uncommitted");
    await expect(panel.getByTestId("review-line-totals")).toHaveText("+5-1");

    // The tree sits to the right of the diff, and the first tree file opens without a click.
    const tree = panel.getByRole("region", { name: "Changed files", exact: true });
    const diff = panel.getByRole("region", { name: "Diff", exact: true });
    await expect(tree.getByRole("button", { name: "outputs", exact: true })).toBeVisible();
    await expect(diff.locator(".diff-line--added .diff-line__content")).toHaveText([
      "line 10 staged",
    ]);
    const [diffBox, treeBox] = [await diff.boundingBox(), await tree.boundingBox()];
    expect(treeBox!.x).toBeGreaterThanOrEqual(diffBox!.x + diffBox!.width - 1);
    await expect(diff.locator(".diff-line--unmodified").first()).toHaveText(/6 unmodified lines/);
    await window.screenshot({ path: test.info().outputPath("review-uncommitted.png") });

    await tree.getByRole("textbox", { name: "Filter changed files" }).fill("todo");
    await expect(tree.locator(".diff-panel__file")).toHaveCount(1);
    await tree.getByRole("button", { name: "todo.txt", exact: true }).click();
    await expect(diff.locator(".diff-line--added .diff-line__content")).toHaveText([
      "one",
      "two",
      "three",
    ]);

    await chooseReviewScope(window, "Staged");
    await expect(panel.locator(".diff-panel__file")).toHaveCount(1);
    await expect(panel.locator('[data-file-path="outputs/report.md"]')).toBeVisible();
    await expect(panel.getByTestId("review-line-totals")).toHaveText("+1-1");
    await expect(diff.locator(".diff-line--removed .diff-line__content")).toHaveText(["line 10"]);

    await chooseReviewScope(window, "Unstaged");
    await expect(panel.locator(".diff-panel__file")).toHaveCount(2);
    await expect(panel.getByTestId("review-line-totals")).toHaveText("+4-0");
    await panel.locator('[data-file-path="notes.txt"] .diff-panel__file-name').click();
    await expect(diff.locator(".diff-line--added .diff-line__content")).toHaveText(["second"]);
    await panel
      .locator('[data-file-path="notes.txt"]')
      .getByRole("button", { name: "Stage", exact: true })
      .click();
    await expect(panel.locator(".diff-panel__file")).toHaveCount(1);
    // The staged file left this comparison, so the diff falls back to the remaining file.
    await expect(diff.locator(".diff-line--added .diff-line__content")).toHaveText([
      "one",
      "two",
      "three",
    ]);
    expect(
      (await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: workspacePath }))
        .stdout,
    ).toBe("notes.txt\noutputs/report.md\n");

    await panel.getByRole("button", { name: "Hide file tree", exact: true }).click();
    await expect(tree).toHaveCount(0);
    await panel.getByRole("button", { name: "Show file tree", exact: true }).click();
    await expect(tree).toBeVisible();
  } finally {
    await harness.close();
  }
});
