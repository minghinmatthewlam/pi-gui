import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  writeProjectExtension,
} from "../helpers/electron-app";

const extensionSource = String.raw`
export default function demoExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setTitle("Extension Surface");
    ctx.ui.setStatus("demo-status", "Demo ready");
    ctx.ui.setWidget("demo-widget", ["Demo widget line"]);
    ctx.ui.setWidget("demo-widget-below", ["Below widget line"], { placement: "belowEditor" });
  });

  pi.registerCommand("settings", {
    description: "Runtime settings command",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Runtime settings command", "info");
    },
  });

  pi.registerCommand("prefill-demo", {
    description: "Prefill the composer",
    handler: async (_args, ctx) => {
      ctx.ui.setEditorText("Prefilled from extension");
      ctx.ui.notify("Composer prefilled", "info");
    },
  });
}
`;

const customFallbackExtensionSource = String.raw`
export default function customFallbackExtension(pi) {
  pi.registerCommand("read-mode-test", {
    description: "Terminal-only read mode",
    handler: async (_args, ctx) => {
      let result;
      try {
        result = await ctx.ui.custom((_tui, _theme, _kb, done) => ({
          render: () => ["read-mode"],
          handleInput: () => done({ text: "should-not-send" }),
        }));
      } catch {
        ctx.ui.notify("Read mode ignored", "info");
        return;
      }
      if (result?.text) {
        pi.sendUserMessage(result.text);
        return;
      }
      ctx.ui.notify("Read mode ignored", "info");
    },
  });
}
`;

const newSessionExtensionSource = String.raw`
export default function newSessionExtension(pi) {
  pi.registerCommand("spawn-child", {
    description: "Create a child session with a draft",
    handler: async (_args, ctx) => {
      const parentSession = ctx.sessionManager.getSessionFile();
      const result = await ctx.newSession({
        ...(parentSession ? { parentSession } : {}),
        withSession: async (nextCtx) => {
          nextCtx.ui.setEditorText("Child draft");
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("Child session cancelled", "info");
        return;
      }
    },
  });
}
`;

const packageExtensionSource = String.raw`
export default function packageNamedExtension(pi) {
  pi.registerCommand("package-named-command", {
    description: "Command from a package-backed extension",
    handler: async (_args, ctx) => {
      ctx.ui.notify("package-backed extension", "info");
    },
  });
}
`;

async function expandDock(window: Page) {
  const toggle = window.getByTestId("extension-dock-toggle");
  await toggle.click();
  return window.getByTestId("extension-dock-body");
}

async function writePackageBackedExtension(
  packagePath: string,
  options: {
    readonly name?: string;
    readonly version?: string;
    readonly displayName?: string;
    readonly description?: string;
  } = {},
) {
  const extensionDir = join(packagePath, "extension");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify(
      {
        name: options.name ?? "unrelated-package-name",
        ...(options.version ? { version: options.version } : {}),
        ...(options.displayName ? { displayName: options.displayName } : {}),
        ...(options.description ? { description: options.description } : {}),
        type: "module",
        pi: {
          extensions: ["./extension/index.ts"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(extensionDir, "index.ts"), `${packageExtensionSource}\n`);
}

async function installPackageBackedExtension(agentDir: string, packagePath: string) {
  await writePackageBackedExtension(packagePath);
  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  settings.packages = [packagePath];
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function installProjectNpmBackedExtension(
  workspacePath: string,
  packageName: string,
  version: string,
) {
  const packagePath = join(workspacePath, ".pi", "npm", "node_modules", packageName);
  await writePackageBackedExtension(packagePath, {
    name: packageName,
    version,
    description: "Project npm package extension",
  });
  const settingsPath = join(workspacePath, ".pi", "settings.json");
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        packages: [`npm:${packageName}@${version}`],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return packagePath;
}

async function installProjectGitBackedExtension(
  workspacePath: string,
  source: string,
  host: string,
  owner: string,
  repo: string,
) {
  const packagePath = join(workspacePath, ".pi", "git", host, owner, repo);
  await writePackageBackedExtension(packagePath, {
    name: repo,
    description: "Project git package extension",
  });
  const settingsPath = join(workspacePath, ".pi", "settings.json");
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        packages: [source],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("labels local package extensions by package root instead of index entrypoints", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extensions-package-name-workspace");
  const packagePath = await makeWorkspace("local-package-extension");

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  await installPackageBackedExtension(agentDir, packagePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expect(window.getByTestId("extensions-surface")).toBeVisible();

    const extensionCard = window.getByTestId("extensions-list").getByRole("button", {
      name: /local-package-extension/i,
    });
    await expect(extensionCard).toBeVisible();
    await extensionCard.click();

    await expect(window.locator(".skill-detail h2")).toHaveText("local-package-extension");
    await expect(window.locator(".skill-detail")).toContainText("package-named-command");
    await expect(window.locator(".skill-detail")).toContainText(packagePath);
  } finally {
    await harness.close();
  }
});

test("shows extensions above files in @ mentions and enables disabled extensions from the composer", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("extension-mention-workspace");
  const extensionPath = await writeProjectExtension(
    workspacePath,
    "demo-extension.ts",
    extensionSource,
  );

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Mention extension surface");
    const composer = window.getByTestId("composer");
    await expect(composer).toBeVisible();

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
        return Boolean(
          workspace &&
          state.runtimeByWorkspace[workspace.id]?.extensions.some(
            (entry) => entry.path === extensionPath,
          ),
        );
      })
      .toBe(true);

    await window.evaluate(
      async ({ targetWorkspacePath, targetExtensionPath }) => {
        const app = globalThis.window.piApp;
        if (!app) {
          throw new Error("piApp IPC bridge is unavailable");
        }
        const state = await app.getState();
        const workspace = state.workspaces.find((entry) => entry.path === targetWorkspacePath);
        if (!workspace) {
          throw new Error(`Workspace not found: ${targetWorkspacePath}`);
        }
        await app.setExtensionEnabled(workspace.id, targetExtensionPath, false);
      },
      { targetWorkspacePath: workspacePath, targetExtensionPath: extensionPath },
    );

    await composer.fill("@");
    const mentionMenu = window.getByTestId("mention-menu");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__section-title")).toHaveText([
      "Extensions",
      "Files",
    ]);
    await expect(mentionMenu.locator(".mention-menu__section").first()).toContainText(
      "demo-extension",
    );
    await expect(mentionMenu.locator(".mention-menu__section").first()).toContainText("Disabled");
    await expect(
      mentionMenu
        .locator(".mention-menu__section")
        .first()
        .getByRole("button", { name: /Enable demo-extension/ }),
    ).toBeVisible();

    await composer.fill("@demo");
    await expect(mentionMenu.locator(".mention-menu__section-title").first()).toHaveText(
      "Extensions",
    );
    await expect(mentionMenu.locator(".mention-menu__section").first()).toContainText(
      "demo-extension",
    );
    await mentionMenu
      .locator(".mention-menu__section")
      .first()
      .getByRole("button", { name: /Enable demo-extension/ })
      .click();
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
        const extension = workspace
          ? state.runtimeByWorkspace[workspace.id]?.extensions.find(
              (entry) => entry.path === extensionPath,
            )
          : undefined;
        return extension?.enabled ?? false;
      })
      .toBe(true);
    await expect(composer).toHaveValue("@demo-extension ");

    // "READ" also matches the built-in Thread orchestration extension.
    await composer.fill("@README");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__section-title")).toHaveText(["Files"]);
    await expect(mentionMenu.locator(".mention-menu__filename")).toContainText("README.md");
    await composer.press("Tab");
    await expect(composer).toHaveValue("@README.md ");
  } finally {
    await harness.close();
  }
});

test("inserts npm package extension mentions without source prefixes or pinned versions", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("extension-npm-mention-workspace");
  const packageName = "pi-read-mode";
  const packageVersion = "1.2.3";
  await installProjectNpmBackedExtension(workspacePath, packageName, packageVersion);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Npm extension mention surface");
    const composer = window.getByTestId("composer");
    await expect(composer).toBeVisible();

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
        return workspace
          ? state.runtimeByWorkspace[workspace.id]?.extensions.some(
              (entry) => entry.sourceInfo.source === `npm:${packageName}@${packageVersion}`,
            )
          : false;
      })
      .toBe(true);

    await composer.fill("@read");
    const mentionMenu = window.getByTestId("mention-menu");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__section-title").first()).toHaveText(
      "Extensions",
    );
    await expect(mentionMenu.locator(".mention-menu__section").first()).toContainText(packageName);

    await composer.press("Tab");
    await expect(composer).toHaveValue(`@${packageName} `);
  } finally {
    await harness.close();
  }
});

test("preserves scoped npm package names in extension mentions", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("extension-scoped-npm-mention-workspace");
  const packageName = "@acme/pi-read-mode";
  const packageVersion = "1.2.3";
  await installProjectNpmBackedExtension(workspacePath, packageName, packageVersion);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Scoped npm extension mention surface");
    const composer = window.getByTestId("composer");
    await expect(composer).toBeVisible();

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
        return workspace
          ? state.runtimeByWorkspace[workspace.id]?.extensions.some(
              (entry) => entry.sourceInfo.source === `npm:${packageName}@${packageVersion}`,
            )
          : false;
      })
      .toBe(true);

    await composer.fill("@acme");
    const mentionMenu = window.getByTestId("mention-menu");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__section-title").first()).toHaveText(
      "Extensions",
    );

    await composer.press("Tab");
    await expect(composer).toHaveValue("@acme-pi-read-mode ");
  } finally {
    await harness.close();
  }
});

test("inserts git package extension mentions from the resolved package root", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("extension-git-mention-workspace");
  const source = "ssh://git@github.com/acme/repo.git@main";
  const repo = "repo";
  await installProjectGitBackedExtension(workspacePath, source, "github.com", "acme", repo);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Git extension mention surface");
    const composer = window.getByTestId("composer");
    await expect(composer).toBeVisible();

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
        return workspace
          ? state.runtimeByWorkspace[workspace.id]?.extensions.some(
              (entry) => entry.sourceInfo.source === source,
            )
          : false;
      })
      .toBe(true);

    await composer.fill("@repo");
    const mentionMenu = window.getByTestId("mention-menu");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__section-title").first()).toHaveText(
      "Extensions",
    );
    await expect(mentionMenu.locator(".mention-menu__section").first()).toContainText(repo);

    await composer.press("Tab");
    await expect(composer).toHaveValue(`@${repo} `);
  } finally {
    await harness.close();
  }
});

test("manages extensions and prefers runtime commands over colliding host actions", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extensions-workspace");
  await writeProjectExtension(workspacePath, "demo-extension.ts", extensionSource);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Inspect extension surface");
    await expect(window.getByTestId("composer")).toBeVisible();

    await expect(window.locator(".chat-header__title")).toHaveText("Extension Surface");
    await expect(window.getByTestId("extension-dock")).toBeVisible();
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("Demo ready");
    await expect(window.getByTestId("extension-status-strip")).toHaveCount(0);
    await expect(window.getByTestId("extension-widget-rail")).toHaveCount(0);
    const dockBody = await expandDock(window);
    await expect(dockBody).toContainText("demo-status: Demo ready");
    await expect(dockBody).toContainText("demo-widget:");
    await expect(dockBody).toContainText("Demo widget line");
    await expect(dockBody).toContainText("demo-widget-below:");
    await expect(dockBody).toContainText("Below widget line");

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expect(window.getByTestId("extensions-surface")).toBeVisible();
    const extensionsList = window.getByTestId("extensions-list");
    const extensionCard = extensionsList.getByRole("button", { name: /demo-extension/i });
    await expect(extensionCard).toBeVisible();
    await extensionCard.click();
    await expect(window.locator(".skill-detail")).toContainText("settings");
    await expect(window.locator(".skill-detail")).toContainText("prefill-demo");

    const enabledSwitch = window.getByRole("switch", { name: "Enabled", exact: true });
    await expect(enabledSwitch).toBeChecked();
    await enabledSwitch.click();
    await expect(enabledSwitch).not.toBeChecked();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Inspect extension surface");
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);
    const composer = window.getByTestId("composer");
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await extensionCard.click();
    await expect(enabledSwitch).not.toBeChecked();
    await enabledSwitch.click();
    await expect(enabledSwitch).toBeChecked();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Extension Surface");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("Demo ready");
    await expect(window.getByTestId("extension-dock-body")).toHaveCount(0);
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        if (!state.selectedWorkspaceId || !state.selectedSessionId) {
          return false;
        }
        const selectedSessionKey = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
        return (
          state.sessionCommandsBySession[selectedSessionKey]?.some(
            (command) => command.name === "settings",
          ) ?? false
        );
      })
      .toBe(true);
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const selectedWorkspace = state.workspaces.find(
            (entry) => entry.id === state.selectedWorkspaceId,
          );
          return (
            selectedWorkspace?.sessions.find((session) => session.id === state.selectedSessionId)
              ?.status ?? "unknown"
          );
        },
        { timeout: 30_000 },
      )
      .toBe("idle");

    await composer.fill("/se");
    const slashMenu = window.getByTestId("slash-menu");
    await expect(slashMenu).toContainText("Runtime Commands");
    await expect(slashMenu).toContainText("Host Actions");

    await composer.fill("/settings ");
    await composer.press("Enter");
    await expect(window.getByTestId("settings-surface")).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Runtime settings command");

    await composer.fill("/prefill-demo ");
    await composer.press("Enter");
    await expect(composer).toHaveValue("Prefilled from extension");
    await expect(window.locator(".timeline")).toContainText("Composer prefilled");
  } finally {
    await harness.close();
  }
});

test("degrades terminal-only custom extension ui without sending stray messages", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extensions-custom-fallback-workspace");
  await writeProjectExtension(
    workspacePath,
    "custom-fallback-extension.ts",
    customFallbackExtensionSource,
  );

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Custom fallback session");

    const composer = window.getByTestId("composer");
    await composer.fill("/read-mode-test ");
    await composer.press("Enter");

    await expect(window.getByTestId("extension-dialog")).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Read mode ignored");
    await expect(window.locator(".timeline")).not.toContainText("should-not-send");
    await expect(composer).toHaveValue("");
  } finally {
    await harness.close();
  }
});

test("keeps a single subscription path when an extension creates a child session and prefills the draft", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extensions-new-session-workspace");
  await writeProjectExtension(workspacePath, "new-session-extension.ts", newSessionExtensionSource);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Parent session");

    const beforeState = await getDesktopState(window);
    const beforeSelectedSessionId = beforeState.selectedSessionId;
    const resumedCountBefore = await window.getByText("Resumed session", { exact: true }).count();

    const composer = window.getByTestId("composer");
    await composer.fill("/spawn-child ");
    await composer.press("Enter");

    await expect
      .poll(async () => {
        const nextState = await getDesktopState(window);
        return nextState.selectedSessionId;
      })
      .not.toBe(beforeSelectedSessionId);
    await expect(composer).toHaveValue("Child draft");
    await expect(window.getByText("Resumed session", { exact: true })).toHaveCount(
      resumedCountBefore,
    );
  } finally {
    await harness.close();
  }
});
