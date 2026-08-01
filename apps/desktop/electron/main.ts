import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from "electron";
import { isValidHttpBaseUrl } from "@pi-gui/pi-sdk-driver";
import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { augmentPosixPath } from "../scripts/augment-path.cjs";
import { DesktopAppStore, type DesktopAppViewState } from "./app-store";
import {
  createOrchestrationRuntimeExtension,
  createOrchestrationRuntimeTools,
  type OrchestrationRuntimeBridge,
} from "./orchestration-runtime";
import * as orchestrationTools from "./app-store-orchestration";
import { getChangedFiles, getFileDiff, stageFile } from "./app-store-diff";
import { listWorkspaceFiles, readWorkspaceFile } from "./app-store-files";
import { MAIN_DEV_RELOAD_MARKER } from "./dev-reload-main-probe";
import { NotificationManager } from "./notification-manager";
import {
  NotificationPermissionService,
} from "./notification-permission";
import { checkForUpdate, initUpdateChecker, openReleasesPage } from "./update-checker";
import { ThemeManager } from "./theme-manager";
import { TerminalService } from "./terminal-service";
import type { AppView, DesktopAppState, ThemeMode, ThemePresetId } from "../src/desktop-state";
import {
  desktopIpc,
  getDesktopCommandFromShortcut,
  type ChangedFilesResult,
  type CustomProviderConfig,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
} from "../src/ipc";
import { SUPPORTED_COMPOSER_IMAGE_TYPES } from "../src/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  ForkThreadInput,
  RemoveWorktreeInput,
  SendChildThreadFollowUpInput,
  SetChildSupervisionLoopInput,
  StartThreadInput,
  WorkspaceSessionTarget,
} from "../src/desktop-state";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { GenerateThreadTitleOptions } from "@pi-gui/pi-sdk-driver";
import type { SessionRef, WorkspaceRef } from "@pi-gui/session-driver";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const appTestMode = resolveAppTestMode(process.env.PI_APP_TEST_MODE);
const windowTestMode = appTestMode ?? "foreground";
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
let store: DesktopAppStore;
const themeManager = new ThemeManager();
let mainWindow: BrowserWindow | null = null;
let notificationManager: NotificationManager | undefined;
let notificationPermissionService: NotificationPermissionService | undefined;
let terminalService: TerminalService | undefined;
let integratedTerminalShell = "";

interface WindowViewState {
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly sidebarCollapsed: boolean;
}

interface OrchestrationRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

const appWindows = new Set<BrowserWindow>();
const windowViews = new Map<number, WindowViewState>();
const stopPublishingStateByWebContentsId = new Map<number, () => void>();
const stopPublishingSelectedTranscriptByWebContentsId = new Map<number, () => void>();
const stopTrackingWindowActivationByWebContentsId = new Map<number, () => void>();
let stopNotifications: (() => void) | undefined;
let stopUpdateChecker: (() => void) | undefined;
let stopPruningTerminals: (() => void) | undefined;
let retainedTerminalWorkspacePathSignature = "";
const terminalFocusedWebContentsIds = new Set<number>();
let quittingAfterStoreFlush = false;
let windowScopedActionQueue: Promise<void> = Promise.resolve();
let currentComposerDraftPersistOriginWebContentsId: number | undefined;
let currentWindowScopedWebContentsId: number | undefined;
let deferredActivationWebContentsId: number | undefined;

const SUPPORTED_IMAGE_TYPES = SUPPORTED_COMPOSER_IMAGE_TYPES;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(SUPPORTED_IMAGE_TYPES.map((type) => type.mimeType));
const NEW_WINDOW_MENU_ITEM_ID = "file.new-window";

function createStoreBackedOrchestrationRuntimeBridge(): OrchestrationRuntimeBridge {
  return {
    createChildThread: async (ctx, input) => {
      await store.initialize();
      return orchestrationTools.createChildThreadToolResult(store, sessionRefFromExtensionContext(ctx), input);
    },
    listThreads: async (ctx) => {
      await store.initialize();
      return orchestrationTools.listThreadsToolResult(store, sessionRefFromExtensionContext(ctx));
    },
    readThread: async (ctx, threadId) => {
      await store.initialize();
      return orchestrationTools.readThreadToolResult(store, sessionRefFromExtensionContext(ctx), threadId);
    },
    sendMessageToThread: async (ctx, input) => {
      await store.initialize();
      return orchestrationTools.sendMessageToThreadToolResult(store, sessionRefFromExtensionContext(ctx), input);
    },
  };
}

function sessionRefFromExtensionContext(ctx: ExtensionContext): SessionRef {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = path.resolve(ctx.sessionManager.getCwd?.() ?? ctx.cwd);
  const workspace = store.state.workspaces.find(
    (entry) => path.resolve(entry.path) === cwd && entry.sessions.some((session) => session.id === sessionId),
  );
  if (!workspace) {
    throw new Error(`Unable to resolve orchestration session for ${cwd}:${sessionId}`);
  }
  return {
    workspaceId: workspace.id,
    sessionId,
  };
}

async function runOrchestrationRuntimeToolForTest(
  bridge: OrchestrationRuntimeBridge,
  input: OrchestrationRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createOrchestrationRuntimeTools(bridge).find((entry) => entry.name === input.toolName);
  if (!tool) {
    throw new Error(`Unknown orchestration runtime tool: ${input.toolName}`);
  }
  return tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    createTestExtensionContext(input.sessionRef),
  );
}

function createTestExtensionContext(sessionRef: SessionRef): ExtensionContext {
  const workspace = store.state.workspaces.find(
    (entry) => entry.id === sessionRef.workspaceId && entry.sessions.some((session) => session.id === sessionRef.sessionId),
  );
  if (!workspace) {
    throw new Error(`Unknown test session: ${sessionRef.workspaceId}:${sessionRef.sessionId}`);
  }

  return {
    hasUI: false,
    mode: "json",
    cwd: workspace.path,
    sessionManager: {
      getSessionId: () => sessionRef.sessionId,
      getCwd: () => workspace.path,
    } as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  };
}
const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";
const CHECK_FOR_UPDATES_MENU_ITEM_ID = "app.check-for-updates";
const QUIT_FLUSH_TIMEOUT_MS = 5_000;
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_DIMENSION = 8_192;

function getTerminalService(): TerminalService {
  if (!terminalService) {
    terminalService = new TerminalService({
      getWorkspacePath: (workspaceId) => store.getWorkspacePath(workspaceId),
      getIntegratedTerminalShell: () => integratedTerminalShell,
      isPackaged: app.isPackaged,
    });
  }
  return terminalService;
}

// Resolve the bundled application icon. In dev the repo's `resources/icon.png`
// sits two levels up from the compiled `out/main/main.js`; in a packaged build
// it is copied to `process.resourcesPath` via `extraResources` in
// electron-builder.yml. On macOS packaged builds the window/dock icon already
// comes from `icon.icns` in the app bundle, so we only need the PNG for dev
// and for Linux/Windows window chrome.
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(__dirname, "..", "..", "resources", "icon.png");
const appIcon = nativeImage.createFromPath(appIconPath);

function parseExternalWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function appRendererUrl(): string {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }
  const indexPath = path.join(__dirname, "..", "renderer", "index.html");
  return pathToFileURL(indexPath).toString();
}

function isInAppNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const appUrl = new URL(appRendererUrl());
    return parsed.href === appUrl.href || (isDev && parsed.origin === appUrl.origin);
  } catch {
    return false;
  }
}

function openExternalWebUrl(url: string): boolean {
  const parsed = parseExternalWebUrl(url);
  if (!parsed) {
    return false;
  }
  void shell.openExternal(parsed.toString()).catch((error) => {
    console.error(`Failed to open external URL: ${parsed.toString()}`, error);
  });
  return true;
}

function readClipboardImageAttachment(): ComposerImageAttachment | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }

  const size = image.getSize();
  if (size.width > MAX_CLIPBOARD_IMAGE_DIMENSION || size.height > MAX_CLIPBOARD_IMAGE_DIMENSION) {
    return null;
  }

  const png = image.toPNG();
  if (png.length === 0 || png.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    return null;
  }

  return {
    id: randomUUID(),
    kind: "image",
    name: "pasted-image.png",
    mimeType: "image/png",
    data: png.toString("base64"),
  };
}

function createWindow(): BrowserWindow {
  const backgroundTestMode = windowTestMode === "background";
  const enableTransparency = store ? store.state.enableTransparency : false;
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 560,
    minHeight: 600,
    transparent: enableTransparency,
    vibrancy: process.platform === "darwin" && enableTransparency ? "under-window" : undefined,
    titleBarStyle: "hiddenInset",
    backgroundColor: enableTransparency ? "#00000000" : "#f3f4f8",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep hidden test windows responsive so Playwright exercises the same UI flows.
      backgroundThrottling: !backgroundTestMode,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInAppNavigationUrl(url)) {
      openExternalWebUrl(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isInAppNavigationUrl(url)) {
      return;
    }
    event.preventDefault();
    openExternalWebUrl(url);
  });

  window.once("ready-to-show", () => {
    if (!backgroundTestMode) {
      window.show();
    }
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    const lowerKey = input.key.toLowerCase();
    const platformModifier = process.platform === "darwin" ? input.meta : input.control;
    const terminalFocused = terminalFocusedWebContentsIds.has(window.webContents.id);
    if (terminalFocused) {
      return;
    }
    if (platformModifier && !input.shift && lowerKey === "n") {
      event.preventDefault();
      createAppWindow(viewForWebContents(window.webContents.id));
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "o") {
      event.preventDefault();
      void pickWorkspaceViaDialog(window);
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "v") {
      const clipboardImage = readClipboardImageAttachment();
      if (clipboardImage) {
        event.preventDefault();
        window.webContents.send(desktopIpc.clipboardImagePasted, clipboardImage);
        return;
      }
    }

    const command = getDesktopCommandFromShortcut({
      modifier: process.platform === "darwin" ? input.meta : input.control,
      shift: input.shift,
      key: input.key,
      code: input.code,
    });
    if (command) {
      event.preventDefault();
      window.webContents.send(desktopIpc.appCommand, command);
    }
  });

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string);
    if (process.env.PI_APP_OPEN_DEVTOOLS !== "0") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void window.loadURL(appRendererUrl());
  }

  return window;
}

function viewFromState(state: DesktopAppState): WindowViewState {
  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    activeView: state.activeView,
    sidebarCollapsed: state.sidebarCollapsed,
  };
}

function resolveWindowView(sourceView?: DesktopAppViewState): WindowViewState {
  return viewFromState(store.projectStateForView({ ...viewFromState(store.state), ...sourceView }, store.state));
}

function viewForWebContents(webContentsId: number): WindowViewState {
  return windowViews.get(webContentsId) ?? viewFromState(store.state);
}

function rememberWindowView(webContentsId: number, state: DesktopAppState): void {
  windowViews.set(webContentsId, viewFromState(state));
}

function applyWindowViewToStore(webContentsId: number): void {
  store.state = store.projectStateForView(viewForWebContents(webContentsId), store.state);
}

function projectStateForWindow(
  webContentsId: number,
  state: DesktopAppState = store.state,
  view: WindowViewState = viewForWebContents(webContentsId),
  previousView: WindowViewState | undefined = windowViews.get(webContentsId),
): DesktopAppState {
  const projected = store.projectStateForView(view, state, previousView);
  if (
    projected.composerDraftSyncSource === "persist" &&
    currentComposerDraftPersistOriginWebContentsId !== undefined &&
    webContentsId !== currentComposerDraftPersistOriginWebContentsId
  ) {
    return {
      ...projected,
      composerDraftSyncSource: "remote-persist",
    };
  }
  return projected;
}

function publishStateToWindow(window: BrowserWindow, state: DesktopAppState = store.state): void {
  if (!canPublishToWindow(window)) {
    return;
  }
  const webContentsId = window.webContents.id;
  const view = webContentsId === currentWindowScopedWebContentsId ? viewFromState(state) : viewForWebContents(webContentsId);
  const projected = projectStateForWindow(webContentsId, state, view);
  rememberWindowView(webContentsId, projected);
  window.webContents.send(desktopIpc.stateChanged, projected);
}

// Transcript arrays in the store follow an immutable-write discipline (every
// mutation path copies the array before writing), so array identity is an exact
// change detector. Remember what each window last received and skip the send —
// and its full-payload serialization — when nothing it displays has changed
// (e.g. events from other sessions ticking the store).
interface PublishedTranscriptFingerprint {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly transcript: unknown;
  readonly schemaInfo: unknown;
}
const lastPublishedTranscriptByWebContentsId = new Map<number, PublishedTranscriptFingerprint | null>();

async function publishSelectedTranscriptToWindow(window: BrowserWindow): Promise<void> {
  if (!canPublishToWindow(window)) {
    return;
  }
  const webContentsId = window.webContents.id;
  const payload = await store.getSelectedTranscriptForView(viewForWebContents(webContentsId));
  if (canPublishToWindow(window)) {
    const projected = projectStateForWindow(webContentsId);
    if (payload) {
      if (projected.selectedWorkspaceId !== payload.workspaceId || projected.selectedSessionId !== payload.sessionId) {
        return;
      }
    } else if (projected.selectedSessionId) {
      return;
    }
    const previous = lastPublishedTranscriptByWebContentsId.get(webContentsId);
    if (payload) {
      if (
        previous &&
        previous.workspaceId === payload.workspaceId &&
        previous.sessionId === payload.sessionId &&
        previous.transcript === payload.transcript &&
        previous.schemaInfo === payload.schemaInfo
      ) {
        return;
      }
      lastPublishedTranscriptByWebContentsId.set(webContentsId, {
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        transcript: payload.transcript,
        schemaInfo: payload.schemaInfo,
      });
    } else {
      if (previous === null) {
        return;
      }
      lastPublishedTranscriptByWebContentsId.set(webContentsId, null);
    }
    window.webContents.send(desktopIpc.selectedTranscriptChanged, payload);
  }
}

function setActiveWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  mainWindow = window;
  notificationManager?.trackWindow(window);
  notificationPermissionService?.trackWindow(window);
}

function windowForWebContentsId(webContentsId: number): BrowserWindow | undefined {
  return [...appWindows].find((window) => !window.isDestroyed() && window.webContents.id === webContentsId);
}

function applyWindowActivation(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  setActiveWindow(window);
  applyWindowViewToStore(webContentsId);
  store.handleWindowActivation();
  rememberWindowView(webContentsId, store.state);
}

function applyDeferredWindowActivation(): boolean {
  const webContentsId = deferredActivationWebContentsId;
  deferredActivationWebContentsId = undefined;
  if (webContentsId === undefined) {
    return false;
  }
  const window = windowForWebContentsId(webContentsId);
  if (!window || !canPublishToWindow(window)) {
    return false;
  }
  applyWindowActivation(window);
  return true;
}

function getForegroundAppWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && windowViews.has(focusedWindow.webContents.id) && canPublishToWindow(focusedWindow)) {
    return focusedWindow;
  }
  if (mainWindow && canPublishToWindow(mainWindow)) {
    return mainWindow;
  }
  return [...appWindows].find((window) => canPublishToWindow(window)) ?? null;
}

function getForegroundAppView(): DesktopAppViewState | undefined {
  const window = getForegroundAppWindow();
  return window ? viewForWebContents(window.webContents.id) : undefined;
}

function restoreStoreToView(view: DesktopAppViewState | undefined): void {
  if (!view) {
    return;
  }
  store.state = store.projectStateForView(view, store.state);
}

function restoreStoreToViewAndEmit(view: DesktopAppViewState | undefined): void {
  restoreStoreToView(view);
  store.emit();
}

function restoreStoreToForegroundUnlessSender(senderWebContentsId: number | undefined): void {
  const foregroundWindow = getForegroundAppWindow();
  if (!foregroundWindow) {
    return;
  }
  if (senderWebContentsId !== undefined && foregroundWindow.webContents.id === senderWebContentsId) {
    return;
  }
  restoreStoreToViewAndEmit(viewForWebContents(foregroundWindow.webContents.id));
}

function isSessionVisibleInAnotherWindow(sessionRef: SessionRef): boolean {
  for (const window of appWindows) {
    if (!canPublishToWindow(window) || window.isMinimized() || !window.isVisible()) {
      continue;
    }
    const webContentsId = window.webContents.id;
    if (webContentsId === currentWindowScopedWebContentsId) {
      continue;
    }
    const view = windowViews.get(webContentsId);
    if (
      view?.activeView === "threads" &&
      view.selectedWorkspaceId === sessionRef.workspaceId &&
      view.selectedSessionId === sessionRef.sessionId
    ) {
      return true;
    }
  }
  return false;
}

function enqueueWindowScopedAction<T>(action: () => Promise<T>): Promise<T> {
  const run = windowScopedActionQueue.then(action, action);
  windowScopedActionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface WindowScopedActionOptions {
  readonly forceActiveWindow?: boolean;
}

async function runWindowScopedForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
  options: WindowScopedActionOptions = {},
): Promise<DesktopAppState> {
  return enqueueWindowScopedAction(async () => {
    const webContentsId = window && !window.isDestroyed() ? window.webContents.id : undefined;
    const foregroundWindow = getForegroundAppWindow();
    const senderIsForeground =
      Boolean(window && foregroundWindow && window.webContents.id === foregroundWindow.webContents.id);
    const windowIsFocused =
      Boolean(window && !window.isDestroyed() && window.isFocused()) ||
      senderIsForeground ||
      options.forceActiveWindow === true;
    if (window && webContentsId !== undefined) {
      if (windowIsFocused) {
        setActiveWindow(window);
      }
      applyWindowViewToStore(webContentsId);
    }

    const previousWindowScopedWebContentsId = currentWindowScopedWebContentsId;
    currentWindowScopedWebContentsId = webContentsId;
    try {
      const state = await action();
      if (!window || webContentsId === undefined) {
        return state;
      }

      const previousView = windowViews.get(webContentsId);
      const projected = projectStateForWindow(webContentsId, state, viewFromState(state), previousView);
      rememberWindowView(webContentsId, projected);
      publishStateToWindow(window, projected);
      void publishSelectedTranscriptToWindow(window);
      return projected;
    } finally {
      currentWindowScopedWebContentsId = previousWindowScopedWebContentsId;
      if (!applyDeferredWindowActivation()) {
        restoreStoreToForegroundUnlessSender(webContentsId);
      }
    }
  });
}

function runWindowScopedForEvent(
  event: IpcMainInvokeEvent,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return runWindowScopedForWindow(BrowserWindow.fromWebContents(event.sender), action);
}

async function runUnscopedStateResultForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  const state = await action();
  if (!window || !canPublishToWindow(window)) {
    return state;
  }
  const webContentsId = window.webContents.id;
  const projected = projectStateForWindow(webContentsId, state);
  rememberWindowView(webContentsId, projected);
  return projected;
}

async function runImmediateStateResultForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  const state = await action();
  if (!window || !canPublishToWindow(window)) {
    return state;
  }

  const webContentsId = window.webContents.id;
  const projected = projectStateForWindow(webContentsId, state);
  rememberWindowView(webContentsId, projected);
  window.webContents.send(desktopIpc.stateChanged, projected);
  void publishSelectedTranscriptToWindow(window);
  return projected;
}

async function runWindowScopedStateResult<T extends { readonly state: DesktopAppState }>(
  window: BrowserWindow | null | undefined,
  action: () => Promise<T>,
  options: WindowScopedActionOptions = {},
): Promise<T> {
  return enqueueWindowScopedAction(async () => {
    const webContentsId = window && !window.isDestroyed() ? window.webContents.id : undefined;
    const foregroundWindow = getForegroundAppWindow();
    const senderIsForeground =
      Boolean(window && foregroundWindow && window.webContents.id === foregroundWindow.webContents.id);
    const windowIsFocused =
      Boolean(window && !window.isDestroyed() && window.isFocused()) ||
      senderIsForeground ||
      options.forceActiveWindow === true;
    if (window && webContentsId !== undefined) {
      if (windowIsFocused) {
        setActiveWindow(window);
      }
      applyWindowViewToStore(webContentsId);
    }

    const previousWindowScopedWebContentsId = currentWindowScopedWebContentsId;
    currentWindowScopedWebContentsId = webContentsId;
    try {
      const result = await action();
      if (!window || webContentsId === undefined) {
        return result;
      }

      const previousView = windowViews.get(webContentsId);
      const projected = projectStateForWindow(webContentsId, result.state, viewFromState(result.state), previousView);
      rememberWindowView(webContentsId, projected);
      publishStateToWindow(window, projected);
      void publishSelectedTranscriptToWindow(window);
      return { ...result, state: projected };
    } finally {
      currentWindowScopedWebContentsId = previousWindowScopedWebContentsId;
      if (!applyDeferredWindowActivation()) {
        restoreStoreToForegroundUnlessSender(webContentsId);
      }
    }
  });
}

function createAppWindow(sourceView?: DesktopAppViewState): BrowserWindow {
  const window = createWindow();
  const webContentsId = window.webContents.id;
  appWindows.add(window);
  windowViews.set(webContentsId, resolveWindowView(sourceView));
  setActiveWindow(window);
  themeManager.trackWindow(window);
  attachStatePublisher(window);
  attachViewedSessionTracking(window);

  window.once("closed", () => {
    appWindows.delete(window);
    windowViews.delete(webContentsId);
    lastPublishedTranscriptByWebContentsId.delete(webContentsId);
    terminalFocusedWebContentsIds.delete(webContentsId);
    terminalService?.disposeWebContents(webContentsId);
    void store.cancelPendingDialogsWithoutVisibleWindow((sessionRef) => isSessionVisibleInAnotherWindow(sessionRef));
    if (mainWindow === window) {
      mainWindow = [...appWindows].find((candidate) => !candidate.isDestroyed()) ?? null;
      if (mainWindow) {
        setActiveWindow(mainWindow);
        applyWindowViewToStore(mainWindow.webContents.id);
      }
    }
    if (appWindows.size === 0) {
      terminalService?.dispose();
      terminalService = undefined;
    }
  });

  return window;
}

// Store updates arrive per agent event — during streaming that is tens of times
// per second, and each publish serializes the full app state plus the full
// selected transcript over IPC. On long threads that firehose saturates the
// renderer (deserialize + rebuild + render per token batch) and can OOM it.
// Coalesce bursts to a trailing-edge cadence; the final flush always runs, so
// the window never misses the settled state. Direct publishes on user-initiated
// IPC requests are untouched and stay immediate.
const PUBLISH_COALESCE_MS = 200;

function throttleTrailing(fn: () => void, intervalMs: number): { run: () => void; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let lastRun = 0;
  return {
    run: () => {
      if (timer) {
        return;
      }
      const wait = Math.max(0, intervalMs - (Date.now() - lastRun));
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        fn();
      }, wait);
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function attachStatePublisher(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  const startPublishing = () => {
    stopPublishingStateByWebContentsId.get(webContentsId)?.();
    stopPublishingSelectedTranscriptByWebContentsId.get(webContentsId)?.();
    const publishLatest = throttleTrailing(() => {
      publishStateToWindow(window);
      void publishSelectedTranscriptToWindow(window);
    }, PUBLISH_COALESCE_MS);
    const stopPublishingStateSubscription = store.subscribe(() => {
      publishLatest.run();
    });
    const stopPublishingState = () => {
      publishLatest.cancel();
      stopPublishingStateSubscription();
    };
    const stopPublishingSelectedTranscript = store.subscribeToSelectedTranscript(() => {
      publishLatest.run();
    });
    stopPublishingStateByWebContentsId.set(webContentsId, stopPublishingState);
    stopPublishingSelectedTranscriptByWebContentsId.set(webContentsId, stopPublishingSelectedTranscript);
  };
  const stopPublishing = () => {
    stopPublishingStateByWebContentsId.get(webContentsId)?.();
    stopPublishingStateByWebContentsId.delete(webContentsId);
    stopPublishingSelectedTranscriptByWebContentsId.get(webContentsId)?.();
    stopPublishingSelectedTranscriptByWebContentsId.delete(webContentsId);
  };

  startPublishing();

  // A renderer crash detaches the (now-dead) subscriptions, but View > Reload
  // brings the same webContents back — re-subscribe on recovery so the reloaded
  // window resumes live state pushes instead of going permanently stale.
  let recovering = false;
  window.webContents.on("render-process-gone", () => {
    recovering = true;
    stopPublishing();
  });
  window.webContents.on("did-finish-load", () => {
    if (!recovering) {
      return;
    }
    recovering = false;
    startPublishing();
    // Push the current state immediately so the reloaded UI is fresh.
    publishStateToWindow(window);
    void publishSelectedTranscriptToWindow(window);
  });
  window.once("closed", stopPublishing);
}

function attachViewedSessionTracking(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  stopTrackingWindowActivationByWebContentsId.get(webContentsId)?.();

  const handleActivation = () => {
    if (currentWindowScopedWebContentsId !== undefined) {
      deferredActivationWebContentsId = webContentsId;
      return;
    }
    applyWindowActivation(window);
  };
  const clearTracking = () => {
    stopTrackingWindowActivationByWebContentsId.get(webContentsId)?.();
    stopTrackingWindowActivationByWebContentsId.delete(webContentsId);
  };

  window.on("focus", handleActivation);
  window.on("show", handleActivation);
  window.on("restore", handleActivation);
  window.once("closed", clearTracking);

  stopTrackingWindowActivationByWebContentsId.set(webContentsId, () => {
    window.off("focus", handleActivation);
    window.off("show", handleActivation);
    window.off("restore", handleActivation);
    window.off("closed", clearTracking);
  });
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed();
}

function resolveAppTestMode(value: string | undefined): "foreground" | "background" | undefined {
  return value === "foreground" || value === "background" ? value : undefined;
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  if (parentWindow && canPublishToWindow(parentWindow)) {
    return parentWindow;
  }
  if (mainWindow && canPublishToWindow(mainWindow)) {
    return mainWindow;
  }
  return undefined;
}

async function stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
  if (window && canPublishToWindow(window)) {
    return store.getStateForView(viewForWebContents(window.webContents.id));
  }
  return store.getState();
}

async function pickWorkspacePathViaDialog(parentWindow?: BrowserWindow | null): Promise<string | undefined> {
  const window = resolveDialogWindow(parentWindow);
  const result = window
    ? await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: "Open workspace folder",
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Open workspace folder",
      });
  if (result.canceled || result.filePaths.length === 0) {
    return undefined;
  }
  return result.filePaths[0] as string;
}

async function addPickedWorkspace(window: BrowserWindow | null | undefined, workspacePath: string): Promise<DesktopAppState> {
  const nextState = await store.addWorkspace(workspacePath);
  if (!nextState.selectedWorkspaceId) {
    return nextState;
  }
  const newThreadState =
    nextState.activeView === "new-thread" ? nextState : await store.setActiveView("new-thread");
  if (window) {
    window.webContents.send(desktopIpc.workspacePicked, nextState.selectedWorkspaceId);
  }
  return newThreadState;
}

async function pickWorkspaceViaDialog(parentWindow?: BrowserWindow | null): Promise<DesktopAppState> {
  const window = resolveDialogWindow(parentWindow);
  const workspacePath = await pickWorkspacePathViaDialog(window);
  if (!workspacePath) {
    return stateForWindow(window);
  }
  return runWindowScopedForWindow(window, () => addPickedWorkspace(window, workspacePath));
}

async function runManualUpdateCheck(): Promise<void> {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
  const showDialog = (options: MessageBoxOptions) =>
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

  try {
    const result = await checkForUpdate();

    if (result.status === "update-available") {
      // The manual menu path always confirms with a dialog — a notification may
      // be silently suppressed if the OS permission is denied.
      const choice = await showDialog({
        type: "info",
        title: "pi-gui",
        message: `Version ${result.latestVersion} is available.`,
        detail: `You have ${result.currentVersion}.`,
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        await openReleasesPage(result.releaseUrl);
      }
      return;
    }

    if (result.status === "up-to-date") {
      await showDialog({
        type: "info",
        title: "pi-gui",
        message: `You're up to date on version ${result.currentVersion}.`,
        buttons: ["OK"],
      });
      return;
    }

    await showDialog({
      type: "warning",
      title: "pi-gui",
      message: "Could not check for updates right now.",
      detail: result.message,
      buttons: ["OK"],
    });
  } catch (error) {
    console.error("pi-gui: manual update check failed:", error);
    await showDialog({
      type: "warning",
      title: "pi-gui",
      message: "Could not check for updates right now.",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["OK"],
    }).catch(() => undefined);
  }
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          id: CHECK_FOR_UPDATES_MENU_ITEM_ID,
          label: "Check for Updates…",
          click: () => {
            void runManualUpdateCheck();
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          id: NEW_WINDOW_MENU_ITEM_ID,
          label: "New Window",
          accelerator: "CommandOrControl+N",
          click: () => {
            createAppWindow(getForegroundAppView());
          },
        },
        { type: "separator" },
        {
          id: OPEN_FOLDER_MENU_ITEM_ID,
          label: "Open Folder…",
          accelerator: "Command+O",
          click: () => {
            void pickWorkspaceViaDialog(mainWindow);
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Ensure npm (and other Homebrew/npm-global binaries) are available even when
// pi-gui is launched via Finder/Dock (which hands the process a minimal PATH).
// POSIX-only; on Windows the PATH is left untouched (see augmentPosixPath).
const augmentedPath = augmentPosixPath();
if (augmentedPath.changed) {
  process.env.PATH = augmentedPath.path;
}

app.setName("pi");

const configuredUserDataDir = process.env.PI_APP_USER_DATA_DIR?.trim() || app.getPath("userData");
app.setPath("userData", configuredUserDataDir);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  const window = getForegroundAppWindow();
  if (!window) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  // On macOS, packaged builds already render the dock icon from `icon.icns`
  // in the app bundle. In dev we override the generic Electron dock icon with
  // the real PNG so the running app looks right end-to-end.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(appIcon);
  }

  let generateThreadTitleOverride:
    | ((workspace: WorkspaceRef, options: GenerateThreadTitleOptions) => Promise<string | null | undefined>)
    | undefined;
  let deferredThreadTitle:
    | {
        resolve: (title: string | null) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const orchestrationRuntimeBridge = createStoreBackedOrchestrationRuntimeBridge();
  const driverOptions = {
    extensionFactories: [createOrchestrationRuntimeExtension(orchestrationRuntimeBridge)],
    inlineExtensionMetadata: [
      {
        displayName: "Thread orchestration",
        description: "Start child pi-gui threads from transcript tool calls",
      },
    ],
  };
  store = new DesktopAppStore({
    userDataDir: configuredUserDataDir,
    initialWorkspacePaths: resolveInitialWorkspacePaths(),
    getWindow: () => mainWindow,
    shouldKeepSessionDialogs: (sessionRef) => isSessionVisibleInAnotherWindow(sessionRef),
    driverOptions,
    generateThreadTitleOverride: async (workspace, options) => generateThreadTitleOverride?.(workspace, options),
  });
  await store.initialize();
  themeManager.setMode(store.state.themeMode);
  integratedTerminalShell = (await store.getState()).integratedTerminalShell;
  stopPruningTerminals = store.subscribe((state) => {
    integratedTerminalShell = state.integratedTerminalShell;
    const workspacePaths = state.workspaces.map((workspace) => workspace.path);
    const workspacePathSignature = workspacePaths.join("\0");
    if (workspacePathSignature !== retainedTerminalWorkspacePathSignature) {
      retainedTerminalWorkspacePathSignature = workspacePathSignature;
      terminalService?.retainWorkspacePaths(workspacePaths);
    }
  });
  installApplicationMenu();
  if (process.env.PI_APP_TEST_MODE) {
    Object.assign(globalThis, {
      __PI_APP_TEST_HOOKS: {
        emitSessionEvent: (event: SessionDriverEvent) => store.emitTestSessionEvent(event),
        handleWindowActivation: () => {
          if (mainWindow) {
            applyWindowActivation(mainWindow);
          }
        },
        promptForText: (message: string, placeholder?: string, allowEmpty?: boolean) =>
          promptForText(mainWindow, message, placeholder ?? "", allowEmpty ?? false),
        runOrchestrationRuntimeTool: (input: OrchestrationRuntimeToolTestInput) =>
          runOrchestrationRuntimeToolForTest(orchestrationRuntimeBridge, input),
        setDeferredThreadTitleMode: () => {
          generateThreadTitleOverride = () =>
            new Promise<string | null>((resolve, reject) => {
              deferredThreadTitle = { resolve, reject };
            });
        },
        hasDeferredThreadTitle: () => Boolean(deferredThreadTitle),
        resolveDeferredThreadTitle: (title: string) => {
          if (!deferredThreadTitle) {
            throw new Error("Deferred thread-title request is unavailable");
          }
          const pending = deferredThreadTitle;
          deferredThreadTitle = undefined;
          pending.resolve(title);
        },
        rejectDeferredThreadTitle: () => {
          if (!deferredThreadTitle) {
            throw new Error("Deferred thread-title request is unavailable");
          }
          const pending = deferredThreadTitle;
          deferredThreadTitle = undefined;
          pending.reject(new Error("Deferred thread-title rejected by test"));
        },
      },
    });
  }
  notificationPermissionService = new NotificationPermissionService(() => mainWindow);
  notificationPermissionService.subscribe((status) => {
    for (const window of appWindows) {
      if (canPublishToWindow(window)) {
        window.webContents.send(desktopIpc.notificationPermissionStatusChanged, status);
      }
    }
  });
  notificationManager = new NotificationManager(
    store,
    () => mainWindow,
    notificationPermissionService,
    async (sessionRef) => {
      const window = getForegroundAppWindow();
      await runWindowScopedForWindow(window, () => store.selectSession(sessionRef), { forceActiveWindow: true });
    },
  );
  stopNotifications = notificationManager.start();
  if (!isDev) {
    stopUpdateChecker = initUpdateChecker();
  }

  ipcMain.handle(desktopIpc.ping, () =>
    devReloadMarkersEnabled ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}` : "pi desktop ready",
  );
  ipcMain.handle(desktopIpc.getThemeMode, () => themeManager.getMode());
  ipcMain.handle(desktopIpc.getResolvedTheme, () => themeManager.getResolvedTheme());
  ipcMain.handle(desktopIpc.setThemeMode, (event, mode: ThemeMode) => {
    themeManager.setMode(mode);
    return runWindowScopedForEvent(event, () => store.setThemeMode(mode));
  });
  ipcMain.handle(desktopIpc.setThemePresetId, (event, presetId: ThemePresetId) =>
    runWindowScopedForEvent(event, () => store.setThemePresetId(presetId)),
  );
  ipcMain.handle(desktopIpc.openExternal, (_event, url: string) => {
    const parsed = parseExternalWebUrl(url);
    if (!parsed) {
      throw new Error(`Refusing to open unsupported URL: ${url}`);
    }
    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle(desktopIpc.stateRequest, (event) => store.getStateForView(viewForWebContents(event.sender.id)));
  ipcMain.handle(desktopIpc.selectedTranscriptRequest, (event) =>
    store.getSelectedTranscriptForView(viewForWebContents(event.sender.id)),
  );
  ipcMain.handle(desktopIpc.addWorkspacePath, (event, workspacePath: string) =>
    runWindowScopedForEvent(event, () => store.addWorkspace(workspacePath)),
  );
  ipcMain.handle(desktopIpc.pickWorkspace, (event) =>
    pickWorkspaceViaDialog(BrowserWindow.fromWebContents(event.sender)),
  );
  ipcMain.handle(desktopIpc.selectWorkspace, (event, workspaceId: string) =>
    runWindowScopedForEvent(event, () => store.selectWorkspace(workspaceId)),
  );
  ipcMain.handle(desktopIpc.renameWorkspace, (event, workspaceId: string, displayName: string) =>
    runWindowScopedForEvent(event, () => store.renameWorkspace(workspaceId, displayName)),
  );
  ipcMain.handle(desktopIpc.removeWorkspace, (event, workspaceId: string) =>
    runWindowScopedForEvent(event, () => store.removeWorkspace(workspaceId)),
  );
  ipcMain.handle(desktopIpc.reorderWorkspaces, (event, order: readonly string[]) =>
    runWindowScopedForEvent(event, () => store.reorderWorkspaces(order)),
  );
  ipcMain.handle(desktopIpc.reorderPinnedSessions, (event, order: readonly string[]) =>
    runWindowScopedForEvent(event, () => store.reorderPinnedSessions(order)),
  );
  ipcMain.handle(desktopIpc.openWorkspaceInFinder, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await shell.openPath(workspacePath);
  });
  ipcMain.handle(desktopIpc.createWorktree, (event, input: CreateWorktreeInput) =>
    runWindowScopedForEvent(event, () => store.createWorktree(input)),
  );
  ipcMain.handle(desktopIpc.removeWorktree, (event, input: RemoveWorktreeInput) =>
    runWindowScopedForEvent(event, () => store.removeWorktree(input)),
  );
  ipcMain.handle(desktopIpc.syncCurrentWorkspace, (event) =>
    runWindowScopedForEvent(event, () => store.syncCurrentWorkspace()),
  );
  ipcMain.handle(desktopIpc.selectSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.selectSession(target)),
  );
  ipcMain.handle(desktopIpc.renameSession, (event, target: WorkspaceSessionTarget, title: string) =>
    runWindowScopedForEvent(event, () => store.renameSession(target, title)),
  );
  ipcMain.handle(desktopIpc.archiveSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.archiveSession(target)),
  );
  ipcMain.handle(desktopIpc.unarchiveSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.unarchiveSession(target)),
  );
  ipcMain.handle(desktopIpc.markSessionRead, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.markSessionRead(target)),
  );
  ipcMain.handle(desktopIpc.setSessionPinned, (event, target: WorkspaceSessionTarget, pinned: boolean) =>
    runWindowScopedForEvent(event, () => store.setSessionPinned(target, pinned)),
  );
  ipcMain.handle(desktopIpc.setActiveView, (event, activeView) =>
    runWindowScopedForEvent(event, () => store.setActiveView(activeView)),
  );
  ipcMain.handle(desktopIpc.setSidebarCollapsed, (event, collapsed: boolean) =>
    runWindowScopedForEvent(event, () => store.setSidebarCollapsed(collapsed)),
  );
  ipcMain.handle(desktopIpc.refreshRuntime, (event, workspaceId?: string) =>
    runWindowScopedForEvent(event, () => store.refreshRuntime(workspaceId)),
  );
  ipcMain.handle(desktopIpc.setModelSettingsScopeMode, (event, mode) =>
    runWindowScopedForEvent(event, () => store.setModelSettingsScopeMode(mode)),
  );
  ipcMain.handle(desktopIpc.setSessionModel, (event, workspaceId: string, sessionId: string, provider: string, modelId: string) =>
    runWindowScopedForEvent(event, () => store.setSessionModel({ workspaceId, sessionId }, provider, modelId)),
  );
  ipcMain.handle(desktopIpc.setDefaultModel, (event, workspaceId: string, provider: string, modelId: string) =>
    runWindowScopedForEvent(event, () => store.setDefaultModel(workspaceId, provider, modelId)),
  );
  ipcMain.handle(
    desktopIpc.setDefaultThinkingLevel,
    (event, workspaceId: string, thinkingLevel) =>
      runWindowScopedForEvent(event, () => store.setDefaultThinkingLevel(workspaceId, thinkingLevel)),
  );
  ipcMain.handle(
    desktopIpc.setSessionThinkingLevel,
    (event, workspaceId: string, sessionId: string, thinkingLevel) =>
      runWindowScopedForEvent(event, () => store.setSessionThinkingLevel({ workspaceId, sessionId }, thinkingLevel)),
  );
  ipcMain.handle(desktopIpc.loginProvider, (event, workspaceId: string, providerId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return runUnscopedStateResultForWindow(window, () =>
      store.loginProvider(workspaceId, providerId, createRuntimeLoginCallbacks(window)),
    );
  });
  ipcMain.handle(desktopIpc.logoutProvider, (event, workspaceId: string, providerId: string) =>
    runWindowScopedForEvent(event, () => store.logoutProvider(workspaceId, providerId)),
  );
  ipcMain.handle(desktopIpc.setProviderApiKey, (event, workspaceId: string, providerId: string, apiKey: string) =>
    runWindowScopedForEvent(event, () => store.setProviderApiKey(workspaceId, providerId, apiKey)),
  );
  ipcMain.handle(desktopIpc.setEnableSkillCommands, (event, workspaceId: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setEnableSkillCommands(workspaceId, enabled)),
  );
  ipcMain.handle(desktopIpc.listCustomProviders, () => store.listCustomProviders());
  ipcMain.handle(desktopIpc.setCustomProvider, (event, workspaceId: string, config: CustomProviderConfig) =>
    runWindowScopedForEvent(event, () => store.setCustomProvider(workspaceId, config)),
  );
  ipcMain.handle(desktopIpc.deleteCustomProvider, (event, workspaceId: string, providerId: string) =>
    runWindowScopedForEvent(event, () => store.deleteCustomProvider(workspaceId, providerId)),
  );
  ipcMain.handle(desktopIpc.probeCustomProviderModels, (_event, input: CustomProviderProbeInput) =>
    probeCustomProviderModels(input),
  );
  ipcMain.handle(desktopIpc.setScopedModelPatterns, (event, workspaceId: string, patterns: readonly string[]) =>
    runWindowScopedForEvent(event, () => store.setScopedModelPatterns(workspaceId, patterns)),
  );
  ipcMain.handle(desktopIpc.setSkillEnabled, (event, workspaceId: string, filePath: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setSkillEnabled(workspaceId, filePath, enabled)),
  );
  ipcMain.handle(desktopIpc.setExtensionEnabled, (event, workspaceId: string, filePath: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setExtensionEnabled(workspaceId, filePath, enabled)),
  );
  ipcMain.handle(desktopIpc.respondToHostUiRequest, (event, workspaceId: string, sessionId: string, response) =>
    runImmediateStateResultForWindow(
      BrowserWindow.fromWebContents(event.sender),
      () => store.respondToHostUiRequest({ workspaceId, sessionId }, response),
    ),
  );
  ipcMain.handle(desktopIpc.setNotificationPreferences, (event, preferences) =>
    runWindowScopedForEvent(event, () => store.setNotificationPreferences(preferences)),
  );
  ipcMain.handle(desktopIpc.setIntegratedTerminalShell, (event, shellPath: string) =>
    runWindowScopedForEvent(event, () => store.setIntegratedTerminalShell(shellPath)),
  );
  ipcMain.handle(desktopIpc.setEnableTransparency, async (_event, enabled: boolean) => {
    const nextState = await store.setEnableTransparency(enabled);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (process.platform === "darwin") {
        mainWindow.setVibrancy(enabled ? "under-window" : null);
      }
    }
    return nextState;
  });
  ipcMain.handle(desktopIpc.terminalEnsurePanel, (event, workspaceId: string, terminalScopeId: string, size) => {
    return getTerminalService().ensurePanel(event.sender, workspaceId, terminalScopeId, size);
  });
  ipcMain.handle(desktopIpc.terminalCreateSession, (event, workspaceId: string, terminalScopeId: string, size) => {
    return getTerminalService().createSession(event.sender, workspaceId, terminalScopeId, size);
  });
  ipcMain.handle(desktopIpc.terminalSetActiveSession, (event, workspaceId: string, terminalScopeId: string, terminalId: string) => {
    return getTerminalService().setActiveSession(event.sender, workspaceId, terminalScopeId, terminalId);
  });
  ipcMain.handle(desktopIpc.terminalWrite, (event, terminalId: string, data: string) => {
    terminalService?.write(event.sender, terminalId, data);
  });
  ipcMain.handle(desktopIpc.terminalResize, (event, terminalId: string, size) => {
    terminalService?.resize(event.sender, terminalId, size);
  });
  ipcMain.handle(desktopIpc.terminalRestartSession, (event, terminalId: string, size) => {
    return getTerminalService().restart(event.sender, terminalId, size);
  });
  ipcMain.handle(desktopIpc.terminalCloseSession, (event, terminalId: string) => {
    return getTerminalService().close(event.sender, terminalId);
  });
  ipcMain.handle(desktopIpc.terminalSetTitle, (event, terminalId: string, title: string) => {
    terminalService?.setTitle(event.sender, terminalId, title);
  });
  ipcMain.on(desktopIpc.terminalSetFocused, (event, focused: boolean) => {
    if (focused) {
      terminalFocusedWebContentsIds.add(event.sender.id);
    } else {
      terminalFocusedWebContentsIds.delete(event.sender.id);
    }
  });
  ipcMain.handle(desktopIpc.getNotificationPermissionStatus, () =>
    notificationPermissionService?.getCurrentStatus() ?? Promise.resolve("unknown"),
  );
  ipcMain.handle(desktopIpc.requestNotificationPermission, () =>
    notificationPermissionService?.requestPermission() ?? Promise.resolve("unknown"),
  );
  ipcMain.handle(desktopIpc.openSystemNotificationSettings, () =>
    notificationPermissionService?.openSystemSettings() ?? Promise.resolve(),
  );
  ipcMain.handle(desktopIpc.createSession, (event, input: CreateSessionInput) =>
    runWindowScopedForEvent(event, () => store.createSession(input)),
  );
  ipcMain.handle(desktopIpc.startThread, (event, input: StartThreadInput) =>
    runWindowScopedForEvent(event, () => store.startThread(input)),
  );
  ipcMain.handle(desktopIpc.forkThread, (event, input: ForkThreadInput) =>
    runWindowScopedForEvent(event, () => store.forkThread(input)),
  );
  ipcMain.handle(desktopIpc.sendChildThreadFollowUp, (event, input: SendChildThreadFollowUpInput) =>
    runWindowScopedForEvent(event, () => store.sendChildThreadFollowUp(input)),
  );
  ipcMain.handle(desktopIpc.setChildSupervisionLoop, (event, input: SetChildSupervisionLoopInput) =>
    runWindowScopedForEvent(event, () => store.setChildSupervisionLoop(input)),
  );
  ipcMain.handle(desktopIpc.openSkillInFinder, async (_event, workspaceId: string, filePath: string) => {
    const resolved = store.getSkillFilePath(workspaceId, filePath);
    if (!resolved) {
      throw new Error(`Unknown skill: ${filePath}`);
    }
    await shell.openPath(path.dirname(resolved));
  });
  ipcMain.handle(desktopIpc.openExtensionInFinder, async (_event, workspaceId: string, filePath: string) => {
    const resolved = store.getExtensionFilePath(workspaceId, filePath);
    if (!resolved) {
      throw new Error(`Unknown extension: ${filePath}`);
    }
    await shell.openPath(path.dirname(resolved));
  });
  ipcMain.handle(desktopIpc.cancelCurrentRun, (event) =>
    runWindowScopedForEvent(event, () => store.cancelCurrentRun()),
  );
  ipcMain.handle(desktopIpc.pickComposerAttachments, async (event) => {
    const window = resolveDialogWindow(BrowserWindow.fromWebContents(event.sender));
    const result =
      window
        ? await dialog.showOpenDialog(window, {
            properties: ["openFile", "multiSelections"],
            title: "Attach files",
          })
        : await dialog.showOpenDialog({
            properties: ["openFile", "multiSelections"],
            title: "Attach files",
          });
    if (result.canceled || result.filePaths.length === 0) {
      return stateForWindow(window);
    }
    const attachments = await Promise.all(result.filePaths.map(readComposerAttachment));
    return runWindowScopedForWindow(window, () => store.addComposerAttachments(attachments));
  });
  ipcMain.on(desktopIpc.readClipboardImage, (event) => {
    event.returnValue = readClipboardImageAttachment();
  });
  ipcMain.handle(desktopIpc.addComposerAttachments, (event, attachments: readonly ComposerAttachment[]) => {
    const validated = attachments.flatMap(validateComposerAttachmentPayload);
    return runWindowScopedForEvent(event, () => store.addComposerAttachments(validated));
  });
  ipcMain.handle(desktopIpc.removeComposerAttachment, (event, attachmentId: string) =>
    runWindowScopedForEvent(event, () => store.removeComposerAttachment(attachmentId)),
  );
  ipcMain.handle(desktopIpc.editQueuedComposerMessage, (event, messageId: string, currentDraft?: string) =>
    runWindowScopedForEvent(event, () => store.editQueuedComposerMessage(messageId, currentDraft)),
  );
  ipcMain.handle(desktopIpc.cancelQueuedComposerEdit, (event) =>
    runWindowScopedForEvent(event, () => store.cancelQueuedComposerEdit()),
  );
  ipcMain.handle(desktopIpc.removeQueuedComposerMessage, (event, messageId: string) =>
    runWindowScopedForEvent(event, () => store.removeQueuedComposerMessage(messageId)),
  );
  ipcMain.handle(desktopIpc.steerQueuedComposerMessage, (event, messageId: string) =>
    runWindowScopedForEvent(event, () => store.steerQueuedComposerMessage(messageId)),
  );
  ipcMain.handle(desktopIpc.updateComposerDraft, (event, composerDraft: string) =>
    runWindowScopedForEvent(event, async () => {
      currentComposerDraftPersistOriginWebContentsId = event.sender.id;
      try {
        return await store.updateComposerDraft(composerDraft);
      } finally {
        currentComposerDraftPersistOriginWebContentsId = undefined;
      }
    }),
  );
  ipcMain.handle(
    desktopIpc.submitComposer,
    (event, text: string, options?: { readonly deliverAs?: "steer" | "followUp" }) =>
      runWindowScopedForEvent(event, () => store.submitComposer(text, options)),
  );
  ipcMain.handle(desktopIpc.getSessionTree, (_event, target: WorkspaceSessionTarget) =>
    store.getSessionTree(target),
  );
  ipcMain.handle(
    desktopIpc.navigateSessionTree,
    (event, target: WorkspaceSessionTarget, targetId: string, options) =>
      runWindowScopedStateResult(BrowserWindow.fromWebContents(event.sender), () =>
        store.navigateSessionTree(target, targetId, options),
      ),
  );
  ipcMain.handle(desktopIpc.listWorkspaceFiles, async (_event, workspaceId: string, options?: { readonly force?: boolean }) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return [];
    }
    return listWorkspaceFiles(workspacePath, options);
  });
  ipcMain.handle(desktopIpc.readWorkspaceFile, async (_event, workspaceId: string, filePath: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    return readWorkspaceFile(workspacePath, filePath);
  });
  ipcMain.handle(desktopIpc.getChangedFiles, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return {
        state: "unavailable",
        error: {
          code: "workspace-unavailable",
          message: "Changed files are unavailable because this workspace could not be found.",
        },
      } satisfies ChangedFilesResult;
    }
    return getChangedFiles(workspacePath);
  });
  ipcMain.handle(desktopIpc.getFileDiff, async (_event, workspaceId: string, filePath: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return "";
    }
    return getFileDiff(workspacePath, filePath);
  });
  ipcMain.handle(
    desktopIpc.stageFile,
    async (_event, workspaceId: string, filePath: string, stagingSourcePath?: string) => {
      const workspacePath = store.getWorkspacePath(workspaceId);
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      await stageFile(workspacePath, filePath, { sourcePath: stagingSourcePath });
    },
  );
  ipcMain.handle(desktopIpc.toggleWindowMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
      return;
    }

    window.maximize();
  });

  createAppWindow();
  void notificationPermissionService.getCurrentStatus();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAppWindow();
      void notificationPermissionService?.getCurrentStatus();
    }
  });
});

app.on("window-all-closed", () => {
  // macOS normally keeps the app alive after its final window closes. The
  // Electron harness closes windows to end each isolated run, so let explicit
  // test-mode launches quit instead of leaving their process behind forever.
  if (process.platform !== "darwin" || appTestMode !== undefined) {
    stopNotifications?.();
    stopNotifications = undefined;
    notificationManager = undefined;
    notificationPermissionService?.dispose();
    notificationPermissionService = undefined;
    stopUpdateChecker?.();
    stopUpdateChecker = undefined;
    stopPruningTerminals?.();
    stopPruningTerminals = undefined;
    terminalService?.dispose();
    terminalService = undefined;
    app.quit();
  }
});

app.on("before-quit", (event) => {
  stopNotifications?.();
  stopNotifications = undefined;
  notificationManager = undefined;
  notificationPermissionService?.dispose();
  notificationPermissionService = undefined;
  stopUpdateChecker?.();
  stopUpdateChecker = undefined;
  stopPruningTerminals?.();
  stopPruningTerminals = undefined;
  terminalService?.dispose();
  terminalService = undefined;
  if (quittingAfterStoreFlush || !store) {
    return;
  }

  event.preventDefault();
  quittingAfterStoreFlush = true;
  const flush = store
    .flushPersistence()
    .catch((error) => {
      console.error("pi-gui: persistence flush failed during quit:", error);
    });
  // Never let a hung flush block quit forever — quit after a bounded wait.
  const flushDeadline = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn("pi-gui: persistence flush timed out during quit; quitting anyway.");
      resolve();
    }, QUIT_FLUSH_TIMEOUT_MS);
  });
  void Promise.race([flush, flushDeadline]).finally(() => {
    app.quit();
  });
});

function resolveInitialWorkspacePaths(): readonly string[] {
  const raw = process.env.PI_APP_INITIAL_WORKSPACES;
  if (raw !== undefined) {
    return raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

async function readComposerAttachment(filePath: string): Promise<ComposerAttachment> {
  const mimeType = mimeTypeForPath(filePath);
  if (mimeType.startsWith("image/")) {
    return readComposerImageAttachment(filePath, mimeType);
  }

  const stats = await stat(filePath);
  return {
    id: randomUUID(),
    kind: "file",
    name: path.basename(filePath),
    mimeType,
    fsPath: filePath,
    ...(typeof stats.size === "number" ? { sizeBytes: stats.size } : {}),
  };
}

async function readComposerImageAttachment(filePath: string, mimeType: string): Promise<ComposerImageAttachment> {
  const buffer = await readFile(filePath);
  return {
    id: randomUUID(),
    kind: "image",
    name: path.basename(filePath),
    mimeType,
    data: buffer.toString("base64"),
  };
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const supported = SUPPORTED_IMAGE_TYPES.find((type) => type.extension === extension);
  if (supported) {
    return supported.mimeType;
  }
  return "application/octet-stream";
}

function validateComposerAttachmentPayload(attachment: ComposerAttachment): ComposerAttachment[] {
  if (attachment.kind === "image") {
    if (typeof attachment.data !== "string" || typeof attachment.mimeType !== "string" || !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return [];
    }
    return [
      {
        ...attachment,
        kind: "image",
      },
    ];
  }

  if (
    attachment.kind !== "file" ||
    typeof attachment.fsPath !== "string" ||
    typeof attachment.mimeType !== "string" ||
    typeof attachment.name !== "string"
  ) {
    return [];
  }

  const normalized: ComposerFileAttachment = {
    ...attachment,
    kind: "file",
    fsPath: attachment.fsPath.trim(),
    name: attachment.name.trim() || path.basename(attachment.fsPath),
  };
  if (!normalized.fsPath) {
    return [];
  }
  return [normalized];
}

function createRuntimeLoginCallbacks(window?: BrowserWindow | null) {
  return {
    onAuth: async ({ url, instructions }: { readonly url: string; readonly instructions?: string }) => {
      await shell.openExternal(url);
      if (instructions?.trim()) {
        await showLoginInstructions(window, instructions.trim());
      }
    },
    onPrompt: async ({ message, placeholder, allowEmpty }: { readonly message: string; readonly placeholder?: string; readonly allowEmpty?: boolean }) =>
      promptForText(window, message, placeholder, allowEmpty ?? false),
  };
}

async function showLoginInstructions(parentWindow: BrowserWindow | null | undefined, message: string): Promise<void> {
  const window = resolveDialogWindow(parentWindow);
  if (!window) {
    throw new Error("Main window is not available for login instructions.");
  }
  window.show();
  window.focus();
  await window.webContents.executeJavaScript(`window.alert(${JSON.stringify(message)})`, true);
}

// Electron does not implement window.prompt(), so provider-login text prompts
// are served by a small dedicated modal window instead.
async function promptForText(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
  placeholder = "",
  allowEmpty = false,
): Promise<string> {
  const parent = resolveDialogWindow(parentWindow);
  if (!parent) {
    throw new Error("Main window is not available for login.");
  }
  parent.show();
  parent.focus();

  const modal = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    width: 460,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "pi-gui",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await modal.loadURL(promptDataUrl(message, placeholder));
    modal.show();
    modal.focus();

    const result = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      // Closing the window (title-bar close) counts as a cancel.
      modal.once("closed", () => finish(null));
      // The page wires its own buttons on load and exposes the outcome as a
      // promise; awaiting it here avoids any handler-attachment race.
      modal.webContents
        .executeJavaScript("window.__piPromptResult", true)
        .then((value) => finish(typeof value === "string" ? value : null))
        .catch(() => finish(null));
    });

    if (result === null) {
      throw new Error("Login cancelled.");
    }
    const trimmedResult = result.trim();
    if (!allowEmpty && trimmedResult.length === 0) {
      throw new Error("Login cancelled.");
    }
    return trimmedResult;
  } finally {
    if (!modal.isDestroyed()) {
      modal.destroy();
    }
  }
}

function promptDataUrl(message: string, placeholder: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 20px; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #1b1d22; display: flex; flex-direction: column; gap: 14px; height: 100vh; }
  @media (prefers-color-scheme: dark) { body { background: #23262d; color: #e7e9ee; } input { background: #171a1f; color: #e7e9ee; border-color: #3a3f4a; } }
  .msg { line-height: 1.4; white-space: pre-wrap; }
  input { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid #c3c8d0; border-radius: 6px;
    background: #fff; color: inherit; }
  input:focus { outline: 2px solid #4a8cff; outline-offset: 0; border-color: #4a8cff; }
  .row { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 16px; font-size: 13px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
  #pi-prompt-cancel { background: transparent; border-color: #b7bdc7; color: inherit; }
  #pi-prompt-ok { background: #2f6ae0; color: #fff; }
</style></head>
<body>
  <div class="msg">${escapeHtml(message)}</div>
  <input id="pi-prompt-input" type="text" placeholder="${escapeHtml(placeholder)}" autofocus />
  <div class="row">
    <button id="pi-prompt-cancel" type="button">Cancel</button>
    <button id="pi-prompt-ok" type="button">OK</button>
  </div>
  <script>
    (function () {
      var resolveResult;
      window.__piPromptResult = new Promise(function (resolve) { resolveResult = resolve; });
      function wire() {
        var input = document.getElementById('pi-prompt-input');
        var ok = document.getElementById('pi-prompt-ok');
        var cancel = document.getElementById('pi-prompt-cancel');
        if (!input || !ok || !cancel) { resolveResult(null); return; }
        ok.addEventListener('click', function () { resolveResult(input.value); });
        cancel.addEventListener('click', function () { resolveResult(null); });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { event.preventDefault(); resolveResult(input.value); }
          else if (event.key === 'Escape') { event.preventDefault(); resolveResult(null); }
        });
        input.focus();
        document.body.dataset.piReady = '1';
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
      } else {
        wire();
      }
    })();
  </script>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function probeCustomProviderModels(input: CustomProviderProbeInput): Promise<CustomProviderProbeResult> {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl || !isValidHttpBaseUrl(baseUrl)) {
    return { ok: false, error: "Base URL must start with http:// or https://" };
  }
  const target = `${baseUrl.replace(/\/+$/, "")}/models`;
  const apiKey = input.apiKey?.trim();
  try {
    const response = await net.fetch(target, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText} from ${target}` };
    }
    const payload = (await response.json()) as unknown;
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { ok: false, error: `Response from ${target} is missing a "data" array` };
    }
    const models = data
      .map((entry) => {
        if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
          return (entry as { id: string }).id;
        }
        return undefined;
      })
      .filter((id): id is string => Boolean(id && id.length > 0));
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: describeProbeError(error, target) };
  }
}

function describeProbeError(error: unknown, target: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Timed out after 5s contacting ${target}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
