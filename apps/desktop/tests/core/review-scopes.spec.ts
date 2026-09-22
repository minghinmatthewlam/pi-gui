import { execFile } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";
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

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

async function openReview(workspacePath: string, additionalWorkspaces: readonly string[] = []) {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath, ...additionalWorkspaces],
    testMode: "background",
  });
  const window = await harness.firstWindow();
  const workspace = await waitForWorkspaceByPath(window, workspacePath);
  await createNamedThread(window, "Review scope task", { workspaceName: workspace.name });
  await selectSidePanel(window, "Changes");
  const panel = window.getByRole("region", { name: "Changes review", exact: true });
  await expect(panel).toBeVisible();
  return { harness, window, panel, workspace };
}

function fileRow(panel: Locator, path: string): Locator {
  return panel.locator(".diff-panel__file").filter({
    has: panel.page().getByRole("checkbox", { name: `Mark ${path} reviewed`, exact: true }),
  });
}

async function openFile(panel: Locator, path: string): Promise<void> {
  await fileRow(panel, path).locator(".diff-panel__file-name").click();
}

async function chooseBranch(window: Page, baseRef: string): Promise<void> {
  await window.getByLabel("Review scope", { exact: true }).selectOption("branch");
  await window.getByLabel("Base branch", { exact: true }).fill(baseRef);
  await window.getByRole("button", { name: "Compare", exact: true }).click();
}

test("Uncommitted preserves staged and unstaged changes that cancel each other", async () => {
  const workspacePath = await makeWorkspace("review-partially-staged");
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "result.txt"), "baseline content\n");
  await commitAllInGitRepo(workspacePath, "Baseline");
  await writeFile(join(workspacePath, "result.txt"), "staged content\n");
  await git(workspacePath, "add", "result.txt");
  await writeFile(join(workspacePath, "result.txt"), "baseline content\n");
  const { harness, window, panel } = await openReview(workspacePath);
  try {
    await expect(window.getByLabel("Review scope", { exact: true })).toHaveValue("uncommitted");
    await expect(panel.locator(".diff-panel__file")).toHaveCount(1);
    await openFile(panel, "result.txt");
    await expect(panel).toContainText("staged and unstaged changes cancel each other");
    const staged = panel.getByRole("region", { name: "Staged", exact: true });
    const unstaged = panel.getByRole("region", { name: "Unstaged", exact: true });
    await expect(staged.locator(".diff-line--added")).toContainText("staged content");
    await expect(unstaged.locator(".diff-line--removed")).toContainText("staged content");
    await expect(unstaged.locator(".diff-line--added")).toContainText("baseline content");
    await expect(
      fileRow(panel, "result.txt").getByRole("button", { name: "Unstage", exact: true }),
    ).toBeEnabled();
    await fileRow(panel, "result.txt").getByRole("button", { name: "Stage", exact: true }).click();
    await expect(panel.getByText("No changes", { exact: true })).toBeVisible();
    expect(await git(workspacePath, "diff", "--cached", "--", "result.txt")).toBe("");
  } finally {
    await harness.close();
  }
});

test("Branch compares committed revisions and reports a missing base explicitly", async () => {
  const workspacePath = await makeWorkspace("review-branch");
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "result.txt"), "base revision\n");
  await commitAllInGitRepo(workspacePath, "Baseline");
  await git(workspacePath, "branch", "release-base");
  await git(workspacePath, "switch", "-c", "feature-review");
  await writeFile(join(workspacePath, "result.txt"), "committed feature revision\n");
  await commitAllInGitRepo(workspacePath, "Feature commit");
  await writeFile(join(workspacePath, "result.txt"), "unsaved working revision\n");
  await writeFile(join(workspacePath, "scratch.txt"), "untracked scratch\n");
  const { harness, window, panel } = await openReview(workspacePath);
  try {
    await chooseBranch(window, "release-base");
    await expect(panel.getByTestId("review-comparison-identity")).toContainText("release-base");
    await expect(panel.locator(".diff-panel__file")).toHaveCount(1);
    await openFile(panel, "result.txt");
    const patch = panel.getByRole("region", { name: "Combined changes", exact: true });
    await expect(patch).toContainText("committed feature revision");
    await expect(patch).not.toContainText("unsaved working revision");
    await expect(panel.getByRole("button", { name: /^(Stage|Staged|Unstage)$/ })).toHaveCount(0);
    await fileRow(panel, "result.txt").getByRole("checkbox").click();
    await expect(panel.getByTestId("diff-panel-counter")).toHaveText("Reviewed 1 of 1");

    await window.getByLabel("Review scope", { exact: true }).selectOption("uncommitted");
    await expect(panel.locator(".diff-panel__file")).toHaveCount(2);
    await expect(fileRow(panel, "result.txt").getByRole("checkbox")).not.toBeChecked();
    await openFile(panel, "result.txt");
    await expect(
      panel.getByRole("region", { name: "Combined changes", exact: true }),
    ).toContainText("unsaved working revision");

    await chooseBranch(window, "missing-review-base");
    await expect(panel.getByTestId("changed-files-unavailable")).toContainText(
      /base reference.*unavailable/i,
    );
    await expect(panel.getByText("No changes", { exact: true })).toHaveCount(0);
    await expect(panel.getByTestId("diff-panel-counter")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("an outdated comparison cannot mark or stage newer working content", async () => {
  const workspacePath = await makeWorkspace("review-stale");
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "result.txt"), "baseline\n");
  await commitAllInGitRepo(workspacePath, "Baseline");
  await writeFile(join(workspacePath, "result.txt"), "first edit\n");
  const { harness, panel } = await openReview(workspacePath);
  try {
    await expect(fileRow(panel, "result.txt")).toBeVisible();
    await writeFile(join(workspacePath, "result.txt"), "changed after comparison\n");
    // The filesystem mutation models another editor after the visible list was loaded.
    await fileRow(panel, "result.txt").getByRole("checkbox").click();
    await expect(panel.getByTestId("review-stale")).toBeVisible();
    await expect(fileRow(panel, "result.txt").getByRole("checkbox")).not.toBeChecked();
    await expect(
      fileRow(panel, "result.txt").getByRole("button", { name: "Stage", exact: true }),
    ).toBeDisabled();
    expect(await git(workspacePath, "diff", "--cached", "--", "result.txt")).toBe("");
    await panel
      .getByTestId("review-stale")
      .getByRole("button", { name: "Refresh comparison", exact: true })
      .click();
    await openFile(panel, "result.txt");
    await expect(
      panel.getByRole("region", { name: "Combined changes", exact: true }),
    ).toContainText("changed after comparison");
    await fileRow(panel, "result.txt").getByRole("checkbox").click();
    await expect(panel.getByTestId("diff-panel-counter")).toHaveText("Reviewed 1 of 1");
  } finally {
    await harness.close();
  }
});

test("binary, oversized, and conflicted files show incomplete review coverage", async () => {
  test.setTimeout(60_000);
  const workspacePath = await makeWorkspace("review-coverage");
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "conflict.txt"), "baseline\n");
  await writeFile(join(workspacePath, "binary.bin"), Buffer.from([0, 1, 2]));
  await commitAllInGitRepo(workspacePath, "Baseline");
  await git(workspacePath, "switch", "-c", "other-change");
  await writeFile(join(workspacePath, "conflict.txt"), "theirs\n");
  await commitAllInGitRepo(workspacePath, "Theirs");
  await git(workspacePath, "switch", "main");
  await writeFile(join(workspacePath, "conflict.txt"), "ours\n");
  await commitAllInGitRepo(workspacePath, "Ours");
  await expect(git(workspacePath, "merge", "other-change")).rejects.toThrow();
  await writeFile(join(workspacePath, "binary.bin"), Buffer.from([0, 3, 4]));
  await writeFile(join(workspacePath, "oversized.txt"), Buffer.alloc(8 * 1024 * 1024 + 1, "x"));
  const { harness, panel } = await openReview(workspacePath);
  try {
    await expect(panel.locator(".diff-panel__file")).toHaveCount(3);
    await openFile(panel, "binary.bin");
    await expect(
      panel.getByTestId("review-coverage").filter({ hasText: "Binary file contents" }).first(),
    ).toBeVisible();
    await expect(panel.getByText("No changes", { exact: true })).toHaveCount(0);
    await openFile(panel, "oversized.txt");
    await expect(
      panel.getByTestId("review-coverage").filter({ hasText: "8 MiB" }).first(),
    ).toContainText("Comparison has limits");
    await openFile(panel, "conflict.txt");
    await expect(panel).toContainText("Unmerged index stages");
    await expect(
      panel.getByTestId("review-coverage").filter({ hasText: "Unmerged index" }).first(),
    ).toBeVisible();
    await expect(
      fileRow(panel, "conflict.txt").getByRole("button", { name: "Stage", exact: true }),
    ).toBeDisabled();
  } finally {
    await harness.close();
  }
});

test("choosing another review checkout preserves the task and terminal checkout", async () => {
  const workspacePath = await makeWorkspace("review-checkout-root");
  const worktreePath = join(await makeUserDataDir(), "linked-checkout");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "Baseline");
  await git(workspacePath, "worktree", "add", "-b", "review-linked", worktreePath);
  await writeFile(join(workspacePath, "root-only.txt"), "root changes\n");
  await writeFile(join(worktreePath, "linked-only.txt"), "linked changes\n");
  await writeFile(join(workspacePath, "shared.txt"), "root version\n");
  await writeFile(join(worktreePath, "shared.txt"), "linked version\n");
  const { harness, window, panel, workspace } = await openReview(workspacePath, [worktreePath]);
  try {
    const linked = await waitForWorkspaceByPath(window, await realpath(worktreePath));
    await window.getByTestId("composer").fill("Draft belongs to the original task");
    await expect(fileRow(panel, "root-only.txt")).toBeVisible();
    await expect(fileRow(panel, "linked-only.txt")).toHaveCount(0);
    await fileRow(panel, "shared.txt").getByRole("checkbox").click();
    await expect(fileRow(panel, "shared.txt").getByRole("checkbox")).toBeChecked();
    await window.getByLabel("Review checkout", { exact: true }).selectOption(linked.id);
    await expect(fileRow(panel, "linked-only.txt")).toBeVisible();
    await expect(fileRow(panel, "root-only.txt")).toHaveCount(0);
    await expect(fileRow(panel, "shared.txt").getByRole("checkbox")).not.toBeChecked();
    await expect(window.locator(".chat-header__title")).toHaveText("Review scope task");
    await expect(window.getByTestId("composer")).toHaveValue("Draft belongs to the original task");
    await openFile(panel, "linked-only.txt");
    await panel.getByRole("button", { name: "Open in Files", exact: true }).click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("linked changes");
    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await terminal.locator(".xterm").click();
    await window.keyboard.type("printf 'TASK_CWD=%s\\n' \"${PWD##*/}\"");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(
      `TASK_CWD=${basename(workspace.path)}`,
    );
    await expect(terminal.locator(".xterm-rows")).not.toContainText(
      `TASK_CWD=${basename(linked.path)}`,
    );
  } finally {
    await harness.close();
  }
});

test("an existing task without captures shows Last turn as unavailable", async () => {
  const workspacePath = await makeWorkspace("review-no-capture");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "Baseline");
  await writeFile(join(workspacePath, "manual.txt"), "manual change is not a captured turn\n");
  const { harness, window, panel } = await openReview(workspacePath);
  try {
    await window.getByLabel("Review scope", { exact: true }).selectOption("turn");
    await expect(panel.getByTestId("changed-files-unavailable")).toBeVisible();
    await expect(panel.getByTestId("changed-files-unavailable")).toContainText(/captur|turn/i);
    await expect(panel.locator(".diff-panel__file")).toHaveCount(0);
    await expect(panel.getByText("No changes", { exact: true })).toHaveCount(0);
    await window.getByLabel("Review scope", { exact: true }).selectOption("uncommitted");
    await expect(fileRow(panel, "manual.txt")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("large changed-file lists scroll with bounded row layout and expandable coverage", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const workspacePath = await makeWorkspace("large-review-list");
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "baseline.txt"), "baseline\n");
  await commitAllInGitRepo(workspacePath, "Baseline");
  for (let start = 0; start < 2000; start += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, offset) => {
        const index = start + offset;
        return writeFile(
          join(workspacePath, `file-${String(index).padStart(4, "0")}.txt`),
          `source ${index}\n`,
        );
      }),
    );
  }
  const { harness, window, panel } = await openReview(workspacePath);
  try {
    const rows = panel.locator(".diff-panel__file");
    await expect(rows).toHaveCount(2000, { timeout: 30_000 });
    const notice = panel.getByTestId("review-coverage").first();
    await expect(notice.locator("summary")).toHaveText("Comparison has limits");
    await expect(notice.locator("ul")).toBeHidden();
    await notice.locator("summary").click();
    await expect(notice.locator("ul")).toBeVisible();
    await notice.locator("summary").click();
    await expect(rows.first()).toHaveCSS("content-visibility", "auto");
    await expect(rows.first()).toHaveCSS("height", "36px");
    const list = panel.locator(".diff-panel__file-list");
    const box = (await list.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 80));
    // Record a short diagnostic sample; correctness does not depend on machine speed.
    await window.evaluate(() => {
      const samples: number[] = [];
      let previous = performance.now();
      const sample = (now: number) => {
        samples.push(now - previous);
        previous = now;
        if (samples.length < 120) requestAnimationFrame(sample);
      };
      Object.assign(window, { reviewScrollSamples: samples });
      requestAnimationFrame(sample);
    });
    for (let index = 0; index < 12; index += 1) await window.mouse.wheel(0, 160);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
    await window.screenshot({ path: testInfo.outputPath("large-review-scroll.png") });
    // Keyboard navigation must still reach off-screen actions.
    await fileRow(panel, "file-1999.txt").locator(".diff-panel__file-name").focus();
    await window.keyboard.press("Enter");
    await expect(
      panel.getByRole("region", { name: "Combined changes", exact: true }),
    ).toContainText("source 1999");
    await expect(fileRow(panel, "file-1999.txt")).toBeInViewport();
    await panel.getByTestId("diff-panel-reviewed-file-1999.txt").click();
    try {
      await expect(panel.getByTestId("diff-panel-reviewed-file-1999.txt")).toBeChecked();
    } finally {
      await window.screenshot({ path: testInfo.outputPath("large-review-mark.png") });
      await writeFile(testInfo.outputPath("review-status.txt"), await panel.innerText());
    }
    const samples = await window.evaluate((): unknown =>
      Reflect.get(window, "reviewScrollSamples"),
    );
    await writeFile(testInfo.outputPath("scroll-frames.json"), JSON.stringify(samples));
  } finally {
    await harness.close();
  }
});
