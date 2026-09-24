import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import {
  commitAllInGitRepo,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  type DesktopHarness,
} from "../../../../apps/desktop/tests/helpers/electron-app";
import { desktopShortcut } from "../../../../apps/desktop/tests/helpers/native-input";

test("maintenance: skills, pin, thread list, worktree, queued follow-ups", async () => {
  test.setTimeout(600_000);
  const evidence = process.env.PI_GUI_PROOF_DIR!;
  const source = process.env.PI_APP_REAL_AUTH_SOURCE_DIR;
  const provider = process.env.PI_GUI_PROVIDER;
  const model = process.env.PI_GUI_MODEL;
  if (process.env.PI_APP_REAL_AUTH !== "1" || !source || !provider || !model) {
    throw new Error(
      "BLOCKED: maintenance proof requires explicit real-auth source, provider and model; it never skips to a pass",
    );
  }
  const auth = JSON.parse(await readFile(join(source, "auth.json"), "utf8"));
  if (!auth[provider]) throw new Error(`BLOCKED: no saved credentials for ${provider}`);
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-gui-maintenance-private-"));
  await chmod(privateRoot, 0o700);
  const profile = join(privateRoot, "profile");
  const agentDir = join(privateRoot, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ [provider]: auth[provider] }), {
    mode: 0o600,
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: "off",
      enabledModels: [`${provider}/${model}`],
    }),
  );
  const workspace = await makeGitWorkspace("verify-maintenance");
  await mkdir(join(workspace, ".agents", "skills", "demo-skill"), { recursive: true });
  await writeFile(
    join(workspace, ".agents", "skills", "demo-skill", "SKILL.md"),
    "# Demo Skill\n\nUse this skill when the user wants a short demo workflow.\n",
  );
  await mkdir(join(workspace, ".agents", "skills", "plan-loop"), { recursive: true });
  await writeFile(
    join(workspace, ".agents", "skills", "plan-loop", "SKILL.md"),
    "# Plan Loop\n\nUse this skill for complex or high-risk implementation work that needs plan-first execution.\n",
  );
  await commitAllInGitRepo(workspace, "skills");
  const followWorkspace = join(evidence, "workspace");
  await mkdir(followWorkspace, { recursive: true });
  const runs: Array<{ pid: number; closed: boolean }> = [];
  const completed: string[] = [];
  let harness: DesktopHarness | undefined;
  let page: Page;
  let traceStarted = false;
  let phase = "surfaces";
  const checkpoint = async (name: string) => {
    await page.screenshot({ path: join(evidence, `${name}.png`) });
    await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
    completed.push(name);
    await writeFile(
      join(evidence, "progress.json"),
      JSON.stringify({ provider, model, completed }, null, 2),
    );
  };
  const launch = async (initialWorkspaces: string[], userDataDir = profile) => {
    harness = await launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces,
      scrubProviderEnv: true,
      envOverrides: { PI_APP_TEST_MODE: undefined },
    });
    runs.push({ pid: harness.electronApp.process().pid!, closed: false });
    await harness.focusWindow();
    page = await harness.firstWindow();
    const identity = await harness.electronApp.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid,
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      focused: BrowserWindow.getAllWindows()[0]?.isFocused(),
      testMode: process.env.PI_APP_TEST_MODE ?? null,
      testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
    }));
    const documentFocused = await page.evaluate(() => document.hasFocus());
    await writeFile(
      join(evidence, `${phase}-doctor.json`),
      JSON.stringify({ ...identity, documentFocused }, null, 2),
    );
    expect(identity).toMatchObject({ visible: true, testMode: null, testHooks: false });
    expect(identity.focused || documentFocused).toBe(true);
    expect(resolve(identity.appPath)).toBe(resolve("apps/desktop"));
    expect(resolve(identity.userData)).toBe(resolve(userDataDir));
    await harness.electronApp
      .context()
      .tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceStarted = true;
  };
  const close = async () => {
    if (!harness) return;
    const current = harness;
    harness = undefined;
    try {
      if (traceStarted)
        await current.electronApp.context().tracing.stop({ path: join(evidence, `${phase}.zip`) });
    } finally {
      traceStarted = false;
      const pid = current.electronApp.process().pid;
      await current.close();
      runs.find((run) => run.pid === pid)!.closed = true;
      await writeFile(join(evidence, "cleanup.json"), JSON.stringify(runs, null, 2));
    }
  };
  const startThread = async (prompt: string) => {
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await page.getByLabel("New thread prompt", { exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Stop run", {
      timeout: 30_000,
    });
  };
  const assistant = () => page.locator(".timeline-item--assistant .message__content");
  try {
    await launch([workspace]);
    await test.step("Start a thread from New thread and pin it while it runs", async () => {
      await startThread("Reply with exactly PIN_THREAD. Do not use tools.");
      const runningRow = page.locator(".session-row--active");
      await expect(runningRow).toHaveAttribute("data-sidebar-indicator", "running");
      await runningRow.hover();
      await page.getByRole("button", { name: /^Pin / }).click();
      await expect(page.getByRole("region", { name: "Pinned threads" })).toBeVisible();
      await page.getByRole("region", { name: "Pinned threads" }).locator(".session-row").hover();
      await page.getByRole("button", { name: /^Unpin / }).click();
      await expect(page.getByRole("region", { name: "Pinned threads" })).toHaveCount(0);
      await expect(runningRow).toHaveAttribute("data-sidebar-indicator", "running");
      await checkpoint("navigation-pin");
    });
    await test.step("Browse a workspace skill and insert it with Try", async () => {
      await page.getByRole("button", { name: "Skills", exact: true }).click();
      await expect(page.getByTestId("skills-surface")).toBeVisible();
      await expect(page.getByTestId("skills-list")).toContainText("Demo Skill");
      await page.getByRole("button", { name: /Demo Skill/i }).click();
      await expect(page.locator(".skill-detail")).toContainText("/skill:demo-skill");
      await page.getByRole("button", { name: "Try", exact: true }).click();
      await expect(page.getByTestId("composer")).toHaveValue("/skill:demo-skill ");
      await checkpoint("skills-try");
    });
    await test.step("Match a skill slash command by alias", async () => {
      const composer = page.getByTestId("composer");
      const slashMenu = page.getByTestId("slash-menu");
      await composer.fill("/plan");
      await expect(slashMenu).toContainText("Plan Loop");
      await expect(slashMenu).toContainText("/skill:plan-loop");
      await composer.fill("/plan-loop");
      await expect(slashMenu).toContainText("Plan Loop");
      await composer.fill("/skill:plan-loop");
      await expect(slashMenu).toContainText("Plan Loop");
      await composer.fill("");
      await checkpoint("skills-alias");
    });
    await test.step("Create threads from New thread until Today shows Show more", async () => {
      const showMore = page.getByRole("button", { name: "Show more Today" });
      for (let index = 2; index <= 6; index += 1) {
        if (await showMore.isVisible()) break;
        await startThread(`Reply with exactly FILLER_${index}. Do not use tools.`);
      }
      await expect(showMore).toBeVisible();
      await showMore.click();
      const showLess = page.getByRole("button", { name: "Show less Today" });
      await expect(showLess).toBeVisible();
      await showLess.click();
      await expect(showMore).toBeVisible();
      await checkpoint("navigation-thread-cap");
    });
    await test.step("Create a permanent worktree and require it in Git", async () => {
      const rootName = (await getDesktopState(page)).workspaces.find(
        (entry) => realpathSync(entry.path) === realpathSync(workspace),
      )?.name;
      expect(rootName).toBeTruthy();
      // Time grouping hides a folder row once that folder has threads.
      await page.getByRole("button", { name: "Customize Sidebar" }).click();
      await page.getByRole("menuitem", { name: "Grouping" }).click();
      await page.getByRole("menuitemradio", { name: "Workspace", exact: true }).click();
      const workspaceActions = page.getByRole("button", {
        name: `Workspace actions for ${rootName}`,
      });
      await expect(workspaceActions).toBeVisible();
      await workspaceActions.click();
      await page.getByRole("button", { name: "Create permanent worktree" }).click();
      let selectedPath = "";
      await expect
        .poll(
          async () => {
            const state = await getDesktopState(page);
            const selected = state.workspaces.find(
              (entry) => entry.id === state.selectedWorkspaceId,
            );
            selectedPath = selected?.kind === "worktree" ? selected.path : "";
            return selectedPath;
          },
          { timeout: 30_000 },
        )
        .not.toBe("");
      selectedPath = realpathSync(selectedPath);
      const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: workspace,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => realpathSync(line.slice("worktree ".length)));
      await writeFile(
        join(evidence, "worktree-git.json"),
        JSON.stringify({ selectedPath, listed }, null, 2),
      );
      expect(listed).toContain(selectedPath);
      expect(selectedPath).not.toBe(realpathSync(workspace));
      await page
        .getByRole("complementary")
        .getByRole("button", { name: "New thread", exact: true })
        .click();
      await expect(page.getByTestId("new-thread-composer")).toBeVisible();
      await expect(page.getByRole("button", { name: "Local", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Worktree", exact: true })).toBeVisible();
      await checkpoint("worktree");
    });
    await close();
    phase = "follow-ups";
    await launch([followWorkspace], join(privateRoot, "follow-profile"));
    await test.step("Queue Enter and steer with the platform-modified Enter", async () => {
      await startThread(
        'Use your bash or shell tool to run `python3 - <<\'PY\'\nimport time\nprint("queue-start")\ntime.sleep(8)\nprint("queue-end")\nPY` and, after the tool call, reply with exactly BASELINE_DONE.',
      );
      const composer = page.getByTestId("composer");
      await composer.fill(
        "After the current run fully finishes, reply with exactly FOLLOW_UP_DONE.",
      );
      await composer.press("Enter");
      await expect(
        page.getByTestId("queued-composer-message").filter({ hasText: "FOLLOW_UP_DONE" }),
      ).toHaveCount(1);
      await checkpoint("follow-up-queue");
      await composer.fill(
        "Change your pending final answer for the current run to exactly STEER_DONE.",
      );
      await composer.press(desktopShortcut("Enter"));
      await expect(
        page.getByTestId("queued-composer-message").filter({ hasText: "STEER_DONE" }),
      ).toHaveCount(0);
      await expect(assistant().filter({ hasText: "STEER_DONE" })).toHaveCount(1, {
        timeout: 180_000,
      });
      await expect(assistant().filter({ hasText: "FOLLOW_UP_DONE" })).toHaveCount(1, {
        timeout: 180_000,
      });
      const replies = await assistant().allTextContents();
      const steerIndex = replies.findIndex((text) => text.includes("STEER_DONE"));
      expect(steerIndex, "the steered reply is still mounted").toBeGreaterThanOrEqual(0);
      expect(steerIndex, "the steered reply precedes the queued follow-up").toBeLessThan(
        replies.findIndex((text) => text.includes("FOLLOW_UP_DONE")),
      );
      await expect(assistant().filter({ hasText: "BASELINE_DONE" })).toHaveCount(0);
      await expect(page.getByTestId("queued-composer-messages")).toHaveCount(0);
      await expect(page.locator(".session-row--active")).not.toHaveAttribute(
        "data-sidebar-indicator",
        "running",
        { timeout: 180_000 },
      );
      await checkpoint("follow-up-idle");
    });
  } catch (error) {
    if (harness && page!)
      await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        { result: "failed", provider, model, completed, error: String(error) },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await close();
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        result: test.info().errors.length ? "failed" : "passed",
        provider,
        model,
        completed,
        runs,
        assertionFailures: test.info().errors.map((error) => error.message),
      },
      null,
      2,
    ),
  );
});
