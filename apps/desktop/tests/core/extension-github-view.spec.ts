import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";
import { desktopExtensionExamplesDirectory as examples } from "../helpers/desktop-extension-examples";

const example = join(examples, "github");
const shots = process.env.PI_GUI_GITHUB_SHOTS;

async function openGitHubView(window: Page): Promise<FrameLocator> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await window.getByTestId("toggle-side-panel").click();
  const tab = workbench.getByRole("tab", { name: "GitHub", exact: true });
  if (await tab.count()) await tab.click();
  else {
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
    await chooser.getByRole("button", { name: "GitHub", exact: true }).click();
  }
  await expectExtensionViewReady(window);
  return window.frameLocator('[data-testid="extension-view-frame"]');
}

async function capture(window: Page, name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  await window.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
  if (shots) {
    await mkdir(shots, { recursive: true });
    await window.screenshot({ path: join(shots, `${name}.png`) });
    await window.getByTestId("workbench").screenshot({ path: join(shots, `${name}-panel.png`) });
  }
}

test("the GitHub example lists snapshot PRs and issues and prepares an unsent fix thread", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("github-example");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      extensions: [join(example, "index.ts")],
      cacheWarming: "off",
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
    // Offline and deterministic: never runs gh or contacts GitHub.
    envOverrides: {
      PI_GUI_GITHUB_FIXTURE: join(example, "fixtures", "pi-gui-snapshot.json"),
    },
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "GitHub example source task");
    const frame = await openGitHubView(window);

    await expect(
      frame.getByRole("heading", { name: "minghinmatthewlam/pi-gui", exact: true }),
    ).toBeVisible();
    await expect(frame.getByText(/^Snapshot from /)).toBeVisible();
    await expect(frame.getByRole("tab", { name: "Pull requests 4" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(frame.getByRole("tab", { name: "Issues 2" })).toBeVisible();
    const rows = frame.getByRole("tabpanel", { name: "Pull requests" }).getByRole("listitem");
    await expect(rows).toHaveCount(4);
    await capture(window, "github-pr-list");

    await frame.getByRole("button", { name: "Needs attention 1" }).click();
    await expect(rows).toHaveCount(1);
    const failing = frame.getByRole("button", {
      name: /pull request #223: .*3 of 12 checks failing/,
    });
    await failing.click();
    await expect(failing).toHaveAttribute("aria-expanded", "true");
    for (const check of ["CI required", "desktop-package-linux", "typecheck"])
      await expect(frame.getByText(check, { exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Open on GitHub" })).toBeDisabled();
    await capture(window, "github-pr-expanded");

    await frame.getByRole("tab", { name: "Issues 2" }).click();
    await frame.getByRole("button", { name: /issue #216: Model name change randomly/ }).click();
    await expect(frame.getByText(/After sending a couple of prompts/)).toBeVisible();
    await capture(window, "github-issues");

    // The view follows the app theme live through the host's theme variables.
    await window.evaluate(() => globalThis.window.piApp?.setThemeMode("dark"));
    await expect
      .poll(() => frame.locator("html").evaluate((node) => getComputedStyle(node).colorScheme))
      .toBe("dark");
    await capture(window, "github-issues-dark");
    await window.evaluate(() => globalThis.window.piApp?.setThemeMode("light"));

    // Back to the failing PR: Start thread opens an editable draft, never a sent message.
    await frame.getByRole("tab", { name: "Pull requests 4" }).click();
    await frame.getByRole("button", { name: /pull request #223:/ }).click();
    await frame.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Fix failing CI on PR #223");
    const composer = window.getByTestId("composer");
    await expect(composer).toHaveValue(/Fix the failing CI on PR #223/);
    await expect(composer).toHaveValue(/- desktop-package-linux\n- typecheck/);
    await expect(window.locator(".timeline-item--user")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
