import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  net,
  shell,
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
import { DesktopAppStore } from "./application/app-store";
import { WindowOwner } from "./windows/window-owner";
import { registerDesktopIpc } from "./ipc/register-desktop-ipc";
import {
  createOrchestrationRuntimeExtension,
  createOrchestrationRuntimeTools,
  type OrchestrationRuntimeBridge,
} from "./orchestration/orchestration-runtime";
import { getChangedFiles, getFileDiff, stageFile } from "./platform/files/app-store-diff";
import { listWorkspaceFiles, readWorkspaceFile } from "./platform/files/app-store-files";
import { MAIN_DEV_RELOAD_MARKER } from "./dev-reload-main-probe";
import { NotificationManager } from "./platform/notification-manager";
import { NotificationPermissionService } from "./platform/notification-permission";
import { checkForUpdate, initUpdateChecker, openReleasesPage } from "./platform/update-checker";
import { ThemeManager } from "./platform/theme-manager";
import { TerminalService } from "./platform/terminal-service";
import type { DesktopAppState, DesktopAppViewState } from "../contracts/desktop-state";
import {
  desktopIpc,
  getDesktopCommandFromShortcut,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
} from "../contracts/ipc";
import {
  assertComposerImageBytes,
  assertComposerImageFileSizes,
  assertComposerImagePixels,
  SUPPORTED_COMPOSER_IMAGE_TYPES,
  type ClipboardImageRead,
} from "../contracts/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../contracts/desktop-state";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { GenerateThreadTitleOptions } from "@pi-gui/pi-sdk-driver";
import type { SessionRef, WorkspaceRef } from "@pi-gui/session-driver";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const appTestMode = resolveAppTestMode(process.env.PI_APP_TEST_MODE);
const windowTestMode = appTestMode ?? "foreground";
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
let store: DesktopAppStore;
let windowOwner: WindowOwner;
const themeManager = new ThemeManager();
let mainWindow: BrowserWindow | null = null;
let notificationManager: NotificationManager | undefined;
let notificationPermissionService: NotificationPermissionService | undefined;
let terminalService: TerminalService | undefined;
let integratedTerminalShell = "";
let applicationRelaunchRequested = false;

function requestApplicationRelaunch(): void {
  if (applicationRelaunchRequested) {
    return;
  }
  applicationRelaunchRequested = true;
  app.relaunch();
  app.quit();
}

interface OrchestrationRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

let stopNotifications: (() => void) | undefined;
let stopUpdateChecker: (() => void) | undefined;
let stopPruningTerminals: (() => void) | undefined;
let retainedTerminalWorkspacePathSignature = "";
const terminalFocusedWebContentsIds = new Set<number>();
let quittingAfterStoreFlush = false;

const SUPPORTED_IMAGE_TYPES = SUPPORTED_COMPOSER_IMAGE_TYPES;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(
  SUPPORTED_IMAGE_TYPES.map((type) => type.mimeType),
);
const NEW_WINDOW_MENU_ITEM_ID = "file.new-window";

function createStoreBackedOrchestrationRuntimeBridge(): OrchestrationRuntimeBridge {
  return {
    createChildThread: async (ctx, input) => {
      await store.initialize();
      return store.createChildThreadToolResult(sessionRefFromExtensionContext(ctx), input);
    },
    listThreads: async (ctx) => {
      await store.initialize();
      return store.listThreadsToolResult(sessionRefFromExtensionContext(ctx));
    },
    readThread: async (ctx, threadId) => {
      await store.initialize();
      return store.readThreadToolResult(sessionRefFromExtensionContext(ctx), threadId);
    },
    sendMessageToThread: async (ctx, input) => {
      await store.initialize();
      return store.sendMessageToThreadToolResult(sessionRefFromExtensionContext(ctx), input);
    },
  };
}

function sessionRefFromExtensionContext(ctx: ExtensionContext): SessionRef {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = path.resolve(ctx.sessionManager.getCwd?.() ?? ctx.cwd);
  const sessionRef = store.findSessionRefByCwdAndSessionId(cwd, sessionId);
  if (!sessionRef) {
    throw new Error(`Unable to resolve orchestration session for ${cwd}:${sessionId}`);
  }
  return sessionRef;
}

async function runOrchestrationRuntimeToolForTest(
  bridge: OrchestrationRuntimeBridge,
  input: OrchestrationRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createOrchestrationRuntimeTools(bridge).find(
    (entry) => entry.name === input.toolName,
  );
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
  const workspace = store
    .snapshot()
    .workspaces.find(
      (entry) =>
        entry.id === sessionRef.workspaceId &&
        entry.sessions.some((session) => session.id === sessionRef.sessionId),
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
    scopedModels: [],
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

function readClipboardImageAttachment(): ClipboardImageRead {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return { ok: false };
  }

  const size = image.getSize();
  try {
    assertComposerImagePixels(size.width, size.height);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const png = image.toPNG();
  if (png.length === 0) {
    return { ok: false };
  }
  try {
    assertComposerImageBytes(png.length);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    attachment: {
      id: randomUUID(),
      kind: "image",
      name: "pasted-image.png",
      mimeType: "image/png",
      data: png.toString("base64"),
    },
  };
}

function createWindow(): BrowserWindow {
  const backgroundTestMode = windowTestMode === "background";
  const enableTransparency = store ? store.snapshot().enableTransparency : false;
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
      createAppWindow(windowOwner.viewForWindow(window));
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "o") {
      event.preventDefault();
      void pickWorkspaceViaDialog(window).catch((error: unknown) => {
        console.error("[main] pickWorkspaceViaDialog failed", error);
      });
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "v") {
      const clipboardImage = readClipboardImageAttachment();
      if (clipboardImage.ok || clipboardImage.message) {
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
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string).catch((error: unknown) => {
      console.error("[main] loadURL failed", error);
    });
    if (process.env.PI_APP_OPEN_DEVTOOLS !== "0") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void window.loadURL(appRendererUrl()).catch((error: unknown) => {
      console.error("[main] loadURL failed", error);
    });
  }

  return window;
}

function createAppWindow(sourceView?: DesktopAppViewState): BrowserWindow {
  const window = createWindow();
  const webContentsId = window.webContents.id;
  windowOwner.add(window, sourceView);
  themeManager.trackWindow(window);

  window.once("closed", () => {
    windowOwner.remove(window);
    terminalFocusedWebContentsIds.delete(webContentsId);
    terminalService?.disposeWebContents(webContentsId);
    void store
      .cancelPendingDialogsWithoutVisibleWindow((sessionRef) =>
        windowOwner.isSessionVisibleInAnotherWindow(sessionRef),
      )
      .catch((error: unknown) => {
        console.error("[main] cancelPendingDialogsWithoutVisibleWindow failed", error);
      });
    if (windowOwner.size() === 0) {
      terminalService?.dispose();
      terminalService = undefined;
    }
  });

  return window;
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}

function resolveAppTestMode(value: string | undefined): "foreground" | "background" | undefined {
  return value === "foreground" || value === "background" ? value : undefined;
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  return windowOwner.resolveDialogWindow(parentWindow);
}

async function stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
  return windowOwner.stateForWindow(window);
}

function runWindowScopedForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
  options: { readonly forceActiveWindow?: boolean } = {},
): Promise<DesktopAppState> {
  return windowOwner.runStateAction(window, action, options);
}

async function pickWorkspacePathViaDialog(
  parentWindow?: BrowserWindow | null,
): Promise<string | undefined> {
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

async function addPickedWorkspace(
  window: BrowserWindow | null | undefined,
  workspacePath: string,
): Promise<DesktopAppState> {
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

async function pickWorkspaceViaDialog(
  parentWindow?: BrowserWindow | null,
): Promise<DesktopAppState> {
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
            void runManualUpdateCheck().catch((error: unknown) => {
              console.error("[main] runManualUpdateCheck failed", error);
            });
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
            createAppWindow(windowOwner.foregroundView());
          },
        },
        { type: "separator" },
        {
          id: OPEN_FOLDER_MENU_ITEM_ID,
          label: "Open Folder…",
          accelerator: "Command+O",
          click: () => {
            void pickWorkspaceViaDialog(mainWindow).catch((error: unknown) => {
              console.error("[main] pickWorkspaceViaDialog failed", error);
            });
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
  const window = windowOwner.foreground();
  if (!window) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
});

app
  .whenReady()
  .then(async () => {
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
      | ((
          workspace: WorkspaceRef,
          options: GenerateThreadTitleOptions,
        ) => Promise<string | null | undefined>)
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
      shouldKeepSessionDialogs: (sessionRef) =>
        windowOwner?.isSessionVisibleInAnotherWindow(sessionRef) ?? false,
      driverOptions,
      generateThreadTitleOverride: async (workspace, options) =>
        generateThreadTitleOverride?.(workspace, options),
    });
    windowOwner = new WindowOwner(store, {
      onActiveWindowChanged: (window) => {
        mainWindow = window;
        notificationManager?.trackWindow(window);
        notificationPermissionService?.trackWindow(window);
      },
    });
    await store.initialize();
    themeManager.setMode(store.snapshot().themeMode);
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
              windowOwner.activate(mainWindow);
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
      for (const window of windowOwner.allWindows()) {
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
        const window = windowOwner.foreground();
        await runWindowScopedForWindow(window, () => store.selectSession(sessionRef), {
          forceActiveWindow: true,
        });
      },
    );
    stopNotifications = notificationManager.start();
    if (!isDev) {
      stopUpdateChecker = initUpdateChecker();
    }

    registerDesktopIpc({
      windows: windowOwner,
      owners: {
        state: store,
        workspace: store,
        conversation: store,
        orchestration: store,
        settings: store,
      },
      capabilities: {
        ping: () =>
          devReloadMarkersEnabled
            ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}`
            : "pi desktop ready",
        theme: themeManager,
        openExternal: async (url) => {
          const parsed = parseExternalWebUrl(url);
          if (!parsed) {
            throw new Error(`Refusing to open unsupported URL: ${url}`);
          }
          await shell.openExternal(parsed.toString());
        },
        pickWorkspace: (window) => pickWorkspaceViaDialog(window),
        createLoginCallbacks: (window) => createRuntimeLoginCallbacks(window),
        probeCustomProviderModels,
        notificationPermission: () => notificationPermissionService,
        terminal: getTerminalService,
        optionalTerminal: () => terminalService,
        setTerminalFocused: (webContentsId, focused) => {
          if (focused) {
            terminalFocusedWebContentsIds.add(webContentsId);
          } else {
            terminalFocusedWebContentsIds.delete(webContentsId);
          }
        },
        setTransparency: (enabled) => {
          if (process.platform !== "darwin") {
            return;
          }
          for (const window of windowOwner.allWindows()) {
            if (!window.isDestroyed()) {
              window.setVibrancy(enabled ? "under-window" : null);
            }
          }
        },
        pickComposerAttachments: async (window, existing = []) => {
          const parent = resolveDialogWindow(window);
          const result = parent
            ? await dialog.showOpenDialog(parent, {
                properties: ["openFile", "multiSelections"],
                title: "Attach files",
              })
            : await dialog.showOpenDialog({
                properties: ["openFile", "multiSelections"],
                title: "Attach files",
              });
          if (result.canceled || result.filePaths.length === 0) {
            return undefined;
          }
          return readComposerAttachmentsFromPaths(result.filePaths, existing);
        },
        readClipboardImage: readClipboardImageAttachment,
        validateComposerAttachments: (attachments) =>
          attachments.flatMap(validateComposerAttachmentPayload),
        listWorkspaceFiles,
        readWorkspaceFile,
        getChangedFiles,
        getFileDiff,
        stageFile,
        relaunchApplication: requestApplicationRelaunch,
      },
    });

    createAppWindow();
    void notificationPermissionService.getCurrentStatus().catch((error: unknown) => {
      console.error("[main] getCurrentStatus failed", error);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createAppWindow();
        if (notificationPermissionService) {
          void notificationPermissionService.getCurrentStatus().catch((error: unknown) => {
            console.error("[main] getCurrentStatus failed", error);
          });
        }
      }
    });
  })
  .catch((error: unknown) => {
    console.error("[main] Application startup failed", error);
    app.exit(1);
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
  const flush = store.flushPersistence().catch((error) => {
    console.error("pi-gui: persistence flush failed during quit:", error);
  });
  // Never let a hung flush block quit forever — quit after a bounded wait.
  const flushDeadline = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn("pi-gui: persistence flush timed out during quit; quitting anyway.");
      resolve();
    }, QUIT_FLUSH_TIMEOUT_MS);
  });
  void Promise.race([flush, flushDeadline])
    .finally(() => {
      app.quit();
    })
    .catch((error: unknown) => {
      console.error("[main] Quit after persistence flush failed", error);
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

async function readComposerAttachmentsFromPaths(
  filePaths: readonly string[],
  existing: readonly ComposerAttachment[] = [],
): Promise<ComposerAttachment[]> {
  const planned = filePaths.map((filePath) => ({
    filePath,
    mimeType: mimeTypeForPath(filePath),
  }));
  const imageSizes = await Promise.all(
    planned
      .filter((entry) => entry.mimeType.startsWith("image/"))
      .map(async (entry) => (await stat(entry.filePath)).size),
  );
  assertComposerImageFileSizes(imageSizes, existing);
  return Promise.all(planned.map((entry) => readComposerAttachment(entry.filePath)));
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

async function readComposerImageAttachment(
  filePath: string,
  mimeType: string,
): Promise<ComposerImageAttachment> {
  const stats = await stat(filePath);
  assertComposerImageBytes(stats.size);
  const buffer = await readFile(filePath);
  assertComposerImageBytes(buffer.length);
  const image = nativeImage.createFromBuffer(buffer);
  if (!image.isEmpty()) {
    const size = image.getSize();
    assertComposerImagePixels(size.width, size.height);
  }
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
    if (
      typeof attachment.data !== "string" ||
      typeof attachment.mimeType !== "string" ||
      !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)
    ) {
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
    onAuth: async ({
      url,
      instructions,
    }: {
      readonly url: string;
      readonly instructions?: string;
    }) => {
      await shell.openExternal(url);
      if (instructions?.trim()) {
        await showLoginInstructions(window, instructions.trim());
      }
    },
    onPrompt: async ({
      message,
      placeholder,
      allowEmpty,
    }: {
      readonly message: string;
      readonly placeholder?: string;
      readonly allowEmpty?: boolean;
    }) => promptForText(window, message, placeholder, allowEmpty ?? false),
  };
}

async function showLoginInstructions(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
): Promise<void> {
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

async function probeCustomProviderModels(
  input: CustomProviderProbeInput,
): Promise<CustomProviderProbeResult> {
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
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { id?: unknown }).id === "string"
        ) {
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
