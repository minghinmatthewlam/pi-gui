import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expect,
  test,
  type ElectronApplication,
  type FrameLocator,
  type Page,
} from "@playwright/test";
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
const piGuiResponses = join(example, "test", "fixtures", "pi-gui.json");

/** A PATH whose `gh` answers from the pi-gui fixture and logs every call. */
async function fakeGhPath(): Promise<{ readonly path: string; readonly log: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-gui-fake-gh-"));
  await symlink(join(example, "test", "fake-gh.mjs"), join(directory, "gh"));
  return { path: `${directory}:${process.env.PATH ?? ""}`, log: join(directory, "calls.log") };
}

async function ghCalls(log: string): Promise<number> {
  try {
    return (await readFile(log, "utf8")).trim().split("\n").length;
  } catch {
    return 0;
  }
}

/** An agent dir that loads only the GitHub example. */
async function agentDirWithExample(userDataDir: string): Promise<string> {
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], extensions: [join(example, "index.ts")], cacheWarming: "off" }),
  );
  return agentDir;
}

async function recordOpenedLinks(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const globals = globalThis as typeof globalThis & { __openedLinks?: string[] };
    globals.__openedLinks = [];
    shell.openExternal = async (url: string) => {
      globals.__openedLinks?.push(url);
    };
  });
  return () =>
    app.evaluate(
      () => (globalThis as typeof globalThis & { __openedLinks?: string[] }).__openedLinks ?? [],
    );
}

async function openGitHubView(window: Page): Promise<FrameLocator> {
  if (!(await window.getByTestId("workbench").isVisible()))
    await window.getByTestId("toggle-side-panel").click();
  const chooser = window.getByTestId("workbench-chooser");
  if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
  await chooser.getByRole("button", { name: "GitHub", exact: true }).click();
  await expectExtensionViewReady(window);
  return window.frameLocator('[data-testid="extension-view-frame"]');
}

test("the GitHub example reads gh only when opened, opens links and drafts a fix", async () => {
  test.skip(
    process.platform === "win32",
    "The fake gh is a POSIX executable; Windows has a separate native verification lane.",
  );
  test.setTimeout(120_000);
  const gh = await fakeGhPath();
  const userDataDir = await makeUserDataDir();
  const harness = await launchDesktop(userDataDir, {
    agentDir: await agentDirWithExample(userDataDir),
    initialWorkspaces: [await makeWorkspace("github-example")],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: { PATH: gh.path, FAKE_GH_RESPONSES: piGuiResponses, FAKE_GH_LOG: gh.log },
  });
  try {
    const window = await harness.firstWindow();
    const openedLinks = await recordOpenedLinks(harness.electronApp);
    await createNamedThread(window, "Triage the repo");
    // Every thread loads the extension, but gh only runs once its view asks.
    expect(await ghCalls(gh.log)).toBe(0);

    const frame = await openGitHubView(window);
    await expect(
      frame.getByRole("heading", { name: "minghinmatthewlam/pi-gui", exact: true }),
    ).toBeVisible();
    await expect(frame.getByText("Updated just now")).toBeVisible();
    expect(await ghCalls(gh.log)).toBe(5);
    await expect(frame.getByRole("tab", { name: "Pull requests 4" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await frame.getByRole("button", { name: "Needs attention 1" }).click();
    await frame
      .getByRole("button", { name: /pull request #223: .*3 of 12 checks failing/ })
      .click();
    for (const check of ["CI required", "desktop-package-linux", "typecheck"])
      await expect(frame.getByText(check, { exact: true })).toBeVisible();

    await frame.getByRole("button", { name: "Open on GitHub" }).click();
    await expect
      .poll(openedLinks)
      .toEqual(["https://github.com/minghinmatthewlam/pi-gui/pull/223"]);

    // Start thread opens an editable draft in a new thread, never a sent message.
    await frame.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Fix failing CI on PR #223");
    const composer = window.getByTestId("composer");
    await expect(composer).toHaveValue(/- desktop-package-linux\n- typecheck/);
    await expect(window.locator(".timeline-item--user")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("without gh the GitHub example says how to get it", async () => {
  test.skip(
    process.platform === "win32",
    "The fake gh is a POSIX executable; Windows has a separate native verification lane.",
  );
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const harness = await launchDesktop(userDataDir, {
    agentDir: await agentDirWithExample(userDataDir),
    initialWorkspaces: [await makeWorkspace("github-example-no-gh")],
    scrubProviderEnv: true,
    testMode: "background",
    // No gh anywhere on this PATH.
    envOverrides: { PATH: `${await mkdtemp(join(tmpdir(), "pi-gui-no-gh-"))}:/usr/bin:/bin` },
  });
  try {
    const window = await harness.firstWindow();
    const openedLinks = await recordOpenedLinks(harness.electronApp);
    await createNamedThread(window, "No GitHub CLI");
    const frame = await openGitHubView(window);
    await expect(frame.getByRole("alert")).toContainText("Install gh, run gh auth login");
    await frame.getByRole("button", { name: "Get the GitHub CLI" }).click();
    await expect.poll(openedLinks).toEqual(["https://cli.github.com/"]);
  } finally {
    await harness.close();
  }
});
