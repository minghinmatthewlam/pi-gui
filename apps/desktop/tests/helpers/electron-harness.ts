import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  HYDRATE_TEST_SENTINEL,
  type DesktopHarness,
  type DesktopIpcControl,
  type DesktopWindowState,
  type InterceptedDriverCall,
  type IpcInvokeControlMode,
  type IpcInvokeControlSnapshot,
  type NativeKeyEvent,
  type PiDriverCallRecord,
  type PiDriverInterception,
  type RuntimeToolTestResult,
  type TextPromptOutcome,
} from "./desktop-harness";

// The Electron backend of the desktop harness. Everything that reaches into Electron's main
// process lives here; specs only see the `DesktopHarness` interface.

const execFileAsync = promisify(execFile);
const require = createRequire(__filename);
const electronExecutablePath = require("electron") as string;
// Quit is bounded at a few seconds in main; past this the app is stuck, not slow.
const APP_EXIT_TIMEOUT_MS = 30_000;
const APP_OUTPUT_TAIL_LINES = 40;
const HELD_DRIVER_CALL_TIMEOUT_MS = 15_000;

/** The Electron harness; only Electron-only suites (packaged, perf, media) use `electronApp`. */
export interface ElectronDesktopHarness extends DesktopHarness {
  readonly electronApp: ElectronApplication;
}

function isPlaceholderElectronPage(page: Page): boolean {
  const url = page.url();
  return url === "" || url === "about:blank";
}

async function waitForDesktopRendererPage(
  electronApp: ElectronApplication,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  const pick = () =>
    electronApp.windows().find((candidate) => !isPlaceholderElectronPage(candidate));
  const existing = pick();
  if (existing) {
    return existing;
  }

  while (Date.now() < deadline) {
    const found = pick();
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const urls = electronApp.windows().map((candidate) => candidate.url() || "<empty>");
  throw new Error(
    `Timed out waiting for desktop renderer window (urls: ${urls.join(", ") || "<none>"})`,
  );
}

export function createElectronHarness(electronApp: ElectronApplication): ElectronDesktopHarness {
  let page: Page | undefined;
  const outputTail: string[] = [];
  const appProcess = electronApp.process();
  appProcess.stderr?.on("data", (chunk: Buffer) => {
    outputTail.push(...chunk.toString("utf8").split("\n").filter(Boolean));
    outputTail.splice(0, Math.max(0, outputTail.length - APP_OUTPUT_TAIL_LINES));
  });
  const hasExited = () => appProcess.exitCode !== null || appProcess.signalCode !== null;
  const exited = new Promise<void>((resolveExit) => {
    if (hasExited()) resolveExit();
    else appProcess.once("exit", () => resolveExit());
  });

  async function getWindow(): Promise<Page> {
    if (!page) {
      // Playwright's Electron video recorder can expose an empty page before the
      // real BrowserWindow finishes loadURL. firstWindow() would attach to that
      // placeholder and hang on domcontentloaded.
      page = await waitForDesktopRendererPage(electronApp);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
        timeout: 15_000,
      });
    }
    return page;
  }

  /** `BrowserWindow.getAllWindows()` index of a page's window; 0 (the first) when omitted. */
  async function windowIndex(window: Page | undefined): Promise<number> {
    if (!window) return 0;
    const marker = `pi-gui-window-${Date.now()}-${Math.random()}`;
    await window.evaluate((value) => {
      Object.assign(window, { __piGuiTestWindowMarker: value });
    }, marker);
    const index = await electronApp.evaluate(async ({ BrowserWindow }, value) => {
      const windows = BrowserWindow.getAllWindows();
      for (const [candidateIndex, candidateWindow] of windows.entries()) {
        const candidateMarker: unknown = await candidateWindow.webContents
          .executeJavaScript("window.__piGuiTestWindowMarker", true)
          .catch(() => undefined);
        if (candidateMarker === value) {
          return candidateIndex;
        }
      }
      return -1;
    }, marker);
    if (index === -1) {
      throw new Error("Expected source page to belong to the Electron app.");
    }
    return index;
  }

  /** Calls the test hook at `path` on main's `__PI_APP_TEST_HOOKS` with `args`. */
  function callHook<T>(path: readonly string[], ...args: unknown[]): Promise<T> {
    return electronApp.evaluate(
      async (_, input) => {
        let owner: unknown;
        let hook: unknown = (globalThis as { __PI_APP_TEST_HOOKS?: unknown }).__PI_APP_TEST_HOOKS;
        for (const key of input.path) {
          owner = hook;
          hook = (hook as Record<string, unknown> | undefined)?.[key];
        }
        if (typeof hook !== "function") {
          throw new Error(`Test hook ${input.path.join(".")} is unavailable`);
        }
        return (await hook.apply(owner, input.args)) as T;
      },
      { path: [...path], args },
    );
  }

  const ipc = electronIpcControl(electronApp);

  const harness: ElectronDesktopHarness = {
    target: "electron",
    electronApp,
    firstWindow: () => getWindow(),
    context: () => electronApp.context(),
    focusWindow: async () => {
      const appPage = await getWindow();
      await electronApp.evaluate(({ BrowserWindow, app }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.restore();
        window?.show();
        app.focus({ steal: true });
        window?.focus();
      });
      if (process.platform === "darwin") {
        await focusElectronAppProcess(electronApp);
      }
      await electronApp.evaluate(({ BrowserWindow, app }) => {
        const window = BrowserWindow.getAllWindows()[0];
        app.focus({ steal: true });
        window?.focus();
      });
      await appPage.bringToFront();
      await expect
        .poll(
          async () => {
            const nativeFocused = await electronApp.evaluate(({ BrowserWindow }) => {
              const window = BrowserWindow.getAllWindows()[0];
              return window?.isFocused() ?? false;
            });
            if (nativeFocused) {
              return true;
            }
            return appPage.evaluate(() => document.hasFocus());
          },
          { timeout: 5_000 },
        )
        .toBe(true);
    },
    close: async () => {
      // Playwright waits with no bound until the app and every process holding its output
      // pipes are gone, and the worker's teardown then hangs on the same wait. Log quit's
      // progress to the output and fail fast instead.
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), APP_EXIT_TIMEOUT_MS);
      });
      const closed = electronApp
        .evaluate(({ app, BrowserWindow }) => {
          const log = (stage: string) => process.stderr.write(`[test quit] ${stage}\n`);
          app.prependListener("before-quit", () => log("before-quit"));
          app.once("will-quit", () => log("will-quit"));
          for (const window of BrowserWindow.getAllWindows()) {
            window.on("close", (event) =>
              log(`window ${window.id} close${event.defaultPrevented ? " held" : ""}`),
            );
          }
        })
        .catch(() => undefined)
        .then(() => electronApp.close())
        .then(() => true);
      const finished = await Promise.race([closed, timedOut]).finally(() => clearTimeout(timer));
      if (finished) return;
      closed.catch(() => undefined);
      const exitState = hasExited()
        ? `exited (${appProcess.exitCode ?? appProcess.signalCode})`
        : "is still running";
      const leftovers = await processGroupListing(appProcess.pid);
      // Playwright launches the app as a process group leader, so this also ends the
      // processes it started that still hold its output pipes.
      if (appProcess.pid && process.platform !== "win32") {
        try {
          process.kill(-appProcess.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
      } else {
        appProcess.kill("SIGKILL");
      }
      throw new Error(
        [
          `The app did not finish closing within ${APP_EXIT_TIMEOUT_MS / 1000} s of quitting, so it was killed. The app ${exitState}.`,
          `Processes left in its group:\n${leftovers}`,
          `Last app output:\n${outputTail.join("\n")}`,
        ].join("\n"),
      );
    },

    app: {
      pid: appProcess.pid,
      waitForExit: () => exited,
      hasExited,
      quit: () => electronApp.evaluate(({ app }) => app.quit()),
      activate: async () => {
        await electronApp.evaluate(({ app }) => {
          app.emit("activate");
        });
      },
      secondInstance: async () => {
        await electronApp.evaluate(({ app }) => {
          app.emit("second-instance");
        });
      },
      isReady: () => electronApp.evaluate(({ app }) => app.isReady()),
      hasSingleInstanceLock: () => electronApp.evaluate(({ app }) => app.hasSingleInstanceLock()),
      env: (name) => electronApp.evaluate((_, key) => process.env[key], name),
      mainProcessType: () => electronApp.evaluate(() => process.type),
      identity: () =>
        electronApp.evaluate(({ app, BrowserWindow }) => ({
          pid: process.pid,
          appPath: app.getAppPath(),
          userData: app.getPath("userData"),
          visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
          focused: BrowserWindow.getAllWindows()[0]?.isFocused(),
          testMode: process.env.PI_APP_TEST_MODE ?? null,
          testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
        })),
      decodeImage: (base64) =>
        electronApp.evaluate(({ nativeImage }, data) => {
          const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
          return { empty: image.isEmpty(), ...image.getSize() };
        }, base64),
    },

    windows: {
      count: () =>
        electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      pages: () => electronApp.windows(),
      waitForNew: () => electronApp.waitForEvent("window"),
      state: async (window) =>
        electronApp.evaluate(
          ({ BrowserWindow }, index): DesktopWindowState | undefined => {
            const target = BrowserWindow.getAllWindows()[index];
            if (!target) return undefined;
            return {
              focused: target.isFocused(),
              minimized: target.isMinimized(),
              maximized: target.isMaximized(),
              visible: target.isVisible(),
              backgroundColor: target.getBackgroundColor().toLowerCase(),
            };
          },
          await windowIndex(window),
        ),
      close: async (window) => {
        await electronApp.evaluate(
          ({ BrowserWindow }, index) => {
            BrowserWindow.getAllWindows()[index]?.close();
          },
          await windowIndex(window),
        );
      },
      show: async (window) => {
        await electronApp.evaluate(
          ({ BrowserWindow }, index) => {
            BrowserWindow.getAllWindows()[index]?.show();
          },
          await windowIndex(window),
        );
      },
      focus: async (window) => {
        await electronApp.evaluate(
          ({ BrowserWindow }, index) => {
            BrowserWindow.getAllWindows()[index]?.focus();
          },
          await windowIndex(window),
        );
      },
      minimize: async (window) => {
        await electronApp.evaluate(
          ({ BrowserWindow }, index) => {
            BrowserWindow.getAllWindows()[index]?.minimize();
          },
          await windowIndex(window),
        );
      },
      emitFocus: async (window) => {
        const index = window === "all" ? -1 : await windowIndex(window);
        await electronApp.evaluate(({ BrowserWindow }, target) => {
          const windows = BrowserWindow.getAllWindows();
          for (const win of target === -1 ? windows : windows.slice(target, target + 1)) {
            win.emit("focus");
          }
        }, index);
      },
      setSize: async (size, window) =>
        electronApp.evaluate(
          ({ BrowserWindow }, input) => {
            const target = BrowserWindow.getAllWindows()[input.index];
            if (!target) return false;
            target.setSize(input.width, input.height);
            return true;
          },
          { ...size, index: await windowIndex(window) },
        ),
      setContentSize: async (size, window) => {
        await electronApp.evaluate(
          ({ BrowserWindow }, input) => {
            BrowserWindow.getAllWindows()[input.index]?.setContentSize(input.width, input.height);
          },
          { ...size, index: await windowIndex(window) },
        );
      },
      setBounds: async (bounds) => {
        await electronApp.evaluate(({ BrowserWindow }, next) => {
          BrowserWindow.getAllWindows()[0]?.setBounds(next);
        }, bounds);
      },
      crashRenderer: async (window) => {
        await electronApp.evaluate(
          ({ BrowserWindow }, index) => {
            const contents = BrowserWindow.getAllWindows()[index]?.webContents as
              { forcefullyCrashRenderer?: () => void } | undefined;
            contents?.forcefullyCrashRenderer?.();
          },
          await windowIndex(window),
        );
      },
    },

    keyboard: {
      send: async (event: NativeKeyEvent, window) => {
        await electronApp.evaluate(
          ({ BrowserWindow }, input) => {
            BrowserWindow.getAllWindows()[input.index]?.webContents.sendInputEvent({
              type: input.type,
              keyCode: input.keyCode,
              modifiers: input.modifiers as Electron.InputEvent["modifiers"],
            });
          },
          {
            type: event.type ?? "keyDown",
            keyCode: event.keyCode,
            modifiers: [...(event.modifiers ?? [])],
            index: await windowIndex(window),
          },
        );
      },
    },

    clipboard: {
      writeText: async (text) => {
        await electronApp.evaluate(({ clipboard }, value) => {
          clipboard.writeText(value);
        }, text);
      },
      writeImage: async (pngBase64) => {
        await electronApp.evaluate(({ clipboard, nativeImage }, data) => {
          const image = nativeImage.createFromDataURL(`data:image/png;base64,${data}`);
          if (image.isEmpty()) {
            throw new Error("The desktop-owned clipboard PNG fixture could not be decoded");
          }
          clipboard.writeImage(image);
        }, pngBase64);
      },
    },

    externalUrls: {
      capture: async () => {
        await electronApp.evaluate(({ shell }) => {
          const globals = globalThis as typeof globalThis & {
            __piGuiOpenedExternalUrls?: string[];
          };
          globals.__piGuiOpenedExternalUrls = [];
          shell.openExternal = async (url: string) => {
            globals.__piGuiOpenedExternalUrls?.push(url);
          };
        });
        return () =>
          electronApp.evaluate(
            () =>
              (globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] })
                .__piGuiOpenedExternalUrls ?? [],
          );
      },
    },

    dialogs: {
      stubNextOpenDialog: async (result) => {
        await electronApp.evaluate(({ dialog }, nextResult) => {
          const original = dialog.showOpenDialog;
          (globalThis as { __PI_TEST_OPEN_DIALOG_COUNT?: number }).__PI_TEST_OPEN_DIALOG_COUNT = 0;
          dialog.showOpenDialog = async (...args: Parameters<typeof dialog.showOpenDialog>) => {
            void args;
            dialog.showOpenDialog = original;
            const globals = globalThis as { __PI_TEST_OPEN_DIALOG_COUNT?: number };
            globals.__PI_TEST_OPEN_DIALOG_COUNT = (globals.__PI_TEST_OPEN_DIALOG_COUNT ?? 0) + 1;
            return { canceled: nextResult.canceled, filePaths: [...nextResult.filePaths] };
          };
        }, result);
      },
      holdNextOpenDialog: async (filePaths) => {
        await electronApp.evaluate(({ dialog }, nextFilePaths) => {
          const original = dialog.showOpenDialog;
          const globals = globalThis as {
            __PI_TEST_OPEN_DIALOG_COUNT?: number;
            __PI_TEST_RESOLVE_OPEN_DIALOG?: () => void;
          };
          globals.__PI_TEST_OPEN_DIALOG_COUNT = 0;
          dialog.showOpenDialog = async () =>
            new Promise((resolve) => {
              globals.__PI_TEST_OPEN_DIALOG_COUNT = (globals.__PI_TEST_OPEN_DIALOG_COUNT ?? 0) + 1;
              globals.__PI_TEST_RESOLVE_OPEN_DIALOG = () => {
                dialog.showOpenDialog = original;
                delete globals.__PI_TEST_RESOLVE_OPEN_DIALOG;
                resolve({ canceled: false, filePaths: [...nextFilePaths] });
              };
            });
        }, filePaths);
      },
      releaseHeldOpenDialog: async () => {
        await electronApp.evaluate(() => {
          const resolveOpenDialog = (globalThis as { __PI_TEST_RESOLVE_OPEN_DIALOG?: () => void })
            .__PI_TEST_RESOLVE_OPEN_DIALOG;
          if (!resolveOpenDialog) {
            throw new Error("Delayed open dialog was not pending.");
          }
          resolveOpenDialog();
        });
      },
      openDialogCount: () =>
        electronApp.evaluate(
          () =>
            (globalThis as { __PI_TEST_OPEN_DIALOG_COUNT?: number }).__PI_TEST_OPEN_DIALOG_COUNT ??
            0,
        ),
      beginTextPrompt: async (message, placeholder) => {
        const opened = electronApp.waitForEvent("window");
        await electronApp.evaluate(
          (_electron, payload) => {
            const hooks = (
              globalThis as {
                __PI_APP_TEST_HOOKS?: {
                  promptForText?: (
                    message: string,
                    placeholder?: string,
                    allowEmpty?: boolean,
                  ) => Promise<string>;
                };
              }
            ).__PI_APP_TEST_HOOKS;
            if (!hooks?.promptForText) {
              throw new Error("promptForText test hook is unavailable");
            }
            (globalThis as { __promptOutcome?: Promise<TextPromptOutcome> }).__promptOutcome = hooks
              .promptForText(payload.message, payload.placeholder, false)
              .then((value) => ({ ok: true as const, value }))
              .catch((error: unknown) => ({
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
              }));
          },
          { message, placeholder },
        );
        return {
          window: await opened,
          outcome: () =>
            electronApp.evaluate(
              () =>
                (globalThis as { __promptOutcome?: Promise<TextPromptOutcome> })
                  .__promptOutcome as Promise<TextPromptOutcome>,
            ),
        };
      },
    },

    menu: {
      item: (id) =>
        electronApp.evaluate(({ Menu }, targetId) => {
          const menu = Menu.getApplicationMenu();
          if (!menu) return null;

          const stack = menu.items.map((item) => ({ item, parentLabel: item.label ?? null }));
          while (stack.length > 0) {
            const entry = stack.shift();
            if (!entry) continue;
            const { item, parentLabel } = entry;
            if (item.id === targetId) {
              return {
                id: item.id,
                label: item.label,
                accelerator: item.accelerator ? String(item.accelerator) : "",
                parentLabel,
              };
            }
            for (const child of item.submenu?.items ?? []) {
              stack.push({ item: child, parentLabel: item.label || parentLabel });
            }
          }
          return null;
        }, id),
      click: (id) =>
        electronApp.evaluate(({ BrowserWindow, Menu }, targetId) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById(targetId);
          if (!item?.click) return false;
          Reflect.apply(item.click, item, [
            item,
            BrowserWindow.getFocusedWindow() ?? undefined,
            {},
          ]);
          return true;
        }, id),
    },

    hooks: {
      emitSessionEvents: async (events) => {
        await electronApp.evaluate(async (_, payloads) => {
          const hooks = (
            globalThis as {
              __PI_APP_TEST_HOOKS?: {
                emitSessionEvent?: (event: SessionDriverEvent) => Promise<void>;
              };
            }
          ).__PI_APP_TEST_HOOKS;
          if (!hooks?.emitSessionEvent) {
            throw new Error("Test session-event hook is unavailable");
          }
          for (const payload of payloads) {
            await hooks.emitSessionEvent(payload);
          }
        }, events);
      },
      fireDueScheduledTasks: async (nowIso) => {
        await getWindow();
        return callHook<DesktopAppState>(["fireDueScheduledTasks"], nowIso);
      },
      runOrchestrationRuntimeTool: async (input) => {
        await getWindow();
        return callHook<RuntimeToolTestResult>(["runOrchestrationRuntimeTool"], input);
      },
      runScheduledTaskRuntimeTool: async (input) => {
        await getWindow();
        return callHook<RuntimeToolTestResult>(["runScheduledTaskRuntimeTool"], input);
      },
      handleWindowActivation: () => callHook<void>(["handleWindowActivation"]),
      setSessionVisibility: async (mode) => {
        await electronApp.evaluate((_, nextMode) => {
          const globals = globalThis as {
            __PI_APP_TEST_SESSION_VISIBILITY__?: "active" | "inactive";
          };
          if (!nextMode) {
            delete globals.__PI_APP_TEST_SESSION_VISIBILITY__;
            return;
          }
          globals.__PI_APP_TEST_SESSION_VISIBILITY__ = nextMode;
        }, mode);
      },
      deferThreadTitles: () => callHook<void>(["setDeferredThreadTitleMode"]),
      hasDeferredThreadTitle: () => callHook<boolean>(["hasDeferredThreadTitle"]),
      resolveDeferredThreadTitle: (title) => callHook<void>(["resolveDeferredThreadTitle"], title),
      rejectDeferredThreadTitle: () => callHook<void>(["rejectDeferredThreadTitle"]),
      piHostPid: () => callHook<number | undefined>(["piHostPid"]),
    },

    driver: {
      intercept: async (method) => {
        await callHook<void>(["driver", "intercept"], method);
        let handedOut = 0;
        const list = () => callHook<readonly PiDriverCallRecord[]>(["driver", "list"], method);
        const handle = (record: PiDriverCallRecord): InterceptedDriverCall => ({
          ...record,
          complete: (result) => callHook<void>(["driver", "complete"], record.id, result),
          fail: (message) => callHook<void>(["driver", "fail"], record.id, message),
        });
        const interception: PiDriverInterception = {
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
          restore: () => callHook<void>(["driver", "restore"], method),
        };
        return interception;
      },
    },

    ipc,
  };
  return harness;
}

function electronIpcControl(electronApp: ElectronApplication): DesktopIpcControl {
  return {
    control: async (channel, options) => {
      await electronApp.evaluate(
        ({ ipcMain }, payload) => {
          type InvokeHandler = (...args: unknown[]) => unknown;
          type Control = {
            mode: IpcInvokeControlMode;
            invokeCount: number;
            rejectCount: number;
            sentinel: string;
            replacement?: unknown;
            delayMs?: number;
            queue?: string;
            args: unknown[][];
            held: (() => void)[];
            handled: Promise<unknown>[];
            original: InvokeHandler;
          };
          const store = globalThis as typeof globalThis & {
            __PI_TEST_IPC_INVOKE_CONTROL__?: Record<string, Control>;
            __PI_TEST_IPC_INVOKE_QUEUES__?: Record<string, Promise<unknown>>;
          };
          store.__PI_TEST_IPC_INVOKE_CONTROL__ ??= {};
          store.__PI_TEST_IPC_INVOKE_QUEUES__ ??= {};
          const existing = store.__PI_TEST_IPC_INVOKE_CONTROL__[payload.channel];
          if (existing) {
            existing.mode = payload.mode;
            existing.sentinel = payload.sentinel;
            existing.replacement = payload.replacement;
            existing.delayMs = payload.delayMs;
            existing.queue = payload.queue;
            return;
          }

          const invokeHandlers = (
            ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
          )._invokeHandlers;
          const originalHandler = invokeHandlers?.get(payload.channel);
          if (!originalHandler) {
            throw new Error(`No IPC handler registered for ${payload.channel}`);
          }
          const control: Control = {
            mode: payload.mode,
            invokeCount: 0,
            rejectCount: 0,
            sentinel: payload.sentinel,
            replacement: payload.replacement,
            delayMs: payload.delayMs,
            queue: payload.queue,
            args: [],
            held: [],
            handled: [],
            original: originalHandler,
          };
          store.__PI_TEST_IPC_INVOKE_CONTROL__[payload.channel] = control;

          const handle = async (args: unknown[]) => {
            if (control.mode === "hold") {
              await new Promise<void>((release) => control.held.push(release));
            }
            if (control.delayMs !== undefined) {
              await new Promise((resolve) => setTimeout(resolve, control.delayMs));
            }
            if (control.mode === "reject") {
              control.rejectCount += 1;
              throw new Error(control.sentinel);
            }
            if (control.mode === "replace") {
              return control.replacement;
            }
            if (control.mode === "record") {
              return undefined;
            }
            return control.original(...args);
          };
          ipcMain.removeHandler(payload.channel);
          ipcMain.handle(payload.channel, (...args) => {
            control.invokeCount += 1;
            control.args.push(args.slice(1));
            const queues = store.__PI_TEST_IPC_INVOKE_QUEUES__!;
            const queue = control.queue;
            const result = queue
              ? (queues[queue] ?? Promise.resolve()).then(() => handle(args))
              : handle(args);
            if (queue) queues[queue] = result.catch(() => undefined);
            control.handled.push(result.catch(() => undefined));
            return result;
          });
        },
        {
          channel,
          mode: options.mode,
          sentinel: options.sentinel ?? HYDRATE_TEST_SENTINEL,
          replacement: options.replacement,
          delayMs: options.delayMs,
          queue: options.queue,
        },
      );
    },
    update: async (channel, patch) => {
      await electronApp.evaluate(
        (_electron, payload) => {
          const control = readControl(payload.channel);
          if (payload.mode !== undefined) {
            control.mode = payload.mode;
          }
          if (payload.replacement !== undefined) {
            control.replacement = payload.replacement;
          }
          function readControl(name: string) {
            const store = globalThis as typeof globalThis & {
              __PI_TEST_IPC_INVOKE_CONTROL__?: Record<
                string,
                { mode: IpcInvokeControlMode; replacement?: unknown }
              >;
            };
            const found = store.__PI_TEST_IPC_INVOKE_CONTROL__?.[name];
            if (!found) throw new Error(`No IPC invoke control installed for ${name}`);
            return found;
          }
        },
        { channel, mode: patch.mode, replacement: patch.replacement },
      );
    },
    read: (channel) =>
      electronApp.evaluate((_electron, targetChannel): IpcInvokeControlSnapshot => {
        const store = globalThis as typeof globalThis & {
          __PI_TEST_IPC_INVOKE_CONTROL__?: Record<string, IpcInvokeControlSnapshot>;
        };
        const control = store.__PI_TEST_IPC_INVOKE_CONTROL__?.[targetChannel];
        if (!control) {
          throw new Error(`No IPC invoke control installed for ${targetChannel}`);
        }
        return {
          mode: control.mode,
          invokeCount: control.invokeCount,
          rejectCount: control.rejectCount,
          sentinel: control.sentinel,
          args: control.args,
        };
      }, channel),
    release: async (channel) => {
      await electronApp.evaluate((_electron, targetChannel) => {
        const store = globalThis as typeof globalThis & {
          __PI_TEST_IPC_INVOKE_CONTROL__?: Record<
            string,
            { mode: IpcInvokeControlMode; held: (() => void)[] }
          >;
        };
        const control = store.__PI_TEST_IPC_INVOKE_CONTROL__?.[targetChannel];
        if (!control) {
          throw new Error(`No IPC invoke control installed for ${targetChannel}`);
        }
        control.mode = "passthrough";
        for (const release of control.held.splice(0)) release();
      }, channel);
    },
    settled: async (channel) => {
      await electronApp.evaluate(async (_electron, targetChannel) => {
        const store = globalThis as typeof globalThis & {
          __PI_TEST_IPC_INVOKE_CONTROL__?: Record<string, { handled: Promise<unknown>[] }>;
        };
        const control = store.__PI_TEST_IPC_INVOKE_CONTROL__?.[targetChannel];
        if (!control) {
          throw new Error(`No IPC invoke control installed for ${targetChannel}`);
        }
        await Promise.all(control.handled);
      }, channel);
    },
    invokeTogether: async (requests) => {
      await electronApp.evaluate(
        async ({ ipcMain, BrowserWindow }, calls) => {
          type InvokeHandler = (...args: unknown[]) => unknown;
          const handlers = (
            ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
          )._invokeHandlers;
          const sender = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!sender) throw new Error("Expected a desktop window to send from");
          const resolved = calls.map((call) => {
            const handler = handlers?.get(call.channel);
            if (!handler) throw new Error(`No IPC handler registered for ${call.channel}`);
            return { handler, args: call.args };
          });
          const event = { sender };
          await Promise.all(resolved.map(({ handler, args }) => handler(event, ...args)));
        },
        requests.map((request) => ({ channel: request.channel, args: [...request.args] })),
      );
    },
  };
}

async function processGroupListing(groupId: number | undefined): Promise<string> {
  if (!groupId || process.platform === "win32") return "(not listed on this platform)";
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,pgid=,command="], {
      timeout: 5_000,
    });
    const rows = stdout.split("\n").filter((row) => row.trim().split(/\s+/)[1] === String(groupId));
    return rows.join("\n") || "(none)";
  } catch (error) {
    return `(ps failed: ${String(error)})`;
  }
}

async function focusElectronAppProcess(electronApp: ElectronApplication): Promise<void> {
  const pid = await electronApp.evaluate(() => process.pid);
  const electronAppBundle = resolve(electronExecutablePath, "..", "..");
  try {
    await execFileAsync("open", ["-a", electronAppBundle], { timeout: 5_000 });
  } catch {
    // The bundle activate path is best-effort; continue with AppleScript/Electron focus.
  }
  try {
    await execFileAsync("osascript", ["-e", 'tell application "Electron" to activate'], {
      timeout: 5_000,
    });
  } catch {
    // Fall through to System Events when the Electron app name is unavailable.
  }
  try {
    await execFileAsync(
      "osascript",
      [
        "-e",
        `tell application "System Events"
          set targetProcess to first application process whose unix id is ${pid}
          set frontmost of targetProcess to true
          return name of targetProcess
        end tell`,
      ],
      { timeout: 2_000 },
    );
  } catch {
    // Fall back to Electron/Playwright focus APIs when System Events access is unavailable.
  }
}
