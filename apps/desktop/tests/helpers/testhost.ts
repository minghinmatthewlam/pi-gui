import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import {
  HYDRATE_TEST_SENTINEL,
  type DesktopHarness,
  type DesktopIpcControl,
  type DesktopTestHooks,
  type InterceptedDriverCall,
  type IpcInvokeControlSnapshot,
  type PiDriverCallRecord,
  type PiDriverControl,
  type RuntimeToolTestInput,
  type RuntimeToolTestResult,
  type TextPromptOutcome,
} from "./desktop-harness";
import type { DesktopAppState, ThemePresetId } from "../../contracts/desktop-state";
import { windowBackgroundFor, type ResolvedTheme } from "../../contracts/theme";
import {
  createScheduledTaskRuntimeTools,
  type ScheduledTaskRuntimeBridge,
} from "../../electron/scheduled-tasks/scheduled-task-runtime";
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

export interface TestHostLaunchOptions {
  readonly initialWorkspaces?: readonly string[];
  readonly testMode?: "foreground" | "background";
  readonly agentDir?: string;
  readonly enabledModels?: readonly string[];
  readonly envOverrides?: Readonly<Record<string, string | undefined>>;
  readonly notificationLogPath?: string;
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
    ...(options.notificationLogPath
      ? { PI_APP_NOTIFICATION_LOG_PATH: options.notificationLogPath }
      : {}),
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
/** A navigation inside a page's frame, as opposed to a page (or a page a link opens) loading. */
function isFrameNavigation(request: Request): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame().parentFrame() !== null;
  } catch {
    // A page a link opens has no frame yet when its first request is routed.
    return false;
  }
}

async function blockFrameNavigation(context: BrowserContext, appUrl: string): Promise<void> {
  const appOrigin = new URL(appUrl).origin;
  const port = new URL(appUrl).port;
  await context.route(
    (url) => url.origin !== appOrigin,
    async (route) => {
      const request = route.request();
      if (!isFrameNavigation(request)) {
        await route.fallback();
        return;
      }
      const url = new URL(request.url());
      const isViewDocument =
        url.protocol === "http:" &&
        /^[0-9a-f]+(-[0-9a-f]+){4}\.localhost$/.test(url.hostname) &&
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
        // A call after the host quit (a second close, say) fails rather than waiting forever.
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error("pi-gui-testhost closed"));
          return;
        }
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
  // A relaunch serves the same origin, so the pages keep their local storage as Electron's
  // profile does.
  const portFile = join(userDataDir, "testhost-port");
  if (existsSync(portFile) && env.PI_GUI_TESTHOST_PORT === undefined) {
    env.PI_GUI_TESTHOST_PORT = readFileSync(portFile, "utf8").trim();
  }
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
  let browser: BrowserContext | undefined;
  try {
    const url = await waitForListening(child, output);
    writeFileSync(portFile, new URL(url).port);
    const wsUrl = url.replace(/^http/, "ws");
    const control = await connectControl(wsUrl);
    // The browser profile lives in the app's profile folder, like Electron's, and pages share
    // the browser's clipboard, as Electron windows share the system one.
    browser = await chromium.launchPersistentContext(join(userDataDir, "testhost-browser"), {
      executablePath: chromiumExecutable(),
      viewport: WINDOW_SIZE,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const context: BrowserContext = browser;
    // The windows go with the app, as Electron's do when its process exits. Pages close the
    // way a window does, so their pagehide handlers save what is still pending (a pane width,
    // say) before the browser goes.
    let windowsClosed: Promise<void> | undefined;
    const closeWindows = () =>
      (windowsClosed ??= (async () => {
        await Promise.all(
          context.pages().map(async (page) => {
            if (page.isClosed()) return;
            const closed = new Promise((resolveClose) => page.once("close", resolveClose));
            await page.close({ runBeforeUnload: true }).catch(() => undefined);
            await closed;
          }),
        );
        await context.close();
      })());
    exited.then(closeWindows).catch(() => undefined);
    await blockFrameNavigation(context, url);
    const pageUrl = `${url}/?testhost=${encodeURIComponent(wsUrl)}`;
    const pages: Page[] = [];
    // The persistent browser opens with a blank page; the first window uses it.
    let blankPage: Page | undefined = context.pages()[0];
    // Windows being opened, whose pages are not yet in `pages`.
    let openingWindows = 0;
    // Like Electron's navigation handlers, a page never leaves the app: the host gets the URL
    // instead, and a tab a link opened for it is closed.
    const appOrigin = new URL(url).origin;
    await context.route(
      (target) => target.origin !== appOrigin,
      async (route) => {
        const request = route.request();
        if (isFrameNavigation(request)) {
          // A frame inside a page: `blockFrameNavigation` decides.
          await route.fallback();
          return;
        }
        if (!request.isNavigationRequest()) {
          await route.continue();
          return;
        }
        await route.abort().catch(() => undefined);
        await control.call("navigateAway", { url: request.url() }).catch(() => undefined);
        if (openingWindows > 0) return;
        for (const page of context.pages()) {
          if (!pages.includes(page) && page !== blankPage) await page.close();
        }
      },
    );
    const openWindow = async () => {
      openingWindows += 1;
      const page = blankPage ?? (await context.newPage());
      blankPage = undefined;
      try {
        await page.goto(pageUrl);
        await page.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
          timeout: 15_000,
        });
      } finally {
        openingWindows -= 1;
      }
      pages.push(page);
      page.once("close", () => pages.splice(pages.indexOf(page), 1));
      return page;
    };
    let first: Promise<Page> | undefined;
    const firstWindow = () => (first ??= openWindow());
    const pageOf = async (window?: Page) => window ?? (await firstWindow());
    const windowOf = async (window?: Page) => windowIdOf(await pageOf(window));
    const focus = async (window?: Page) => {
      await control.call("focusWindow", { window: await windowOf(window) });
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
        await closeWindows();
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
        secondInstance: async () => {
          await control.call("secondInstance");
        },
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
            window: await windowOf(window),
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
        show: async (window) => {
          await control.call("showWindow", { window: await windowOf(window) });
        },
        focus,
        minimize: async (window) => {
          await control.call("minimizeWindow", { window: await windowOf(window) });
        },
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
      keyboard: {
        // The host routes the key as main's before-input-event would; a key main leaves
        // alone reaches the page as a real key press.
        send: async (event, window) => {
          const page = await pageOf(window);
          const modifiers = event.modifiers ?? [];
          const { route } = await control.call<{ route: "newWindow" | "handled" | "page" }>(
            "keyboard",
            { window: await windowIdOf(page), keyCode: event.keyCode, modifiers, type: event.type },
          );
          if (route === "newWindow") {
            await openWindow();
            return;
          }
          if (route === "handled") return;
          const names: Record<string, string> = {
            shift: "Shift",
            control: "Control",
            alt: "Alt",
            meta: "Meta",
          };
          const chord = [...modifiers.flatMap((modifier) => names[modifier] ?? []), event.keyCode];
          if (event.type === "keyUp") await page.keyboard.up(chord.join("+"));
          else await page.keyboard.press(chord.join("+"));
        },
      },
      clipboard: {
        writeText: async (text) => {
          await (
            await firstWindow()
          ).evaluate((value) => navigator.clipboard.writeText(value), text);
        },
        writeImage: async (pngBase64) => {
          await (
            await firstWindow()
          ).evaluate(async (data) => {
            const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
            const image = new Blob([bytes], { type: "image/png" });
            await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
          }, pngBase64);
        },
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
        holdNextOpenDialog: async (filePaths) => {
          openDialogsBefore = await openDialogs();
          await control.call("holdOpenDialog", { paths: filePaths });
        },
        releaseHeldOpenDialog: async () => {
          await control.call("releaseOpenDialog");
        },
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
  // Title requests are held in the kernel's pi driver. As under Electron, only the latest
  // request can be answered; one that a newer request replaced stays unanswered.
  const settledTitles = new Set<number>();
  const latestTitleRequest = async () => {
    const held = (await control.call<HeldCall[]>("driver.pending")).filter(
      (call) => call.method === "generateThreadTitle" && !settledTitles.has(call.id),
    );
    for (const call of held) settledTitles.add(call.id);
    const latest = held.at(-1);
    if (!latest) throw new Error("Deferred thread-title request is unavailable");
    return latest;
  };
  return {
    emitSessionEvents: async (events) => {
      for (const event of events) await control.call("emitSessionEvent", { event });
    },
    fireDueScheduledTasks: (nowIso) =>
      control.call<DesktopAppState>("fireDueScheduledTasks", nowIso ? { nowIso } : {}),
    runOrchestrationRuntimeTool: unsupported("The orchestration runtime tool"),
    runScheduledTaskRuntimeTool: (input) => runScheduledTaskTool(control, input),
    handleWindowActivation: () => focus(),
    setSessionVisibility: async (mode) => {
      await control.call("setSessionVisibility", { value: mode });
    },
    deferThreadTitles: async () => {
      await control.call("driver.intercept", { method: "generateThreadTitle" });
    },
    hasDeferredThreadTitle: async () =>
      (await control.call<HeldCall[]>("driver.pending")).some(
        (call) => call.method === "generateThreadTitle" && !settledTitles.has(call.id),
      ),
    resolveDeferredThreadTitle: async (title) => {
      const { id } = await latestTitleRequest();
      await control.call("driver.complete", { id, result: title });
    },
    rejectDeferredThreadTitle: async () => {
      const { id } = await latestTitleRequest();
      await control.call("driver.complete", {
        id,
        error: { name: "Error", message: "Deferred thread-title rejected by test" },
      });
    },
    piHostPid: () => control.call<number | undefined>("piHostPid"),
  };
}

/**
 * Runs the scheduled-task tool definitions here, as the pi host does, with their bodies called
 * through the kernel's `app.tool`, as the host calls them.
 */
async function runScheduledTaskTool(
  control: TestHostControl,
  input: RuntimeToolTestInput,
): Promise<RuntimeToolTestResult> {
  const call =
    (tool: string) =>
    (_ctx: unknown, toolInput?: unknown): Promise<never> =>
      control.call("tool", {
        tool,
        sessionRef: input.sessionRef,
        ...(toolInput === undefined ? {} : { input: toolInput }),
      });
  const bridge: ScheduledTaskRuntimeBridge = {
    createScheduledTask: call("scheduled.createScheduledTask"),
    listScheduledTasks: call("scheduled.listScheduledTasks"),
    updateScheduledTask: call("scheduled.updateScheduledTask"),
  };
  const tool = createScheduledTaskRuntimeTools(bridge, () => input.sessionRef.workspaceId).find(
    (entry) => entry.name === input.toolName,
  );
  if (!tool) {
    throw new Error(`Unknown scheduled-task runtime tool: ${input.toolName}`);
  }
  return (await tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  )) as RuntimeToolTestResult;
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
