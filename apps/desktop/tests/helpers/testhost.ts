import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  HYDRATE_TEST_SENTINEL,
  type DesktopHarness,
  type DesktopIpcControl,
  type DesktopTestHooks,
  type InterceptedDriverCall,
  type IpcInvokeControlSnapshot,
  type PiDriverCallRecord,
  type PiDriverControl,
  type TextPromptOutcome,
} from "./desktop-harness";
import type { ThemePresetId } from "../../contracts/desktop-state";
import { windowBackgroundFor, type ResolvedTheme } from "../../contracts/theme";
import { isProviderAuthEnvVar, seedAgentDir } from "./electron-app";

/**
 * `DesktopHarness` for `pi-gui-testhost`: the Rust app-state kernel with the real pi host and
 * core, and the built renderer in Chromium with `window.piApp` over a WebSocket. Page helpers
 * work unchanged, since they only use `window.piApp`. What only a native shell has (OS key
 * events, menus, the clipboard, window chrome) rejects with "… is not available on the test
 * host".
 */

const desktopDir = resolve(__dirname, "../..");
const repoRoot = resolve(desktopDir, "../..");
const STARTUP_TIMEOUT_MS = 60_000;
const QUIT_TIMEOUT_MS = 15_000;
const HELD_DRIVER_CALL_TIMEOUT_MS = 15_000;
/** Electron main's first window size. */
const WINDOW_SIZE = { width: 1480, height: 980 } as const;
/** Where the page's transport keeps its window id (`src/platform/testhost-transport.ts`). */
const WINDOW_ID_KEY = "pi-gui:testhost-window";
/**
 * Extension frames load from `http://<connectionId>:<port>/` on the test host (Chromium cannot
 * load the `pi-extension:` scheme), so a connection id resolves to the test host.
 */
const EXTENSION_FRAME_HOSTS = "*-*-*-*-*";

export interface TestHostLaunchOptions {
  readonly initialWorkspaces?: readonly string[];
  readonly testMode?: "foreground" | "background";
  readonly agentDir?: string;
  readonly enabledModels?: readonly string[];
  readonly envOverrides?: Readonly<Record<string, string | undefined>>;
}

/** The test host's `test.*` calls. */
export interface TestHostControl {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface TestHostHarness extends DesktopHarness {
  readonly url: string;
  readonly control: TestHostControl;
  /** Opens another page, which connects as a new window. */
  newWindow(): Promise<Page>;
}

/** What `test.windowState` reports; the background follows the theme as main's does. */
interface WindowStateReport {
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly visible: boolean;
  readonly themePresetId: ThemePresetId;
  readonly resolvedTheme: ResolvedTheme;
}

async function windowIdOf(page: Page): Promise<number> {
  return Number(
    await page.evaluate((key) => globalThis.sessionStorage.getItem(key), WINDOW_ID_KEY),
  );
}

function unsupported(what: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${what} is not available on the test host`));
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
    if (isProviderAuthEnvVar(key)) delete env[key];
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

/**
 * Electron main's `will-frame-navigate`: a subframe may only load an extension view's own
 * document. Anything else is answered 204, so the frame keeps its page and nothing is fetched.
 */
async function blockFrameNavigation(context: BrowserContext, appUrl: string): Promise<void> {
  const appOrigin = new URL(appUrl).origin;
  const port = new URL(appUrl).port;
  await context.route(
    (url) => url.origin !== appOrigin,
    async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest() || !request.frame().parentFrame()) {
        await route.continue();
        return;
      }
      const url = new URL(request.url());
      const isViewDocument =
        url.protocol === "http:" &&
        /^[0-9a-f]+(-[0-9a-f]+){4}$/.test(url.hostname) &&
        url.port === port &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash;
      if (isViewDocument) await route.continue();
      else await route.fulfill({ status: 204 });
    },
  );
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
  const env = launchEnv(userDataDir, agentDir, normalized);
  const child = spawn(binary, [], { cwd: desktopDir, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => {
    output.push(...chunk.toString("utf8").split("\n").filter(Boolean));
    output.splice(0, Math.max(0, output.length - 200));
  });
  let exitedNow = false;
  const exited = new Promise<void>((resolveExit) =>
    child.once("exit", () => {
      exitedNow = true;
      resolveExit();
    }),
  );
  let browser: Browser | undefined;
  try {
    const url = await waitForListening(child, output);
    const wsUrl = url.replace(/^http/, "ws");
    const control = await connectControl(wsUrl);
    browser = await chromium.launch({
      executablePath: chromiumExecutable(),
      args: [
        `--host-resolver-rules=MAP ${EXTENSION_FRAME_HOSTS} 127.0.0.1`,
        `--proxy-bypass-list=${EXTENSION_FRAME_HOSTS}`,
      ],
    });
    const openedBrowser = browser;
    // The windows go with the app, as Electron's do when its process exits.
    exited.then(() => openedBrowser.close()).catch(() => undefined);
    const context: BrowserContext = await browser.newContext({ viewport: WINDOW_SIZE });
    await blockFrameNavigation(context, url);
    const pageUrl = `${url}/?testhost=${encodeURIComponent(wsUrl)}`;
    const pages: Page[] = [];
    const openWindow = async () => {
      const page = await context.newPage();
      await page.goto(pageUrl);
      await page.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
        timeout: 15_000,
      });
      pages.push(page);
      page.once("close", () => pages.splice(pages.indexOf(page), 1));
      return page;
    };
    let first: Promise<Page> | undefined;
    const firstWindow = () => (first ??= openWindow());
    const pageOf = async (window?: Page) => window ?? (await firstWindow());
    const focus = async (window?: Page) => {
      await control.call("focusWindow", { window: await windowIdOf(await pageOf(window)) });
    };
    // The shell's log is drained by each read, so it is kept here.
    const shellLog: { kind: string; url?: string }[] = [];
    const readShellLog = async () => {
      shellLog.push(...(await control.call<typeof shellLog>("shellLog")));
      return shellLog;
    };
    const openDialogs = async () =>
      (await readShellLog()).filter((entry) => entry.kind === "openDialog").length;
    let openDialogsBefore = 0;

    return {
      target: "testhost",
      url,
      control,
      firstWindow,
      newWindow: openWindow,
      focusWindow: async () => {
        await focus();
        await (await firstWindow()).bringToFront();
      },
      context: () => context,
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
        if (timedOut) throw new Error(`pi-gui-testhost did not quit:\n${output.join("\n")}`);
      },
      app: {
        pid: child.pid,
        waitForExit: () => exited,
        hasExited: () => exitedNow,
        quit: async () => {
          await control.call("quit");
        },
        activate: () => focus(),
        secondInstance: unsupported("A second app instance"),
        isReady: () => Promise.resolve(!exitedNow),
        hasSingleInstanceLock: unsupported("The single-instance lock"),
        env: (name) => Promise.resolve(env[name]),
        mainProcessType: () => Promise.resolve("testhost"),
        identity: unsupported("The app identity"),
        decodeImage: (base64) =>
          control.call<{ empty: boolean; width: number; height: number }>("decodeImage", {
            data: base64,
          }),
      },
      windows: {
        count: async () => (await control.call<number[]>("windows")).length,
        pages: () => [...pages],
        waitForNew: unsupported("A window the app opens itself"),
        state: async (window) => {
          const state = await control.call<WindowStateReport | null>("windowState", {
            window: await windowIdOf(await pageOf(window)),
          });
          if (!state) return undefined;
          return {
            focused: state.focused,
            minimized: state.minimized,
            maximized: state.maximized,
            visible: state.visible,
            backgroundColor: windowBackgroundFor(state.themePresetId, state.resolvedTheme),
          };
        },
        close: async (window) => {
          // The host holds the close until the page sends its draft, as Electron main does.
          const page = await pageOf(window);
          await control.call("closeWindow", { window: await windowIdOf(page) });
          // Closing the last window quits, and the pages go with the app.
          await page.close().catch((error: unknown) => {
            if (!exitedNow) throw error;
          });
        },
        show: (window) => focus(window),
        focus,
        minimize: unsupported("Minimizing a window"),
        emitFocus: async (window) => {
          if (window !== "all") return focus(window);
          for (const page of pages) await focus(page);
        },
        setSize: async (size, window) => {
          await (await pageOf(window)).setViewportSize(size);
          return true;
        },
        setContentSize: async (size, window) => {
          await (await pageOf(window)).setViewportSize(size);
        },
        setBounds: async ({ width, height }) => {
          await (await firstWindow()).setViewportSize({ width, height });
        },
        crashRenderer: unsupported("Crashing a renderer"),
      },
      keyboard: { send: unsupported("Native key events") },
      clipboard: {
        writeText: unsupported("The clipboard"),
        writeImage: unsupported("The clipboard"),
      },
      externalUrls: {
        capture: async () => {
          const from = (await readShellLog()).length;
          return async () =>
            (await readShellLog())
              .slice(from)
              .filter((entry) => entry.kind === "openExternal")
              .map((entry) => entry.url ?? "");
        },
      },
      dialogs: {
        stubNextOpenDialog: async (result) => {
          openDialogsBefore = await openDialogs();
          await control.call("queueOpenDialog", {
            paths: result.canceled ? null : result.filePaths,
          });
        },
        holdNextOpenDialog: unsupported("Holding an open dialog"),
        releaseHeldOpenDialog: unsupported("Holding an open dialog"),
        openDialogCount: async () => (await openDialogs()) - openDialogsBefore,
        beginTextPrompt: async (message, placeholder) => {
          const { prompt, outcome } = await control.call<{ prompt: number; outcome: number }>(
            "beginTextPrompt",
            { message, placeholder },
          );
          const page = await context.newPage();
          await page.goto(`${url}/__testhost/prompt?id=${prompt}`);
          const result = control.call<TextPromptOutcome>("textPromptOutcome", { outcome });
          // Main destroys the prompt window once it is answered.
          const closePage = () => page.close().catch(() => undefined);
          void result.then(closePage, closePage);
          return { window: page, outcome: () => result };
        },
      },
      menu: {
        item: unsupported("The application menu"),
        click: unsupported("The application menu"),
      },
      hooks: testHostHooks(control, focus),
      driver: testHostDriver(control),
      ipc: testHostIpc(control),
    };
  } catch (error) {
    child.kill("SIGKILL");
    await browser?.close();
    throw error;
  }
}

function testHostHooks(
  control: TestHostControl,
  focus: (window?: Page) => Promise<void>,
): DesktopTestHooks {
  return {
    emitSessionEvents: async (events) => {
      for (const event of events) await control.call("emitSessionEvent", { event });
    },
    fireDueScheduledTasks: unsupported("Firing scheduled tasks"),
    runOrchestrationRuntimeTool: unsupported("The orchestration runtime tool"),
    runScheduledTaskRuntimeTool: unsupported("The scheduled-task runtime tool"),
    handleWindowActivation: () => focus(),
    setSessionVisibility: async (mode) => {
      await control.call("setSessionVisibility", { value: mode });
    },
    deferThreadTitles: unsupported("Deferring thread titles"),
    hasDeferredThreadTitle: unsupported("Deferring thread titles"),
    resolveDeferredThreadTitle: unsupported("Deferring thread titles"),
    rejectDeferredThreadTitle: unsupported("Deferring thread titles"),
    piHostPid: () => control.call<number | undefined>("piHostPid"),
  };
}

interface HeldCall {
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

/** The kernel lists only calls still held; answered ones are remembered here. */
function testHostDriver(control: TestHostControl): PiDriverControl {
  return {
    intercept: async (method) => {
      await control.call("driver.intercept", { method });
      const records = new Map<string, PiDriverCallRecord>();
      const list = async () => {
        for (const call of await control.call<HeldCall[]>("driver.pending")) {
          const id = String(call.id);
          if (call.method === method && !records.has(id)) {
            records.set(id, { id, method, args: call.args, outcome: "pending" });
          }
        }
        return [...records.values()];
      };
      const answer = async (
        record: PiDriverCallRecord,
        params: Record<string, unknown>,
        outcome: PiDriverCallRecord["outcome"],
      ) => {
        await control.call("driver.complete", { id: Number(record.id), ...params });
        records.set(record.id, { ...record, outcome });
      };
      const handle = (record: PiDriverCallRecord): InterceptedDriverCall => ({
        ...record,
        complete: (result) => answer(record, result === undefined ? {} : { result }, "completed"),
        fail: (message) => answer(record, { error: { name: "Error", message } }, "failed"),
      });
      let handedOut = 0;
      return {
        nextCall: async (options) => {
          let next: PiDriverCallRecord | undefined;
          await expect
            .poll(
              async () => {
                next = (await list())[handedOut];
                return next !== undefined;
              },
              {
                message: `Expected the app to call pi's ${method}`,
                timeout: options?.timeout ?? HELD_DRIVER_CALL_TIMEOUT_MS,
              },
            )
            .toBe(true);
          handedOut += 1;
          return handle(next!);
        },
        calls: list,
        restore: async () => {
          await control.call("driver.release", { method });
        },
      };
    },
  };
}

function testHostIpc(control: TestHostControl): DesktopIpcControl {
  return {
    control: async (channel, options) => {
      await control.call("invokeControl.install", {
        channel,
        mode: options.mode,
        sentinel: options.sentinel ?? HYDRATE_TEST_SENTINEL,
        ...(options.replacement === undefined ? {} : { replacement: options.replacement }),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
        ...(options.queue === undefined ? {} : { queue: options.queue }),
      });
    },
    update: async (channel, patch) => {
      await control.call("invokeControl.set", { channel, ...patch });
    },
    read: (channel) => control.call<IpcInvokeControlSnapshot>("invokeControl.read", { channel }),
    release: async (channel) => {
      await control.call("invokeControl.release", { channel });
    },
    settled: async (channel) => {
      await control.call("invokeControl.settled", { channel });
    },
    invokeTogether: async (requests) => {
      await control.call("invokeTogether", { requests });
    },
  };
}
