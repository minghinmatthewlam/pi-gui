import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { getRealAuthConfig, launchDesktop, makeWorkspace } from "../helpers/electron-app";
import {
  createExamplePrFixture,
  desktopExtensionExamplesDirectory,
} from "../helpers/desktop-extension-examples";

test("a real provider records PR findings through the installed extension and prepares an unsent fix", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const authConfig = getRealAuthConfig();
  test.skip(!authConfig.enabled, authConfig.skipReason);
  test.skip(
    process.platform === "win32",
    "The offline GitHub metadata fixture uses a POSIX executable.",
  );
  const provider = process.env.PI_GUI_PROVIDER;
  const model = process.env.PI_GUI_MODEL;
  if (!authConfig.sourceDir || !provider || !model)
    throw new Error("Set real-auth source, PI_GUI_PROVIDER and PI_GUI_MODEL for this proof.");
  const auth: unknown = JSON.parse(await readFile(join(authConfig.sourceDir, "auth.json"), "utf8"));
  if (!auth || typeof auth !== "object" || Array.isArray(auth) || !(provider in auth))
    throw new Error("The selected provider has no saved credentials.");
  // Credential copies stay outside the shareable screenshot/trace directory.
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-gui-extension-live-private-"));
  await chmod(privateRoot, 0o700);
  const agentDir = join(privateRoot, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  const credential: unknown = Reflect.get(auth, provider);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ [provider]: credential }), {
    mode: 0o600,
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: "low",
      enabledModels: [`${provider}/${model}`],
      extensions: [join(desktopExtensionExamplesDirectory, "pr-review/index.ts")],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  const workspacePath = await makeWorkspace("live-extension-pr-review");
  const fixture = await createExamplePrFixture({ workspacePath, artifactDir: privateRoot });
  const harness = await launchDesktop(join(privateRoot, "profile"), {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    envOverrides: { ...fixture.envOverrides, PI_APP_TEST_MODE: undefined },
  });
  const pid = harness.electronApp.process().pid;
  let tracing = false;
  try {
    await harness.focusWindow();
    const window = await harness.firstWindow();
    const identity = await harness.electronApp.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid,
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      focused: BrowserWindow.getAllWindows()[0]?.isFocused(),
      testMode: process.env.PI_APP_TEST_MODE ?? null,
      testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
    }));
    const documentFocused = await window.evaluate(() => document.hasFocus());
    await writeFile(
      testInfo.outputPath("doctor.json"),
      JSON.stringify({ ...identity, documentFocused }, null, 2),
    );
    expect(identity).toMatchObject({ visible: true, testMode: null, testHooks: false });
    expect(identity.focused || documentFocused).toBe(true);
    expect(resolve(identity.appPath)).toBe(resolve("apps/desktop"));
    expect(resolve(identity.userData)).toBe(resolve(privateRoot, "profile"));
    await harness.electronApp
      .context()
      .tracing.start({ screenshots: true, snapshots: true, sources: true });
    tracing = true;
    await window
      .locator(".sidebar")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window
      .getByLabel("New thread prompt", { exact: true })
      .fill(
        'This workspace has an explicit requirement: search("") must return an empty array, and search("text") must return ["text"]. A PR review will follow. For now reply exactly READY without changing files.',
      );
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("READY", { timeout: 90_000 });
    await expect(window.locator(".session-row--active")).toHaveAttribute(
      "data-sidebar-indicator",
      "none",
    );
    const openReview = async () => {
      if (!(await window.getByTestId("workbench").isVisible()))
        await window.getByTestId("toggle-side-panel").click();
      const tab = window.getByRole("tab", { name: "PR Review", exact: true });
      if (await tab.count()) await tab.click();
      else {
        await window.getByTestId("workbench-add-tab").click();
        await window
          .getByTestId("workbench-chooser")
          .getByRole("button", { name: "PR Review", exact: true })
          .click();
      }
      return window.frameLocator('[data-testid="extension-view-frame"]');
    };
    let frame = await openReview();
    await frame.getByRole("button", { name: "Refresh PR", exact: true }).click();
    await expect(frame.getByText("#142 · Search fixture", { exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "Review with Pi", exact: true }).click();
    await expect(
      frame.getByRole("heading", { name: "Review · completed", exact: true }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      frame.getByRole("button", { name: "Prepare fix task", exact: true }).first(),
    ).toBeVisible();
    await expect(window.locator(".session-row--active")).toHaveAttribute(
      "data-sidebar-indicator",
      /^(none|unseen)$/,
      { timeout: 30_000 },
    );
    await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
    await expect(window.getByTestId("composer-error-banner")).toHaveCount(0);
    const reviewScreenshot = testInfo.outputPath("real-provider-pr-findings.png");
    await window.screenshot({ path: reviewScreenshot, fullPage: true });
    await testInfo.attach("Real provider findings; GitHub metadata is a fixture", {
      path: reviewScreenshot,
      contentType: "image/png",
    });
    await frame.getByRole("button", { name: "search.ts:1", exact: true }).first().click();
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    frame = await openReview();
    await frame.getByRole("button", { name: "Prepare fix task", exact: true }).first().click();
    await expect(window.getByTestId("composer")).toHaveValue(
      new RegExp(`Reviewed head: ${fixture.head}`),
    );
    await expect(window.locator(".session-row--active")).toHaveAttribute(
      "data-sidebar-indicator",
      "none",
    );
    await expect(window.locator(".timeline-item--assistant")).toHaveCount(0);
    await window.screenshot({
      path: testInfo.outputPath("real-provider-unsent-fix.png"),
      fullPage: true,
    });
  } finally {
    try {
      if (tracing)
        await harness.electronApp
          .context()
          .tracing.stop({ path: testInfo.outputPath("extension-review.zip") });
    } finally {
      await harness.close();
    }
    await writeFile(
      testInfo.outputPath("cleanup.json"),
      JSON.stringify(
        { pid, closed: true, provider, model, githubMetadata: "offline fixture" },
        null,
        2,
      ),
    );
  }
});
