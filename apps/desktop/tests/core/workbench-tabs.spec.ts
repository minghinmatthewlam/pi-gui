import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  commitAllInGitRepo,
  desktopShortcut,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
  selectSidePanel,
  type DesktopHarness,
} from "../helpers/electron-app";

const TASK_A = "Workbench task A";
const TASK_B = "Workbench task B";
type ToolName = "Files" | "Changes" | "Worktrees" | "Terminal";

// Real Pi history is fixture setup. All workspace, task, tab, and draft changes
// below use the visible app, with no provider requests or injected runtime events.
async function prepareWorkspace() {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("workbench-tabs");
  await writeFile(join(workspacePath, "alpha.txt"), "Alpha document\nAlpha target line\n");
  await writeFile(join(workspacePath, "beta.txt"), "Beta document\nBeta target line\n");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "Workbench fixture");
  await writeFile(
    join(workspacePath, "alpha.txt"),
    "Alpha document\nAlpha target line\nUncommitted workspace edit\n",
  );
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  for (const [title, file] of [
    [TASK_A, "alpha.txt"],
    [TASK_B, "beta.txt"],
  ] as const) {
    await seedNamedTextSessionFixture(agentDir, workspacePath, {
      title,
      userText: `Inspect ${file}`,
      assistantText: `Open ${file}:2 for the result.`,
    });
  }
  return { userDataDir, agentDir, workspacePath };
}

async function expectActiveTool(window: Page, name: ToolName): Promise<void> {
  await expect(window.getByTestId("workbench")).toBeVisible();
  await expect(
    window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab", {
      name,
      exact: true,
    }),
  ).toHaveAttribute("aria-selected", "true");
}

async function addTool(window: Page, name: ToolName): Promise<void> {
  await window.getByTestId("workbench-add-tab").click();
  const chooser = window.getByTestId("workbench-chooser");
  await expect(chooser).toBeVisible();
  await chooser.getByRole("button", { name, exact: true }).click();
  await expectActiveTool(window, name);
}

async function openSecondWindow(harness: DesktopHarness): Promise<Page> {
  const existing = new Set(harness.electronApp.windows());
  // The app's native New Window shortcut is handled in before-input-event.
  await harness.electronApp.evaluate(
    ({ BrowserWindow }, modifier) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "n",
        modifiers: [modifier],
      });
    },
    process.platform === "darwin" ? "meta" : "control",
  );
  await expect.poll(() => harness.electronApp.windows().length).toBe(existing.size + 1);
  const opened = harness.electronApp.windows().find((candidate) => !existing.has(candidate));
  if (!opened) throw new Error("Expected New Window to create a second desktop window");
  await opened.waitForLoadState("domcontentloaded");
  return opened;
}

async function captureToolWidths(
  harness: DesktopHarness,
  window: Page,
  testInfo: TestInfo,
  tool: ToolName,
): Promise<void> {
  for (const width of [1280, 1040]) {
    await harness.electronApp.evaluate(({ BrowserWindow }, nextWidth) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(nextWidth, 900);
    }, width);
    await expect.poll(() => window.evaluate(() => globalThis.window.innerWidth)).toBe(width);
    await expectActiveTool(window, tool);
    await expect(window.getByTestId("composer")).toBeVisible();
    const path = testInfo.outputPath(`${tool.toLowerCase()}-${width}.png`);
    await window.screenshot({ path, animations: "disabled" });
    await testInfo.attach(`${tool} at ${width}px`, { path, contentType: "image/png" });
  }
}

test("adds singleton tool tabs, closes to a neighbor, and keeps an empty chooser", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expectActiveTool(window, "Changes");
    await addTool(window, "Files");
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    await window.locator('.file-workbench__tree-row--file[data-file-path="alpha.txt"]').click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await captureToolWidths(harness, window, testInfo, "Files");
    await addTool(window, "Worktrees");
    await expect(window.getByTestId("workbench")).toContainText("workbench-tabs");
    await addTool(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await window.keyboard.type("printf 'WORKBENCH_'\"READY\\n\"; pwd");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("WORKBENCH_READY");
    await captureToolWidths(harness, window, testInfo, "Terminal");
    await addTool(window, "Changes");
    await expect(window.locator(".diff-panel")).toBeVisible();
    await window
      .locator('.diff-panel__file[data-file-path="alpha.txt"] .diff-panel__file-name')
      .click();
    await expect(window.locator(".diff-inline")).toContainText("Uncommitted workspace edit");
    await captureToolWidths(harness, window, testInfo, "Changes");
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveText(["Changes", "Files", "Worktrees", "Terminal"]);
    await addTool(window, "Terminal");
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveCount(4);

    await window.getByRole("button", { name: "Close Terminal tab", exact: true }).click();
    await expectActiveTool(window, "Worktrees");
    await window.getByRole("button", { name: "Close Worktrees tab", exact: true }).click();
    await expectActiveTool(window, "Files");
    await window.getByRole("button", { name: "Close Files tab", exact: true }).click();
    await expectActiveTool(window, "Changes");
    await window.getByRole("button", { name: "Close Changes tab", exact: true }).click();
    await expect(window.getByTestId("workbench-chooser")).toBeVisible();
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveCount(0);
    await window
      .getByTestId("workbench-chooser")
      .getByRole("button", {
        name: "Files",
        exact: true,
      })
      .click();
    await window.getByTestId("toggle-side-panel").click();
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await window.getByTestId("toggle-side-panel").click();
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-workbench")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("restores each task's tabs and draft through Settings, switching, and restart", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  let harness = await launchDesktop(fixture.userDataDir, options);
  try {
    let window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Files");
    await window.locator('.file-workbench__tree-row--file[data-file-path="alpha.txt"]').click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await window.getByTestId("composer").fill("Draft for task A");

    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Changes");
    await expect(window.getByRole("tab", { name: "Files", exact: true })).toHaveCount(0);
    await addTool(window, "Worktrees");
    await window.getByTestId("composer").fill("Draft for task B");
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expectActiveTool(window, "Worktrees");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task B");
    await window.getByTestId("composer").click();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("settings-surface")).toHaveCount(0);
    await expectActiveTool(window, "Worktrees");

    await selectSession(window, TASK_A);
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task A");
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await window.getByTestId("toggle-side-panel").click();
    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Worktrees");
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toHaveCount(0);

    await harness.close();
    harness = await launchDesktop(fixture.userDataDir, options);
    window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task A");
    await window.getByTestId("toggle-side-panel").click();
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Worktrees");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task B");
  } finally {
    await harness.close();
  }
});

test("assistant file links keep the opened document with their originating task", async () => {
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await window.getByTestId("toggle-side-panel").click();
    await window.getByTestId("workspace-file-link").filter({ hasText: "alpha.txt:2" }).click();
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-line-mark")).toContainText("Alpha target line");
    await selectSession(window, TASK_B);
    await window.getByTestId("workspace-file-link").filter({ hasText: "beta.txt:2" }).click();
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-line-mark")).toContainText("Beta target line");
    await expect(window.getByTestId("file-workbench-tab")).toHaveCount(1);
    await expect(window.getByTestId("file-workbench-tab")).toContainText("beta.txt");
    await selectSession(window, TASK_A);
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-workbench-tab")).toHaveCount(1);
    await expect(window.getByTestId("file-workbench-tab")).toContainText("alpha.txt");
    await expect(window.getByTestId("file-line-mark")).toContainText("Alpha target line");
  } finally {
    await harness.close();
  }
});

test("closing the Terminal view preserves its live shell", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await terminal.locator(".xterm").click();
    await window.keyboard.type(
      "export PI_GUI_WORKBENCH_CANARY=retained; printf 'SHELL_'\"READY\\n\"",
    );
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("SHELL_READY");
    await window.getByRole("button", { name: "Close Terminal tab", exact: true }).click();
    await expect(terminal).toHaveCount(0);
    await expectActiveTool(window, "Changes");
    await addTool(window, "Terminal");
    await terminal.locator(".xterm").click();
    await window.keyboard.type("printf 'SHELL_%s\\n' \"$PI_GUI_WORKBENCH_CANARY\"");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("SHELL_retained");
    await expect(window.getByTestId("terminal-tab")).toHaveCount(1);
  } finally {
    await harness.close();
  }
});

test("two windows keep independent live tool selections for the same task", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const first = await harness.firstWindow();
    await selectSession(first, TASK_A);
    await addTool(first, "Files");
    const second = await openSecondWindow(harness);
    await selectSession(second, TASK_A);
    await expectActiveTool(second, "Files");
    await addTool(second, "Worktrees");
    await expectActiveTool(first, "Files");
    await expect(first.getByRole("tab", { name: "Worktrees", exact: true })).toHaveCount(0);
    await selectSidePanel(first, "Changes");
    await expectActiveTool(second, "Worktrees");
    await first.getByTestId("toggle-side-panel").click();
    await expect(first.getByTestId("workbench")).toHaveCount(0);
    await expectActiveTool(second, "Worktrees");
  } finally {
    await harness.close();
  }
});
