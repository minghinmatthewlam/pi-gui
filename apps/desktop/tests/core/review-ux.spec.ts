import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  commitAllInGitRepo,
  createNamedThread,
  desktopShortcut,
  emitTestSessionEvent,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

async function selectedSessionRef(window: Parameters<typeof getDesktopState>[0]): Promise<SessionRef> {
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
  await writeFile(
    join(workspacePath, "script.py"),
    "def hello():\n    return 'hi'\n",
    "utf8",
  );
  await writeFile(join(workspacePath, "notes.md"), "# notes\n\nMore.\n", "utf8");
  return workspacePath;
}

test("syntax-highlights known languages and leaves unknown extensions plain", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await seedThreeFileWorkspace();

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Review UX highlight");

    await window.keyboard.press(desktopShortcut("D"));
    const diffPanel = window.locator(".diff-panel");
    await expect(diffPanel).toBeVisible();

    const tsRow = diffPanel.locator('.diff-panel__file[data-file-path="src/foo.ts"]');
    await expect(tsRow).toBeVisible();
    await tsRow.locator(".diff-panel__file-name").click();
    const tsDiff = diffPanel.locator(".diff-inline");
    await expect(tsDiff).toHaveAttribute("data-language", "typescript");
    await expect(tsDiff.locator('[class*="hljs-"]').first()).toBeVisible();

    const pyRow = diffPanel.locator('.diff-panel__file[data-file-path="script.py"]');
    await pyRow.locator(".diff-panel__file-name").click();
    await expect(diffPanel.locator(".diff-inline")).toHaveAttribute("data-language", "python");
    await expect(diffPanel.locator('.diff-inline [class*="hljs-"]').first()).toBeVisible();

    const mdRow = diffPanel.locator('.diff-panel__file[data-file-path="notes.md"]');
    await mdRow.locator(".diff-panel__file-name").click();
    const mdDiff = diffPanel.locator(".diff-inline");
    await expect(mdDiff).not.toHaveAttribute("data-language", /.*/);
    await expect(mdDiff.locator('[class*="hljs-"]')).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("reviewed checkboxes update counter, prune on changes, and survive relaunch", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await seedThreeFileWorkspace();

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    let window = await harness.firstWindow();
    await createNamedThread(window, "Review UX checkboxes");
    const sessionRef = await selectedSessionRef(window);

    await window.keyboard.press(desktopShortcut("D"));
    const diffPanel = window.locator(".diff-panel");
    await expect(diffPanel).toBeVisible();
    await expect(diffPanel.locator(".diff-panel__file")).toHaveCount(3);

    const counter = diffPanel.getByTestId("diff-panel-counter");
    await expect(counter).toHaveText("Reviewed 0 of 3");

    await diffPanel.getByTestId("diff-panel-reviewed-src/foo.ts").check();
    await expect(counter).toHaveText("Reviewed 1 of 3");
    await expect(diffPanel.locator('.diff-panel__file[data-file-path="src/foo.ts"]')).toHaveClass(
      /diff-panel__file--reviewed/,
    );

    const storageKey = `pi-gui:reviewed-files:v1:${sessionRef.workspaceId}:${sessionRef.sessionId}`;
    const stored = await window.evaluate((key) => globalThis.localStorage.getItem(key), storageKey);
    expect(stored).toBe(JSON.stringify(["src/foo.ts"]));

    await diffPanel.getByTestId("diff-panel-reviewed-src/foo.ts").uncheck();
    await expect(counter).toHaveText("Reviewed 0 of 3");
    await expect(
      diffPanel.locator('.diff-panel__file[data-file-path="src/foo.ts"]'),
    ).not.toHaveClass(/diff-panel__file--reviewed/);

    await diffPanel.getByTestId("diff-panel-reviewed-src/foo.ts").check();
    await diffPanel.getByTestId("diff-panel-reviewed-script.py").check();
    await expect(counter).toHaveText("Reviewed 2 of 3");

    await harness.close();

    const reopened = await launchDesktop(userDataDir, { testMode: "background" });
    window = await reopened.firstWindow();
    try {
      await window.keyboard.press(desktopShortcut("D"));
      const reopenedPanel = window.locator(".diff-panel");
      await expect(reopenedPanel).toBeVisible();
      await expect(reopenedPanel.getByTestId("diff-panel-counter")).toHaveText("Reviewed 2 of 3");
      await expect(reopenedPanel.getByTestId("diff-panel-reviewed-src/foo.ts")).toBeChecked();
      await expect(reopenedPanel.getByTestId("diff-panel-reviewed-script.py")).toBeChecked();
      await expect(reopenedPanel.getByTestId("diff-panel-reviewed-notes.md")).not.toBeChecked();

      await commitAllInGitRepo(workspacePath, "land foo");
      await reopenedPanel.locator('button[aria-label="Refresh"]').click();
      await expect(reopenedPanel.locator(".diff-panel__file")).toHaveCount(2);
      await expect(reopenedPanel.getByTestId("diff-panel-counter")).toHaveText("Reviewed 1 of 2");

      const prunedStored = await window.evaluate(
        (key) => globalThis.localStorage.getItem(key),
        storageKey,
      );
      expect(prunedStored).toBe(JSON.stringify(["script.py"]));
    } finally {
      await reopened.close();
    }
  } finally {
    // best-effort if a relaunch failed mid-test
    if (!harness.electronApp.windows().length) return;
    await harness.close().catch(() => undefined);
  }
});

test("view-in-changes button on a write tool row opens the diff panel without toggling expand", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await seedThreeFileWorkspace();

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Review UX tool link");
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
    await expect(diffPanel.locator(".diff-inline")).toHaveAttribute("data-language", "typescript");

    await toolHeader.click();
    await expect(toolHeader).toHaveAttribute("aria-expanded", "true");
  } finally {
    await harness.close();
  }
});

test("highlighting tokens swap palettes when the dark class flips", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await seedThreeFileWorkspace();

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Review UX theme");
    await window.keyboard.press(desktopShortcut("D"));

    const diffPanel = window.locator(".diff-panel");
    await diffPanel
      .locator('.diff-panel__file[data-file-path="src/foo.ts"] .diff-panel__file-name')
      .click();
    const token = diffPanel.locator('.diff-inline [class*="hljs-"]').first();
    await expect(token).toBeVisible();

    const initiallyDark = await window.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );

    const colorBefore = await token.evaluate((el) => getComputedStyle(el).color);

    await window.evaluate((wasDark) => {
      document.documentElement.classList.toggle("dark", !wasDark);
    }, initiallyDark);

    const colorAfter = await token.evaluate((el) => getComputedStyle(el).color);
    expect(colorAfter).not.toBe(colorBefore);
  } finally {
    await harness.close();
  }
});
