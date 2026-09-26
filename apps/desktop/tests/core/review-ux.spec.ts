import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  commitAllInGitRepo,
  createNamedThread,
  selectSidePanel,
  emitTestSessionEvent,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

async function commitFiles(
  workspacePath: string,
  paths: readonly string[],
  message: string,
): Promise<void> {
  await execFileAsync("git", ["add", "--", ...paths], { cwd: workspacePath });
  await execFileAsync("git", ["commit", "-m", message], { cwd: workspacePath });
}

async function selectedSessionRef(window: Page): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

async function seedThreeFileWorkspace(): Promise<string> {
  const workspacePath = await makeWorkspace("review-ux-workspace");
  await initGitRepo(workspacePath);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "src", "foo.ts"), "export const x = 0;\n", "utf8");
  await writeFile(join(workspacePath, "script.py"), "def hello():\n    pass\n", "utf8");
  await writeFile(join(workspacePath, "notes.md"), "# notes\n", "utf8");
  await commitAllInGitRepo(workspacePath, "init");

  await writeFile(
    join(workspacePath, "src", "foo.ts"),
    "export const x = 1; // changed\nexport function add(a: number, b: number) { return a + b; }\n",
    "utf8",
  );
  await writeFile(join(workspacePath, "script.py"), "def hello():\n    return 'hi'\n", "utf8");
  await writeFile(join(workspacePath, "notes.md"), "# notes\n\nMore.\n", "utf8");
  return workspacePath;
}

async function launchSeeded(threadTitle: string): Promise<{
  readonly harness: Awaited<ReturnType<typeof launchDesktop>>;
  readonly window: Page;
  readonly userDataDir: string;
  readonly workspacePath: string;
}> {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await seedThreeFileWorkspace();
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const window = await harness.firstWindow();
  await createNamedThread(window, threadTitle);
  return { harness, window, userDataDir, workspacePath };
}

test("syntax-highlights known languages and leaves unknown extensions plain", async () => {
  test.setTimeout(45_000);
  const { harness, window } = await launchSeeded("Review UX highlight");
  try {
    await selectSidePanel(window, "Review");
    const diffPanel = window.locator(".diff-panel");
    await expect(diffPanel).toBeVisible();

    const tsRow = diffPanel.locator('.diff-panel__file[data-file-path="src/foo.ts"]');
    await expect(tsRow).toBeVisible();
    await tsRow.locator(".diff-panel__file-name").click();
    const tsDiff = diffPanel
      .getByRole("region", { name: "Diff", exact: true })
      .locator(".diff-inline");
    await expect(tsDiff).toHaveAttribute("data-language", "typescript");
    await expect(tsDiff.locator('span[style*="color"]').first()).toBeVisible();

    const pyRow = diffPanel.locator('.diff-panel__file[data-file-path="script.py"]');
    await pyRow.locator(".diff-panel__file-name").click();
    await expect(
      diffPanel.getByRole("region", { name: "Diff", exact: true }).locator(".diff-inline"),
    ).toHaveAttribute("data-language", "python");
    await expect(
      diffPanel
        .getByRole("region", { name: "Diff", exact: true })
        .locator('.diff-inline span[style*="color"]')
        .first(),
    ).toBeVisible();

    const mdRow = diffPanel.locator('.diff-panel__file[data-file-path="notes.md"]');
    await mdRow.locator(".diff-panel__file-name").click();
    const mdDiff = diffPanel
      .getByRole("region", { name: "Diff", exact: true })
      .locator(".diff-inline");
    await expect(mdDiff).not.toHaveAttribute("data-language", /.*/);
    await expect(mdDiff.locator('span[style*="color"]')).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("reviewed marks survive relaunch and apply only to the reviewed file revision", async () => {
  test.setTimeout(60_000);
  const {
    harness,
    window: firstWindow,
    userDataDir,
    workspacePath,
  } = await launchSeeded("Review UX checkboxes");
  const sessionRef = await selectedSessionRef(firstWindow);
  // Legacy renderer marks are fixture state: they must not become authoritative,
  // and replacing the store must not delete the user's old bytes.
  const storageKey = `pi-gui:reviewed-files:v1:${sessionRef.workspaceId}:${sessionRef.sessionId}`;
  const legacyValue = JSON.stringify([JSON.stringify([sessionRef.workspaceId, "notes.md"])]);
  try {
    await firstWindow.evaluate(({ key, value }) => globalThis.localStorage.setItem(key, value), {
      key: storageKey,
      value: legacyValue,
    });

    await selectSidePanel(firstWindow, "Review");
    const diffPanel = firstWindow.locator(".diff-panel");
    await expect(diffPanel).toBeVisible();
    await expect(diffPanel.locator(".diff-panel__file")).toHaveCount(3);

    const counter = diffPanel.getByTestId("diff-panel-counter");
    await expect(counter).toHaveText("Reviewed 0 of 3");

    await diffPanel.getByTestId("diff-panel-reviewed-src/foo.ts").click();
    await expect(counter).toHaveText("Reviewed 1 of 3");
    await expect(diffPanel.locator('.diff-panel__file[data-file-path="src/foo.ts"]')).toHaveClass(
      /diff-panel__file--reviewed/,
    );

    await diffPanel.getByTestId("diff-panel-reviewed-src/foo.ts").click();
    await expect(counter).toHaveText("Reviewed 0 of 3");
    await expect(
      diffPanel.locator('.diff-panel__file[data-file-path="src/foo.ts"]'),
    ).not.toHaveClass(/diff-panel__file--reviewed/);

    await diffPanel.getByTestId("diff-panel-reviewed-src/foo.ts").click();
    await diffPanel.getByTestId("diff-panel-reviewed-script.py").click();
    await expect(counter).toHaveText("Reviewed 2 of 3");
  } finally {
    await harness.close();
  }

  const reopened = await launchDesktop(userDataDir, { testMode: "background" });
  const window = await reopened.firstWindow();
  try {
    await expect(window.locator(".chat-header__title")).toBeVisible();
    await selectSidePanel(window, "Review");
    const reopenedPanel = window.locator(".diff-panel");
    await expect(reopenedPanel).toBeVisible();
    await expect(reopenedPanel.getByTestId("diff-panel-counter")).toHaveText("Reviewed 2 of 3");
    await expect(reopenedPanel.getByTestId("diff-panel-reviewed-src/foo.ts")).toBeChecked();
    await expect(reopenedPanel.getByTestId("diff-panel-reviewed-script.py")).toBeChecked();
    await expect(reopenedPanel.getByTestId("diff-panel-reviewed-notes.md")).not.toBeChecked();

    await commitFiles(workspacePath, ["src/foo.ts"], "land foo");
    await reopenedPanel.locator('button[aria-label="Refresh"]').click();
    await expect(reopenedPanel.locator(".diff-panel__file")).toHaveCount(2);
    await expect(reopenedPanel.getByTestId("diff-panel-counter")).toHaveText("Reviewed 1 of 2");

    await expect(reopenedPanel.getByTestId("diff-panel-reviewed-script.py")).toBeChecked();
    await writeFile(
      join(workspacePath, "script.py"),
      "def hello():\n    return 'a new revision'\n",
      "utf8",
    );
    await reopenedPanel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(reopenedPanel.getByTestId("diff-panel-reviewed-script.py")).not.toBeChecked();
    await expect(reopenedPanel.getByTestId("diff-panel-counter")).toHaveText("Reviewed 0 of 2");
    expect(await window.evaluate((key) => globalThis.localStorage.getItem(key), storageKey)).toBe(
      legacyValue,
    );
  } finally {
    await reopened.close();
  }
});

test("a new file at a renamed file's old path can be marked reviewed", async () => {
  test.setTimeout(45_000);
  const { harness, window, workspacePath } = await launchSeeded("Review UX rename");
  try {
    await execFileAsync("git", ["mv", "notes.md", "renamed.md"], { cwd: workspacePath });
    await writeFile(join(workspacePath, "notes.md"), "# a new notes file\n", "utf8");
    await selectSidePanel(window, "Review");
    const diffPanel = window.locator(".diff-panel");
    await expect(diffPanel).toBeVisible();
    await diffPanel.locator('button[aria-label="Refresh"]').click();
    const recreated = diffPanel.getByTestId("diff-panel-reviewed-notes.md");
    await expect(recreated).toBeVisible();
    await recreated.click();
    await expect(recreated).toBeChecked();
    await expect(diffPanel.locator('.diff-panel__file[data-file-path="notes.md"]')).toHaveClass(
      /diff-panel__file--reviewed/,
    );
  } finally {
    await harness.close();
  }
});

test("Files mode shows a file browser and reader instead of the changes reviewer", async () => {
  test.setTimeout(45_000);
  const { harness, window } = await launchSeeded("Review UX files mode");
  try {
    await selectSidePanel(window, "Review");
    const diffPanel = window.locator(".diff-panel");
    await expect(diffPanel).toBeVisible();
    await expect(diffPanel).toHaveAttribute("aria-label", "Review");
    await expect(diffPanel.getByTestId("diff-panel-counter")).toHaveText("Reviewed 0 of 3");

    await diffPanel
      .locator('.diff-panel__file[data-file-path="src/foo.ts"] .diff-panel__file-name')
      .click();
    await expect(
      diffPanel.getByRole("region", { name: "Diff", exact: true }).locator(".diff-inline"),
    ).toBeVisible();

    await selectSidePanel(window, "Files");
    const workbench = window.getByTestId("file-workbench");
    await expect(workbench).toBeVisible();
    await expect(window.locator(".diff-panel")).toHaveCount(0);
    await expect(workbench.getByTestId("diff-panel-counter")).toHaveCount(0);
    await expect(workbench.locator(".file-workbench__section--changes")).toHaveCount(0);
    await expect(workbench.getByTestId("file-workbench-tree")).toBeVisible();
    await expect(workbench.locator(".file-workbench__context-strip")).toHaveCount(0);
    await expect(window.getByTestId("file-workbench-filter")).toBeVisible();

    await workbench.locator('.file-workbench__tree-row--file[data-file-path="notes.md"]').click();
    await expect(
      window.getByTestId("file-editor").getByTestId("file-workbench-preview"),
    ).toContainText("notes");
    await expect(window.getByTestId("file-editor").locator(".diff-inline")).toHaveCount(0);
    await expect(
      window.getByTestId("file-editor").getByRole("button", { name: "View source" }),
    ).toBeVisible();
    await window.getByTestId("file-editor").getByRole("button", { name: "View source" }).click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("# notes");
    await expect(
      window.getByTestId("file-editor").getByRole("button", { name: "Open" }),
    ).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("view-in-changes button on a write tool row opens the diff panel without toggling expand", async () => {
  test.setTimeout(45_000);
  const { harness, window } = await launchSeeded("Review UX tool link");
  try {
    const sessionRef = await selectedSessionRef(window);

    const diffPanel = window.locator(".diff-panel");
    await expect(diffPanel).toHaveCount(0);

    const timestamp = new Date().toISOString();
    const startedEvent: Extract<SessionDriverEvent, { type: "toolStarted" }> = {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: "Edit",
      callId: "review-ux-edit-1",
      input: { file_path: "src/foo.ts" },
    };
    await emitTestSessionEvent(harness, startedEvent);

    const finishedEvent: Extract<SessionDriverEvent, { type: "toolFinished" }> = {
      type: "toolFinished",
      sessionRef,
      timestamp,
      callId: "review-ux-edit-1",
      success: true,
    };
    await emitTestSessionEvent(harness, finishedEvent);

    const viewButton = window.getByTestId("timeline-tool-view-in-diff");
    await expect(viewButton).toBeVisible();

    const toolHeader = window.locator(".timeline-tool__header").first();
    await expect(toolHeader).toHaveAttribute("aria-expanded", "false");

    await viewButton.click();
    await expect(diffPanel).toBeVisible();
    await expect(toolHeader).toHaveAttribute("aria-expanded", "false");

    const selectedRow = diffPanel.locator('.diff-panel__file[data-file-path="src/foo.ts"]');
    await expect(selectedRow).toHaveClass(/diff-panel__file--selected/);
    await expect(
      diffPanel.getByRole("region", { name: "Diff", exact: true }).locator(".diff-inline"),
    ).toHaveAttribute("data-language", "typescript");

    await toolHeader.click();
    await expect(toolHeader).toHaveAttribute("aria-expanded", "true");
  } finally {
    await harness.close();
  }
});

test("highlighting follows the theme when light or dark changes", async () => {
  test.setTimeout(45_000);
  const { harness, window } = await launchSeeded("Review UX theme");
  try {
    await selectSidePanel(window, "Review");

    const diffPanel = window.locator(".diff-panel");
    await diffPanel
      .locator('.diff-panel__file[data-file-path="src/foo.ts"] .diff-panel__file-name')
      .click();
    const token = diffPanel
      .getByRole("region", { name: "Diff", exact: true })
      .locator('.diff-inline span[style*="color"]')
      .first();
    await expect(token).toBeVisible();

    const initiallyDark = await window.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    const colorBefore = await token.evaluate((el) => getComputedStyle(el).color);

    await window.evaluate(async (wasDark) => {
      await globalThis.window.piApp?.setThemeMode(wasDark ? "light" : "dark");
    }, initiallyDark);

    await expect
      .poll(() => window.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(!initiallyDark);
    await expect
      .poll(() => token.evaluate((el) => getComputedStyle(el).color))
      .not.toBe(colorBefore);
  } finally {
    await harness.close();
  }
});
