import { test, expect, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  commitAllInGitRepo,
  createNamedThread,
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  type DesktopHarness,
} from "../../../../apps/desktop/tests/helpers/electron-app";
import { desktopShortcut } from "../../../../apps/desktop/tests/helpers/native-input";

test("maintenance: skills, worktrees, pin, thread cap, queued follow-ups", async () => {
  test.setTimeout(420_000);
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
    `# Demo Skill

Use this skill when the user wants a short demo workflow.
`,
  );
  await mkdir(join(workspace, ".agents", "skills", "plan-loop"), { recursive: true });
  await writeFile(
    join(workspace, ".agents", "skills", "plan-loop", "SKILL.md"),
    `# Plan Loop

Use this skill for complex or high-risk implementation work that needs plan-first execution.
`,
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
  const assistant = () => page.locator(".timeline-item--assistant .message__content");
  try {
    await launch([workspace]);
    await test.step("Browse a workspace skill and insert it with Try", async () => {
      await createNamedThread(page, "Skill thread");
      await page.getByRole("button", { name: "Skills", exact: true }).click();
      await expect(page.locator(".skills-view")).toBeVisible();
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
      await checkpoint("skills-alias");
    });
    await test.step("Pin and unpin a thread from the sidebar", async () => {
      const row = page.locator(".session-row", { hasText: "Skill thread" });
      await row.hover();
      await page.getByRole("button", { name: /Pin Skill thread/ }).click();
      const pinned = page.getByRole("region", { name: "Pinned threads" });
      await expect(pinned).toBeVisible();
      await expect(pinned.locator(".session-row__title")).toContainText("Skill thread");
      await pinned.locator(".session-row", { hasText: "Skill thread" }).hover();
      await page.getByRole("button", { name: /Unpin Skill thread/ }).click();
      await expect(page.getByRole("region", { name: "Pinned threads" })).toHaveCount(0);
      await checkpoint("navigation-pin");
    });
    await test.step("Cap folder history at five threads with Show more", async () => {
      const workspaceId = await page.locator(".session-row--active").evaluate((el) => {
        const group = el.closest("[data-workspace-id]");
        return group instanceof HTMLElement ? (group.dataset.workspaceId ?? "") : "";
      });
      expect(workspaceId).toBeTruthy();
      for (const title of ["Thread 2", "Thread 3", "Thread 4", "Thread 5", "Thread 6"]) {
        await createSessionViaIpc(page, workspaceId, title);
      }
      const group = page.locator(".workspace-group").first();
      const showMore = group.getByRole("button", { name: "Show more", exact: true });
      await expect(showMore).toBeVisible();
      await showMore.click();
      await expect(group.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
      await group.getByRole("button", { name: "Show less", exact: true }).click();
      await expect(showMore).toBeVisible();
      await checkpoint("navigation-thread-cap");
    });
    await test.step("Create a permanent worktree and show Local/Worktree", async () => {
      await page
        .getByRole("button", { name: `Workspace actions for ${basename(workspace)}` })
        .click();
      await page.getByRole("button", { name: "Create permanent worktree" }).click();
      await expect
        .poll(
          async () => {
            const state = await getDesktopState(page);
            return (
              state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId)?.kind ?? ""
            );
          },
          { timeout: 30_000 },
        )
        .toBe("worktree");
      await expect(page.locator(".empty-panel")).toContainText("Create a thread for this folder");
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
      await page
        .getByRole("complementary")
        .getByRole("button", { name: "New thread", exact: true })
        .click();
      await page
        .getByLabel("New thread prompt", { exact: true })
        .fill(
          'Use your bash or shell tool to run `python3 - <<\'PY\'\nimport time\nprint("queue-start")\ntime.sleep(8)\nprint("queue-end")\nPY` and, after the tool call, reply with exactly BASELINE_DONE.',
        );
      await page.getByRole("button", { name: "Start thread", exact: true }).click();
      await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Stop run", {
        timeout: 30_000,
      });
      const composer = page.getByTestId("composer");
      await composer.fill(
        "After the current run fully finishes, reply with exactly FOLLOW_UP_DONE.",
      );
      await composer.press("Enter");
      await expect(
        page.getByTestId("queued-composer-message").filter({ hasText: "FOLLOW_UP_DONE" }),
      ).toHaveCount(1);
      await checkpoint("follow-up-queue");
      const runningRow = page.locator(".session-row--active");
      await expect(runningRow).toHaveAttribute("data-sidebar-indicator", "running");
      await runningRow.hover();
      await page.getByRole("button", { name: /^Pin / }).click();
      await expect(page.getByRole("region", { name: "Pinned threads" })).toBeVisible();
      await page.getByRole("region", { name: "Pinned threads" }).locator(".session-row").hover();
      await page.getByRole("button", { name: /^Unpin / }).click();
      await expect(runningRow).toHaveAttribute("data-sidebar-indicator", "running");
      await checkpoint("navigation-pin-running");
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
