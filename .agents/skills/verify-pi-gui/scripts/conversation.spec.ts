import { test, expect, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  launchDesktop,
  type DesktopHarness,
} from "../../../../apps/desktop/tests/helpers/electron-app";

test("real conversation: stream, switch, tool, stop, archive, restart", async () => {
  test.setTimeout(360_000);
  const evidence = process.env.PI_GUI_PROOF_DIR!;
  const source = process.env.PI_APP_REAL_AUTH_SOURCE_DIR;
  const provider = process.env.PI_GUI_PROVIDER;
  const model = process.env.PI_GUI_MODEL;
  if (process.env.PI_APP_REAL_AUTH !== "1" || !source || !provider || !model) {
    throw new Error(
      "BLOCKED: conversation proof requires explicit real-auth source, provider and model; it never skips to a pass",
    );
  }
  const auth = JSON.parse(await readFile(join(source, "auth.json"), "utf8"));
  if (!auth[provider]) throw new Error(`BLOCKED: no saved credentials for ${provider}`);
  // Keep copied credentials outside the shareable evidence directory.
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-gui-conversation-private-"));
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
  const workspace = join(evidence, "workspace");
  await mkdir(workspace, { recursive: true });
  const runs: Array<{ pid: number; closed: boolean }> = [];
  const completed: string[] = [];
  const drafts = { alpha: "Unsent draft for Alpha", bravo: "Unsent draft for Bravo" };
  let alpha = "";
  let bravo = "";
  let harness: DesktopHarness | undefined;
  let page: Page;
  let traceStarted = false;
  let phase = "conversation";
  const checkpoint = async (name: string) => {
    await page.screenshot({ path: join(evidence, `${name}.png`) });
    await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
    completed.push(name);
    await writeFile(
      join(evidence, "progress.json"),
      JSON.stringify(
        {
          provider,
          model,
          completed,
          assertionFailures: test.info().errors.map((error) => error.message),
        },
        null,
        2,
      ),
    );
  };
  const launch = async () => {
    harness = await launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      envOverrides: { PI_APP_TEST_MODE: undefined },
      recordVideoDir: join(evidence, "videos"),
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
    expect(resolve(identity.userData)).toBe(resolve(profile));
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
  const row = (id: string) => page.locator(`.session-row[data-session-id="${id}"]`);
  const assistant = () => page.locator(".timeline-item--assistant .message__content");
  const select = async (id: string) => {
    await row(id).locator(".session-row__select").click();
    await expect(page.locator(".session-row--active")).toHaveAttribute("data-session-id", id);
    await expect(page.getByTestId("composer")).toBeVisible();
  };
  const start = async (prompt: string) => {
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await page.getByLabel("New thread prompt", { exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Stop run", {
      timeout: 30_000,
    });
    const id = await page.locator(".session-row--active").getAttribute("data-session-id");
    expect(id).toBeTruthy();
    return id!;
  };
  const idle = async (id: string) => {
    await expect(row(id)).not.toHaveAttribute("data-sidebar-indicator", "running", {
      timeout: 120_000,
    });
    await expect(row(id)).not.toHaveAttribute("data-sidebar-indicator", "failed");
    await expect(page.getByTestId("composer-error-banner")).toHaveCount(0);
  };
  try {
    await launch();
    await test.step("Send Alpha and observe growing assistant text while running", async () => {
      alpha = await start(
        "Do not use tools. Write 60 numbered lines about simple software testing, at least 8 words per line. Begin with ALPHA_BEGIN and finish with ALPHA_DONE.",
      );
      const samples: Array<{ at: number; length: number; running: boolean }> = [];
      try {
        await expect
          .poll(
            async () => {
              if (await page.getByTestId("composer-error-banner").count())
                throw new Error(await page.getByTestId("composer-error-banner").innerText());
              const text = (await assistant().allTextContents()).join("\n");
              const running =
                (await row(alpha).getAttribute("data-sidebar-indicator")) === "running";
              if (text.length && samples.at(-1)?.length !== text.length)
                samples.push({ at: Date.now(), length: text.length, running });
              return samples.filter((sample) => sample.running).length;
            },
            { timeout: 100_000, intervals: [100] },
          )
          .toBeGreaterThanOrEqual(2);
        await checkpoint("alpha-streaming");
      } finally {
        await writeFile(join(evidence, "stream-samples.json"), JSON.stringify(samples, null, 2));
      }
      await expect(assistant().last()).toContainText("ALPHA_DONE", { timeout: 120_000 });
      await idle(alpha);
      await checkpoint("alpha-complete");
      await page.getByTestId("composer").fill(drafts.alpha);
    });
    await test.step("Run Bravo tool and switch to Alpha while Bravo continues", async () => {
      bravo = await start(
        'Use the bash tool once to run exactly: `printf "BRAVO_TOOL_OK\\n" > verification-tool.txt; sleep 8; cat verification-tool.txt` . After the tool finishes, reply with only BRAVO_DONE.',
      );
      await expect(page.locator(".timeline-tool")).not.toHaveCount(0, { timeout: 90_000 });
      await select(alpha);
      await expect(row(bravo)).toHaveAttribute("data-sidebar-indicator", "running");
      await expect(assistant().last()).toContainText("ALPHA_DONE");
      await expect(assistant()).not.toContainText("BRAVO_DONE");
      await expect
        .soft(page.getByTestId("composer"), "Alpha draft must survive thread switches")
        .toHaveValue(drafts.alpha);
      await checkpoint("switch-during-run");
      await idle(bravo);
      await select(bravo);
      await expect(assistant().last()).toContainText("BRAVO_DONE", { timeout: 20_000 });
      await expect(assistant()).not.toContainText("ALPHA_DONE");
      expect((await readFile(join(workspace, "verification-tool.txt"), "utf8")).trim()).toBe(
        "BRAVO_TOOL_OK",
      );
      const header = page.locator(".timeline-tool__header").first();
      if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
      await expect(page.locator(".timeline-tool__body").first()).toBeVisible();
      await expect(page.locator(".timeline-tool__body").first()).toContainText("BRAVO_TOOL_OK");
      await checkpoint("bravo-tool-complete");
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "false");
    });
    await test.step("Send a follow-up and stop it through the composer", async () => {
      await page
        .getByTestId("composer")
        .fill(
          "Do not use tools. Write 1000 numbered sentences about testing. Start with CANCEL_BEGIN.",
        );
      await page.getByTestId("send").click();
      await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Stop run", {
        timeout: 30_000,
      });
      await expect(assistant().last()).toContainText("CANCEL_BEGIN", { timeout: 90_000 });
      await page.getByRole("button", { name: "Stop run", exact: true }).click();
      await idle(bravo);
      await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Send message");
      await checkpoint("stopped");
      await page.getByTestId("composer").fill(drafts.bravo);
      await select(alpha);
      await expect
        .soft(page.getByTestId("composer"), "Alpha draft must survive thread switches")
        .toHaveValue(drafts.alpha);
      await select(bravo);
      await expect
        .soft(page.getByTestId("composer"), "Bravo draft must survive thread switches/archive")
        .toHaveValue(drafts.bravo);
      await checkpoint("draft-isolation");
    });
    await test.step("Archive and restore Bravo through the sidebar", async () => {
      await row(bravo).hover();
      await row(bravo)
        .getByLabel(/^Archive /)
        .click();
      await expect(page.locator(".session-row--active")).toHaveAttribute("data-session-id", alpha);
      await page.locator(".archived-thread-group__toggle").click();
      await row(bravo).hover();
      await row(bravo)
        .getByLabel(/^Restore /)
        .click();
      await expect(page.locator(".archived-thread-group")).toHaveCount(0);
      await select(bravo);
      await expect
        .soft(page.getByTestId("composer"), "Bravo draft must survive thread switches/archive")
        .toHaveValue(drafts.bravo);
      await checkpoint("archive-restore");
    });
    await close();
    phase = "restart";
    await launch();
    await test.step("Verify both conversations and drafts after restart", async () => {
      await expect(page.locator(".session-row--active")).toHaveAttribute("data-session-id", bravo);
      for (const [id, marker, draft] of [
        [alpha, "ALPHA_DONE", drafts.alpha],
        [bravo, "BRAVO_DONE", drafts.bravo],
      ]) {
        await select(id);
        await expect(assistant().filter({ hasText: marker })).toHaveCount(1);
        await expect
          .soft(page.getByTestId("composer"), "Draft must survive restart")
          .toHaveValue(draft);
        await checkpoint(id === alpha ? "restart-alpha" : "restart-bravo");
      }
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
