import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import { assertExists, getDesktopState, seedAgentDir } from "./electron-app";

/**
 * Playwright against `pi-gui-testhost`: the Rust app-state kernel with the real pi host and
 * core, and the built renderer in Chromium with `window.piApp` over a WebSocket. Page helpers
 * from `electron-app.ts` work unchanged, since they only use `window.piApp`; the helpers here
 * replace the ones that reached into Electron main.
 */

const desktopDir = resolve(__dirname, "../..");
const repoRoot = resolve(desktopDir, "../..");
const STARTUP_TIMEOUT_MS = 60_000;
const QUIT_TIMEOUT_MS = 15_000;
/** Electron main's first window size. */
const WINDOW_SIZE = { width: 1480, height: 980 } as const;

export interface TestHostLaunchOptions {
  readonly initialWorkspaces?: readonly string[];
  readonly testMode?: "foreground" | "background";
  readonly agentDir?: string;
  readonly enabledModels?: readonly string[];
  readonly envOverrides?: Readonly<Record<string, string | undefined>>;
}

/** The `test.*` calls, as `harness.electronApp.evaluate` reached them under Electron. */
export interface TestHostControl {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface TestHostHarness {
  readonly url: string;
  readonly control: TestHostControl;
  firstWindow(): Promise<Page>;
  newWindow(): Promise<Page>;
  close(): Promise<void>;
}

function testHostBinary(): string {
  const explicit = process.env.PI_GUI_TESTHOST_BIN?.trim();
  if (explicit) return explicit;
  const targetDir = process.env.CARGO_TARGET_DIR?.trim() || join(repoRoot, "target");
  return join(targetDir, "debug", "pi-gui-testhost");
}

/** Playwright's own Chromium, or a matching one already on the machine. */
function chromiumExecutable(): string | undefined {
  const explicit = process.env.PI_GUI_TESTHOST_CHROMIUM?.trim();
  if (explicit) return explicit;
  if (existsSync(chromium.executablePath())) return undefined;
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsers || !existsSync(browsers)) return undefined;
  const installed = readdirSync(browsers)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()
    .map((name) => join(browsers, name, "chrome-linux", "chrome"));
  return installed.find((path) => existsSync(path));
}

function launchEnv(userDataDir: string, agentDir: string, options: TestHostLaunchOptions) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Ambient provider credentials must never turn a fixture test into a real request.
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY")) delete env[key];
  }
  Object.assign(env, {
    PI_APP_USER_DATA_DIR: userDataDir,
    PI_APP_INITIAL_WORKSPACES: (options.initialWorkspaces ?? []).join(delimiter),
    PI_APP_TEST_MODE: options.testMode ?? process.env.PI_APP_TEST_MODE ?? "background",
    PI_CODING_AGENT_DIR: agentDir,
  });
  for (const [key, value] of Object.entries(options.envOverrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function waitForListening(child: ChildProcess, output: string[]): Promise<string> {
  const lines = createInterface({ input: child.stdout! });
  return new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`pi-gui-testhost did not start:\n${output.join("\n")}`));
    }, STARTUP_TIMEOUT_MS);
    lines.on("line", (line) => {
      const match = /listening on (http:\/\/\S+)/.exec(line);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pi-gui-testhost exited with ${code}:\n${output.join("\n")}`));
    });
  });
}

/** A control connection for `test.*` calls. */
async function connectControl(wsUrl: string): Promise<TestHostControl & { close(): void }> {
  const socket = new WebSocket(wsUrl);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener("open", () => resolveOpen());
    socket.addEventListener("error", () => reject(new Error(`Could not reach ${wsUrl}`)));
  });
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as {
      id?: number;
      result?: unknown;
      error?: { name?: string; message?: string };
    };
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? "test call failed"));
    else entry.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) entry.reject(new Error("pi-gui-testhost closed"));
    pending.clear();
  });
  socket.send(JSON.stringify({ hello: { role: "control" } }));
  return {
    call: <T>(method: string, params: Record<string, unknown> = {}) =>
      new Promise<T>((resolveCall, reject) => {
        nextId += 1;
        pending.set(nextId, { resolve: resolveCall as (value: unknown) => void, reject });
        socket.send(JSON.stringify({ id: nextId, method: `test.${method}`, args: [params] }));
      }),
    close: () => socket.close(),
  };
}

export async function launchTestHost(
  userDataDir: string,
  options: TestHostLaunchOptions | readonly string[] = {},
): Promise<TestHostHarness> {
  const normalized: TestHostLaunchOptions = Array.isArray(options)
    ? { initialWorkspaces: options as readonly string[] }
    : (options as TestHostLaunchOptions);
  const agentDir = normalized.agentDir ?? join(userDataDir, "agent");
  if (!normalized.agentDir) {
    await seedAgentDir(agentDir, { enabledModels: normalized.enabledModels });
  }
  const binary = testHostBinary();
  if (!existsSync(binary)) {
    throw new Error(`Build the test host first (cargo build -p pi-gui-testhost): ${binary}`);
  }
  const output: string[] = [];
  const child = spawn(binary, [], {
    cwd: desktopDir,
    env: launchEnv(userDataDir, agentDir, normalized),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output.push(...chunk.toString("utf8").split("\n").filter(Boolean));
    output.splice(0, Math.max(0, output.length - 200));
  });
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  let browser: Browser | undefined;
  try {
    const url = await waitForListening(child, output);
    const wsUrl = url.replace(/^http/, "ws");
    const control = await connectControl(wsUrl);
    browser = await chromium.launch({ executablePath: chromiumExecutable() });
    const context: BrowserContext = await browser.newContext({ viewport: WINDOW_SIZE });
    const pageUrl = `${url}/?testhost=${encodeURIComponent(wsUrl)}`;
    const openWindow = async () => {
      const page = await context.newPage();
      await page.goto(pageUrl);
      await page.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
        timeout: 15_000,
      });
      return page;
    };
    let first: Promise<Page> | undefined;
    const openedBrowser = browser;
    return {
      url,
      control,
      firstWindow: () => (first ??= openWindow()),
      newWindow: openWindow,
      close: async () => {
        // Windows flush their drafts and state is saved before pi and the core stop, as
        // Electron's quit does; then the pages go.
        await control.call("quit").catch(() => undefined);
        const timedOut = await Promise.race([
          exited.then(() => false),
          new Promise<boolean>((resolveTimeout) =>
            setTimeout(() => resolveTimeout(true), QUIT_TIMEOUT_MS),
          ),
        ]);
        if (timedOut) child.kill("SIGKILL");
        control.close();
        await openedBrowser.close();
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await browser?.close();
    throw error;
  }
}

export async function emitTestSessionEvents(
  harness: TestHostHarness,
  events: readonly SessionDriverEvent[],
): Promise<void> {
  for (const event of events) {
    await harness.control.call("emitSessionEvent", { event });
  }
}

export async function emitTestSessionEvent(
  harness: TestHostHarness,
  event: SessionDriverEvent,
): Promise<void> {
  await emitTestSessionEvents(harness, [event]);
}

/** `streamAssistantDeltas` from `electron-app.ts`, sending its events through the test host. */
export async function streamAssistantDeltas(
  harness: TestHostHarness,
  window: Page,
  chunks: readonly string[],
  runId = `stream-run-${Date.now()}`,
): Promise<{ readonly sessionRef: SessionRef; readonly fullText: string }> {
  const state = await getDesktopState(window);
  const selectedWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSession = selectedWorkspace?.sessions.find(
    (session) => session.id === state.selectedSessionId,
  );
  assertExists(selectedWorkspace, "Expected selected workspace while streaming transcript");
  assertExists(selectedSession, "Expected selected session while streaming transcript");

  const sessionRef = {
    workspaceId: selectedWorkspace.id,
    sessionId: selectedSession.id,
  } satisfies SessionRef;
  const workspace = {
    workspaceId: selectedWorkspace.id,
    path: selectedWorkspace.path,
    displayName: selectedWorkspace.name,
  };
  const startedAt = new Date().toISOString();
  const completedAt = new Date(Date.now() + chunks.length * 1_000 + 1_000).toISOString();
  const fullText = chunks.join("");

  await emitTestSessionEvent(harness, {
    type: "sessionUpdated",
    sessionRef,
    timestamp: startedAt,
    runId,
    snapshot: {
      ref: sessionRef,
      workspace,
      title: selectedSession.title,
      status: "running",
      updatedAt: startedAt,
      preview: fullText,
      runningRunId: runId,
    },
  });
  for (const [index, chunk] of chunks.entries()) {
    await emitTestSessionEvent(harness, {
      type: "assistantDelta",
      sessionRef,
      timestamp: new Date(Date.now() + index * 1_000).toISOString(),
      runId,
      text: chunk,
    });
  }
  await emitTestSessionEvent(harness, {
    type: "runCompleted",
    sessionRef,
    timestamp: completedAt,
    runId,
    snapshot: {
      ref: sessionRef,
      workspace,
      title: selectedSession.title,
      status: "idle",
      updatedAt: completedAt,
      preview: fullText,
    },
  });
  return { sessionRef, fullText };
}

export type IpcInvokeControlMode = "passthrough" | "reject" | "replace" | "record";

export async function installIpcInvokeControl(
  harness: TestHostHarness,
  channel: string,
  options: {
    readonly mode: IpcInvokeControlMode;
    readonly sentinel?: string;
    readonly replacement?: unknown;
  },
): Promise<void> {
  await harness.control.call("invokeControl.install", { channel, ...options });
}

export async function setIpcInvokeControl(
  harness: TestHostHarness,
  channel: string,
  patch: { readonly mode?: IpcInvokeControlMode; readonly replacement?: unknown },
): Promise<void> {
  await harness.control.call("invokeControl.set", { channel, ...patch });
}

export async function readIpcInvokeControl(
  harness: TestHostHarness,
  channel: string,
): Promise<{
  readonly mode: IpcInvokeControlMode;
  readonly invokeCount: number;
  readonly rejectCount: number;
  readonly sentinel: string;
}> {
  return harness.control.call("invokeControl.read", { channel });
}

/** Reloads a page; it reconnects as the same window, as an Electron renderer reload does. */
export async function reloadTestHostRenderer(window: Page): Promise<void> {
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await expect
    .poll(() => window.evaluate(() => Boolean(globalThis.window.piApp)), { timeout: 15_000 })
    .toBe(true);
}
