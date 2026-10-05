import type { BrowserContext, Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type { DesktopAppState } from "../../contracts/desktop-state";
import type { PiDriverMethod } from "../../pi-host/protocol";

/**
 * What desktop specs use to drive the app beyond its pages. Specs never reach into the app's
 * process (Electron modules, `ipcMain`, test-hook globals) themselves, so the same specs can
 * run against any app that implements this: today the Electron app, later the Rust test host
 * and the Tauri app. Pick one with `PI_APP_TEST_TARGET`; the default is `electron`.
 *
 * A method that takes `window?: Page` acts on that window, or on the app's first window when
 * it is left out.
 */
export interface DesktopHarness {
  readonly target: DesktopTestTarget;
  /** The first app window, once its `piApp` bridge is ready. */
  firstWindow(): Promise<Page>;
  /** Brings the first window to the front and waits until it has focus. */
  focusWindow(): Promise<void>;
  /** Quits the app and waits for it to exit, failing if it hangs. */
  close(): Promise<void>;
  /** The browser context of the app's pages, for tracing. */
  context(): BrowserContext;
  readonly app: DesktopAppControl;
  readonly windows: DesktopWindowControl;
  readonly keyboard: DesktopKeyboard;
  readonly clipboard: DesktopClipboard;
  readonly externalUrls: DesktopExternalUrls;
  readonly dialogs: DesktopDialogs;
  readonly menu: DesktopMenu;
  readonly hooks: DesktopTestHooks;
  readonly driver: PiDriverControl;
  readonly ipc: DesktopIpcControl;
}

export type DesktopTestTarget = "electron" | "testhost";

export function desktopTestTarget(): DesktopTestTarget {
  const target = process.env.PI_APP_TEST_TARGET?.trim() || "electron";
  if (target !== "electron" && target !== "testhost") {
    throw new Error(`PI_APP_TEST_TARGET=${target} is not a desktop test target.`);
  }
  return target;
}

export interface DesktopAppControl {
  /** The app's main process id. */
  readonly pid: number | undefined;
  /** Resolves once the app's main process has exited. */
  waitForExit(): Promise<void>;
  hasExited(): boolean;
  /** Asks the app to quit, as Cmd-Q does, without waiting for it to exit. */
  quit(): Promise<void>;
  /** The OS asking the app to show itself again, as a Dock click does on macOS. */
  activate(): Promise<void>;
  /** A second launch of the app handing over to this one. */
  secondInstance(): Promise<void>;
  isReady(): Promise<boolean>;
  hasSingleInstanceLock(): Promise<boolean>;
  /** An environment variable as the app's main process sees it. */
  env(name: string): Promise<string | undefined>;
  /** The kind of process answering for the app, to prove main still runs. */
  mainProcessType(): Promise<string>;
  identity(): Promise<DesktopAppIdentity>;
  /** Decodes an image with the app's own decoder. */
  decodeImage(base64: string): Promise<{ empty: boolean; width: number; height: number }>;
}

export interface DesktopAppIdentity {
  readonly pid: number;
  readonly appPath: string;
  readonly userData: string;
  readonly visible: boolean | undefined;
  readonly focused: boolean | undefined;
  readonly testMode: string | null;
  readonly testHooks: boolean;
}

export interface DesktopWindowState {
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly visible: boolean;
  /** Lower-case `#rrggbb`. */
  readonly backgroundColor: string;
}

export interface DesktopWindowControl {
  /** Open windows as the app counts them. */
  count(): Promise<number>;
  /** Pages of the windows the harness has seen open and not yet closed. */
  pages(): Page[];
  /** The next window the app opens. */
  waitForNew(): Promise<Page>;
  /** `undefined` when there is no such window. */
  state(window?: Page): Promise<DesktopWindowState | undefined>;
  close(window?: Page): Promise<void>;
  show(window?: Page): Promise<void>;
  focus(window?: Page): Promise<void>;
  minimize(window?: Page): Promise<void>;
  /** Delivers the window's focus event without moving OS focus; `"all"` does every window. */
  emitFocus(window?: Page | "all"): Promise<void>;
  /** Returns false when there is no such window. */
  setSize(size: WindowSize, window?: Page): Promise<boolean>;
  setContentSize(size: WindowSize, window?: Page): Promise<void>;
  setBounds(bounds: WindowSize & { readonly x: number; readonly y: number }): Promise<void>;
  crashRenderer(window?: Page): Promise<void>;
}

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

export type NativeKeyModifier =
  | "shift"
  | "control"
  | "alt"
  | "meta"
  | "isAutoRepeat"
  | "isKeypad"
  | "capsLock"
  | "numLock"
  | "left"
  | "right";

export interface NativeKeyEvent {
  readonly type?: "keyDown" | "keyUp";
  readonly keyCode: string;
  readonly modifiers?: readonly NativeKeyModifier[];
}

export interface DesktopKeyboard {
  /**
   * A key event delivered by the OS to the window, so the app's own shortcut handling sees it
   * before the page does (unlike `page.keyboard`, which only reaches the page).
   */
  send(event: NativeKeyEvent, window?: Page): Promise<void>;
}

export interface DesktopClipboard {
  writeText(text: string): Promise<void>;
  writeImage(pngBase64: string): Promise<void>;
}

export interface DesktopExternalUrls {
  /** Stops URLs leaving the app and returns a reader of those it tried to open since. */
  capture(): Promise<() => Promise<readonly string[]>>;
}

export interface OpenDialogResult {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export type TextPromptOutcome = { ok: true; value: string } | { ok: false; error: string };

export interface DesktopDialogs {
  /** Answers the next folder or file picker with `result` instead of showing it. */
  stubNextOpenDialog(result: OpenDialogResult): Promise<void>;
  /** Keeps the next picker open until `releaseHeldOpenDialog`, then answers with `filePaths`. */
  holdNextOpenDialog(filePaths: readonly string[]): Promise<void>;
  releaseHeldOpenDialog(): Promise<void>;
  /** Pickers shown since the last stub. */
  openDialogCount(): Promise<number>;
  /** Shows the app's text prompt (used by provider login) and returns its window. */
  beginTextPrompt(
    message: string,
    placeholder: string,
  ): Promise<{ readonly window: Page; outcome(): Promise<TextPromptOutcome> }>;
}

export interface ApplicationMenuItemInfo {
  readonly id: string;
  readonly label: string;
  readonly accelerator: string;
  readonly parentLabel: string | null;
}

export interface DesktopMenu {
  item(id: string): Promise<ApplicationMenuItemInfo | null>;
  /** Clicks a menu item for the focused window; false when it does not exist. */
  click(id: string): Promise<boolean>;
}

export interface RuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

export interface RuntimeToolTestResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Calls into the app's test mode that have no user-facing surface. */
export interface DesktopTestHooks {
  /** Delivers events as if pi had sent them, one after another. */
  emitSessionEvents(events: readonly SessionDriverEvent[]): Promise<void>;
  fireDueScheduledTasks(nowIso?: string): Promise<DesktopAppState>;
  runOrchestrationRuntimeTool(input: RuntimeToolTestInput): Promise<RuntimeToolTestResult>;
  runScheduledTaskRuntimeTool(input: RuntimeToolTestInput): Promise<RuntimeToolTestResult>;
  /** Runs the app's window-activation path, as a real focus event does. */
  handleWindowActivation(): Promise<void>;
  /** Overrides whether the app treats the selected thread as seen; `null` clears it. */
  setSessionVisibility(mode: "active" | "inactive" | null): Promise<void>;
  /** Holds thread-title generation until the test resolves or rejects it. */
  deferThreadTitles(): Promise<void>;
  hasDeferredThreadTitle(): Promise<boolean>;
  /** Throws "Deferred thread-title request is unavailable" when none is waiting. */
  resolveDeferredThreadTitle(title: string): Promise<void>;
  rejectDeferredThreadTitle(): Promise<void>;
  piHostPid(): Promise<number | undefined>;
}

/** Holds the app's calls to pi so a spec can answer them. */
export interface PiDriverControl {
  /** From now on, calls to `method` wait for the test instead of reaching pi. */
  intercept(method: PiDriverMethod): Promise<PiDriverInterception>;
}

export interface PiDriverInterception {
  /** The next call not yet handed out by this interception, in arrival order. */
  nextCall(options?: { readonly timeout?: number }): Promise<InterceptedDriverCall>;
  /** Every call held so far, answered or not. */
  calls(): Promise<readonly PiDriverCallRecord[]>;
  /** Lets later calls reach pi again; calls already held still wait for an answer. */
  restore(): Promise<void>;
}

export interface PiDriverCallRecord {
  readonly id: string;
  readonly method: PiDriverMethod;
  readonly args: readonly unknown[];
  readonly outcome: "pending" | "completed" | "failed";
}

export interface InterceptedDriverCall extends PiDriverCallRecord {
  complete(result?: unknown): Promise<void>;
  /** Rejects the call with an `Error` carrying `message`. */
  fail(message: string): Promise<void>;
}

/** The default error an IPC control rejects with; specs check it never reaches the page. */
export const HYDRATE_TEST_SENTINEL = "hydrate-test-sentinel-token=/private/secret-path";

/**
 * How the app answers a renderer request on one IPC channel:
 * - `passthrough` runs the real handler;
 * - `reject` throws the sentinel;
 * - `replace` returns `replacement`;
 * - `record` only counts and returns undefined;
 * - `hold` waits until `release`, then runs the real handler.
 */
export type IpcInvokeControlMode = "passthrough" | "reject" | "replace" | "record" | "hold";

export interface IpcInvokeControlOptions {
  readonly mode: IpcInvokeControlMode;
  readonly sentinel?: string;
  readonly replacement?: unknown;
  /** Waits this long before handling each request. */
  readonly delayMs?: number;
  /** Requests on channels sharing a queue name are handled one at a time, in arrival order. */
  readonly queue?: string;
}

export interface IpcInvokeControlSnapshot {
  readonly mode: IpcInvokeControlMode;
  readonly invokeCount: number;
  readonly rejectCount: number;
  readonly sentinel: string;
  /** Each request's arguments after the sender, in arrival order. */
  readonly args: readonly (readonly unknown[])[];
}

export interface DesktopIpcControl {
  /** Takes over a channel; calling it again changes the mode and options. */
  control(channel: string, options: IpcInvokeControlOptions): Promise<void>;
  update(
    channel: string,
    patch: { readonly mode?: IpcInvokeControlMode; readonly replacement?: unknown },
  ): Promise<void>;
  read(channel: string): Promise<IpcInvokeControlSnapshot>;
  /** Lets held requests on the channel run and stops holding new ones (back to passthrough). */
  release(channel: string): Promise<void>;
  /** Waits until every request the channel has taken so far has finished. */
  settled(channel: string): Promise<void>;
  /**
   * Sends requests from the first window as one batch, so the app receives them in the same
   * turn and in this order, and waits for all of them. Use only for orderings user input
   * cannot force.
   */
  invokeTogether(
    requests: readonly { readonly channel: string; readonly args: readonly unknown[] }[],
  ): Promise<void>;
}
