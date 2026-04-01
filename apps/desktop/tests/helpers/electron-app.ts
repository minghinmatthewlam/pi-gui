import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import type { PiDesktopApi } from "../../src/ipc";
import type {
  DesktopAppState,
  NewThreadEnvironment,
  SelectedTranscriptRecord,
  SessionRecord,
  WorkspaceRecord,
} from "../../src/desktop-state";
import type { SessionDriverEvent } from "@pi-gui/session-driver";

const desktopDir = resolve(__dirname, "..", "..");
const execFileAsync = promisify(execFile);
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZfXQAAAAASUVORK5CYII=";

export type PiAppWindow = Window & { piApp?: PiDesktopApi };
export type DesktopTestMode = "foreground" | "background";
const desktopModifierKey = process.platform === "darwin" ? "Meta" : "Control";

export interface DesktopHarness {
  electronApp: ElectronApplication;
  firstWindow(): Promise<Page>;
  focusWindow(): Promise<void>;
  close(): Promise<void>;
}

export interface LaunchDesktopOptions {
  readonly initialWorkspaces?: readonly string[];
  readonly notificationLogPath?: string;
  readonly testMode?: DesktopTestMode;
  readonly agentDir?: string;
}

export async function launchDesktop(
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<DesktopHarness> {
  const normalized = Array.isArray(options) ? { initialWorkspaces: options } : options;
  const electronApp = await electron.launch({
    args: [desktopDir],
    cwd: desktopDir,
    env: {
      ...process.env,
      PI_APP_USER_DATA_DIR: userDataDir,
      PI_APP_INITIAL_WORKSPACES: (normalized.initialWorkspaces ?? []).join(delimiter),
      PI_APP_TEST_MODE: normalized.testMode ?? process.env.PI_APP_TEST_MODE ?? "foreground",
      ...(normalized.agentDir ? { PI_CODING_AGENT_DIR: normalized.agentDir } : {}),
      ...(normalized.notificationLogPath ? { PI_APP_NOTIFICATION_LOG_PATH: normalized.notificationLogPath } : {}),
      PI_APP_OPEN_DEVTOOLS: "0",
    },
  });

  let page: Page | undefined;

  async function getWindow(): Promise<Page> {
    if (!page) {
      page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => Boolean((window as PiAppWindow).piApp), undefined, {
        timeout: 15_000,
      });
    }
    return page;
  }

  return {
    electronApp,
    firstWindow: () => getWindow(),
    focusWindow: async () => {
      await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.show();
        window?.focus();
      });
      await (await getWindow()).bringToFront();
    },
    close: async () => {
      await electronApp.close();
    },
  };
}

export async function makeUserDataDir(prefix = "pi-gui-user-data-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function makeWorkspace(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
  const workspacePath = join(root, name);
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), `# ${name}\n`, "utf8");
  return realpath(workspacePath);
}

export async function writeProjectExtension(
  workspacePath: string,
  fileName: string,
  source: string,
): Promise<string> {
  const extensionsDir = join(workspacePath, ".pi", "extensions");
  await mkdir(extensionsDir, { recursive: true });
  const extensionPath = join(extensionsDir, fileName);
  await writeFile(extensionPath, source, "utf8");
  return extensionPath;
}

export async function initGitRepo(workspacePath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.name", "Pi App Tests"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.email", "pi-gui-tests@example.com"], { cwd: workspacePath });
}

export async function commitAllInGitRepo(workspacePath: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: workspacePath });
  await execFileAsync("git", ["commit", "-m", message], { cwd: workspacePath });
}

export async function writeTinyPng(filePath: string): Promise<void> {
  await writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));
}

export function desktopShortcut(keyChord: string): string {
  return `${desktopModifierKey}+${keyChord}`;
}

export async function pasteTinyPngViaClipboard(harness: DesktopHarness, window: Page): Promise<void> {
  const composer = window.getByTestId("composer");
  await composer.click();
  await expect(composer).toBeFocused();
  await harness.electronApp.evaluate(({ clipboard, nativeImage }, encodedPng) => {
    clipboard.writeImage(nativeImage.createFromDataURL(`data:image/png;base64,${encodedPng}`));
  }, TINY_PNG_BASE64);
  await harness.electronApp.evaluate(({ BrowserWindow }) => {
    const appWindow = BrowserWindow.getAllWindows()[0];
    appWindow?.webContents.focus();
    appWindow?.webContents.paste();
  });
  await expect(window.locator(".composer-attachment")).toBeVisible();
}

export async function pasteTinyPng(
  window: Page,
  fileName = "screenshot.png",
  composerTestId = "composer",
): Promise<void> {
  await window.evaluate(({ encodedPng, name, testId }) => {
    const composer = document.querySelector<HTMLTextAreaElement>(`[data-testid='${testId}']`);
    if (!composer) {
      throw new Error(`Composer was unavailable for test id: ${testId}`);
    }

    const bytes = Uint8Array.from(atob(encodedPng), (char) => char.charCodeAt(0));
    const file = new File([bytes], name, { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);

    composer.focus();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      configurable: true,
      value: transfer,
    });
    composer.dispatchEvent(event);
  }, { encodedPng: TINY_PNG_BASE64, name: fileName, testId: composerTestId });
}

export async function stubNextOpenDialog(
  harness: DesktopHarness,
  filePaths: readonly string[],
): Promise<void> {
  await harness.electronApp.evaluate(({ dialog }, paths) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async (...args: Parameters<typeof dialog.showOpenDialog>) => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: paths as string[] };
    };
  }, filePaths);
}

export async function getDesktopState(window: Page): Promise<DesktopAppState> {
  const state = await window.evaluate(() => {
    const app = (window as PiAppWindow).piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    return app.getState();
  });

  if (!state) {
    throw new Error("Desktop state was unavailable");
  }

  return state;
}

export async function getSelectedTranscript(window: Page): Promise<SelectedTranscriptRecord | null> {
  return window.evaluate(async () => {
    const app = (window as PiAppWindow).piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    return app.getSelectedTranscript();
  });
}

export async function emitTestSessionEvent(
  harness: DesktopHarness,
  event: SessionDriverEvent,
): Promise<void> {
  await harness.electronApp.evaluate(async (_, payload) => {
    const hooks = (globalThis as {
      __PI_APP_TEST_HOOKS?: { emitSessionEvent?: (event: SessionDriverEvent) => Promise<void> };
    }).__PI_APP_TEST_HOOKS;
    if (!hooks?.emitSessionEvent) {
      throw new Error("Test session-event hook is unavailable");
    }
    await hooks.emitSessionEvent(payload);
  }, event);
}

export function assertExists<T>(value: T | undefined | null, message: string): asserts value is T {
  if (value == null) {
    throw new Error(message);
  }
}

export async function waitForWorkspaceByPath(
  window: Page,
  workspacePath: string,
  timeout = 15_000,
): Promise<WorkspaceRecord> {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      return state.workspaces.find((workspace) => workspace.path === workspacePath) ?? null;
    }, { timeout })
    .not.toBeNull();

  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
  assertExists(workspace, `Expected workspace for path ${workspacePath}`);
  return workspace;
}

export async function addWorkspaceViaIpc(window: Page, workspacePath: string): Promise<void> {
  await window.evaluate(async (pathValue) => {
    const app = (window as PiAppWindow).piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    await app.addWorkspacePath(pathValue);
  }, workspacePath);
}

export async function waitForSessionByTitle(
  window: Page,
  workspaceId: string,
  title: string,
  timeout = 15_000,
): Promise<SessionRecord> {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      return workspace?.sessions.find((session) => session.title === title) ?? null;
    }, { timeout })
    .not.toBeNull();

  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  const session = workspace?.sessions.find((entry) => entry.title === title);
  assertExists(session, `Expected session ${title}`);
  return session;
}

export async function selectSession(window: Page, sessionTitle: string): Promise<void> {
  await window.locator(".session-row__select", { hasText: sessionTitle }).click();
  await expect(window.locator(".topbar__session")).toHaveText(sessionTitle);
}

export async function openNewThread(window: Page): Promise<void> {
  const composer = window.getByTestId("new-thread-composer");
  if (await composer.isVisible().catch(() => false)) {
    return;
  }
  await window.getByRole("complementary").getByRole("button", { name: "New thread" }).click();
  await expect(composer).toBeVisible();
}

export async function startThreadFromSurface(
  window: Page,
  options: {
    readonly environment?: NewThreadEnvironment;
    readonly prompt?: string;
    readonly workspaceName?: string;
  } = {},
): Promise<void> {
  const {
    environment = "local",
    prompt = "Start thread",
    workspaceName,
  } = options;

  await openNewThread(window);
  if (workspaceName) {
    await window.locator(".new-thread__workspace").selectOption({ label: workspaceName });
  }
  if (environment === "worktree") {
    await window.getByRole("button", { name: "Worktree", exact: true }).click();
  } else {
    await window.getByRole("button", { name: "Local", exact: true }).click();
  }
  if (prompt) {
    await window.getByLabel("New thread prompt").fill(prompt);
  }
  await window.getByRole("button", { name: "Start thread" }).click();
  await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId("composer")).toBeFocused({ timeout: 15_000 });
}

export async function createNamedThread(
  window: Page,
  title: string,
  options: {
    readonly environment?: NewThreadEnvironment;
    readonly workspaceName?: string;
  } = {},
): Promise<void> {
  const { environment = "local", workspaceName } = options;
  if (environment !== "local") {
    await startThreadFromSurface(window, {
      environment,
      prompt: title,
      workspaceName,
    });
    return;
  }

  const targetWorkspaceId = await window.evaluate(
    ({ requestedWorkspaceName }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.getState().then((state) => {
        if (requestedWorkspaceName) {
          const namedWorkspace = state.workspaces.find((workspace) => workspace.name === requestedWorkspaceName);
          if (!namedWorkspace) {
            throw new Error(`Workspace not found: ${requestedWorkspaceName}`);
          }
          return namedWorkspace.id;
        }

        if (!state.selectedWorkspaceId) {
          throw new Error("No selected workspace");
        }

        return state.selectedWorkspaceId;
      });
    },
    { requestedWorkspaceName: workspaceName },
  );

  await createSessionViaIpc(window, targetWorkspaceId, title);
  await selectSession(window, title);
  const composer = window.getByTestId("composer");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await expect(composer).toBeFocused({ timeout: 15_000 });
}

export async function createSessionViaIpc(window: Page, workspaceIdOrPath: string, title: string): Promise<void> {
  const workspaceId = await window.evaluate(async ({ workspaceTarget, targetTitle }) => {
    const app = (window as PiAppWindow).piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await app.getState();
      const workspace = state.workspaces.find((entry) => entry.id === workspaceTarget || entry.path === workspaceTarget);
      if (workspace) {
        await app.createSession({ workspaceId: workspace.id, title: targetTitle });
        return workspace.id;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }

    throw new Error(`Workspace not found: ${workspaceTarget}`);
  }, { workspaceTarget: workspaceIdOrPath, targetTitle: title });

  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      return state.workspaces.find((workspace) => workspace.id === workspaceId)?.sessions.some((session) => session.title === title) ?? false;
    })
    .toBe(true);
}
