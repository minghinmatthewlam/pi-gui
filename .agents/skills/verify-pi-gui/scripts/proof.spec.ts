import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  launchDesktop,
  seedAgentDir,
  type DesktopHarness,
} from "../../../../apps/desktop/tests/helpers/electron-app";

test("visible app navigation and settings persistence without test hooks", async () => {
  const evidence = process.env.PI_GUI_PROOF_DIR;
  if (!evidence) throw new Error("Run scripts/prove.sh to allocate a unique evidence directory");
  const userDataDir = join(evidence, "profile");
  const workspace = join(evidence, "workspace");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(workspace, { recursive: true });
  const runs: Array<{ pid: number; closed: boolean }> = [];
  const launch = async () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      envOverrides: { PI_APP_TEST_MODE: undefined },
      recordVideoDir: join(evidence, "videos"),
    });
  const doctor = async (harness: DesktopHarness) => {
    await harness.focusWindow();
    const page = await harness.firstWindow();
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
    expect(identity.visible).toBe(true);
    expect(identity.focused || documentFocused).toBe(true);
    expect(identity.testMode).toBeNull();
    expect(identity.testHooks).toBe(false);
    expect(resolve(identity.appPath)).toBe(resolve("apps/desktop"));
    expect(resolve(identity.userData)).toBe(resolve(userDataDir));
    runs.push({ pid: identity.pid, closed: false });
    await writeFile(
      join(evidence, `doctor-${runs.length}.json`),
      JSON.stringify({ ...identity, documentFocused }, null, 2),
    );
    await expect(page.getByRole("button", { name: /^(Settings|Back to app)$/ })).toBeVisible();
    return page;
  };
  let original: boolean | undefined;
  for (const phase of ["change", "restart"] as const) {
    let harness: DesktopHarness | undefined;
    let tracing = false;
    try {
      harness = await launch();
      const page = await doctor(harness);
      await harness.electronApp
        .context()
        .tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracing = true;
      if (await page.getByRole("button", { name: "Settings", exact: true }).isVisible()) {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
      }
      if (phase === "change") {
        for (const section of ["Appearance", "Providers", "Models", "Notifications", "General"]) {
          await test.step(`Open ${section} through the settings sidebar`, async () => {
            await page.getByRole("button", { name: section, exact: true }).click();
            await expect(page.locator(".view-header__title")).toHaveText(section);
            await page.screenshot({ path: join(evidence, `surface-${section.toLowerCase()}.png`) });
            // Pacing makes the visible run followable; assertions determine readiness.
            await page.waitForTimeout(600);
          });
        }
      }
      const toggle = page.getByRole("checkbox", { name: "Enable skill slash commands" });
      await expect(toggle).toBeVisible();
      if (phase === "change") {
        original = await toggle.isChecked();
        await page.screenshot({ path: join(evidence, "before.png") });
        await toggle.click();
        await expect(toggle).toBeChecked({ checked: !original });
        await page.getByRole("button", { name: "Back to app", exact: true }).click();
        await page.getByRole("button", { name: "Skills", exact: true }).click();
        await expect(page.locator(".skills-view")).toBeVisible();
        await page.screenshot({ path: join(evidence, "surface-skills.png") });
        await page.waitForTimeout(600);
        await page.getByRole("button", { name: "Back to app", exact: true }).click();
        await page
          .getByRole("complementary")
          .getByRole("button", { name: "New thread", exact: true })
          .click();
        await expect(page.getByTestId("new-thread-composer")).toBeVisible();
        await page.getByTestId("new-thread-composer").fill("Visible verification draft");
        await expect(page.getByTestId("new-thread-composer")).toHaveValue(
          "Visible verification draft",
        );
        await page.screenshot({ path: join(evidence, "surface-new-thread.png") });
        await page.waitForTimeout(600);
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await expect(toggle).toBeChecked({ checked: !original });
      } else {
        await expect(toggle).toBeChecked({ checked: !original });
      }
      await page.screenshot({ path: join(evidence, `${phase}.png`) });
      await writeFile(
        join(evidence, `${phase}.aria.txt`),
        await page.locator("body").ariaSnapshot(),
      );
    } finally {
      if (harness) {
        try {
          if (tracing)
            await harness.electronApp
              .context()
              .tracing.stop({ path: join(evidence, `${phase}.zip`) });
        } finally {
          const pid = harness.electronApp.process().pid;
          await harness.close();
          const run = runs.find((entry) => entry.pid === pid);
          if (run) run.closed = true;
          await writeFile(join(evidence, "cleanup.json"), JSON.stringify(runs, null, 2));
        }
      }
    }
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        feature: "visible-navigation-and-settings-persistence",
        launchMode: "normal-visible",
        original,
        persisted: !original,
        result: "passed",
        runs,
      },
      null,
      2,
    ),
  );
});
