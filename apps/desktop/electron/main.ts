import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopAppStore } from "./app-store";
import { getChangedFiles, getFileDiff, stageFile } from "./app-store-diff";
import { listWorkspaceFiles } from "./app-store-files";
import { MAIN_DEV_RELOAD_MARKER } from "./dev-reload-main-probe";
import { NotificationManager } from "./notification-manager";
import {
  getNotificationPermissionStatus,
  openSystemNotificationSettings,
  requestNotificationPermission,
} from "./notification-permission";
import { checkForUpdate, initUpdateChecker } from "./update-checker";
import { ThemeManager } from "./theme-manager";
import type { DesktopAppState, ThemeMode } from "../src/desktop-state";
import { desktopIpc, getDesktopCommandFromShortcut } from "../src/ipc";
import { SUPPORTED_COMPOSER_IMAGE_TYPES } from "../src/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  RemoveWorktreeInput,
  StartThreadInput,
  WorkspaceSessionTarget,
} from "../src/desktop-state";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { GenerateThreadTitleOptions } from "@pi-gui/pi-sdk-driver";
import type { WorkspaceRef } from "@pi-gui/session-driver";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const windowTestMode = resolveWindowTestMode();
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
let store: DesktopAppStore;
const themeManager = new ThemeManager();
let mainWindow: BrowserWindow | null = null;
let notificationManager: NotificationManager | undefined;
let stopPublishingState: (() => void) | undefined;
let stopPublishingSelectedTranscript: (() => void) | undefined;
let stopNotifications: (() => void) | undefined;
let stopUpdateChecker: (() => void) | undefined;
let quittingAfterStoreFlush = false;

const SUPPORTED_IMAGE_TYPES = SUPPORTED_COMPOSER_IMAGE_TYPES;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(SUPPORTED_IMAGE_TYPES.map((type) => type.mimeType));
const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";
const CHECK_FOR_UPDATES_MENU_ITEM_ID = "app.check-for-updates";
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_DIMENSION = 8_192;

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
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#f3f4f8",
    titleBarStyle: "hiddenInset",
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
    if (platformModifier && !input.shift && lowerKey === "o") {
      event.preventDefault();
      void pickWorkspaceViaDialog();
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
    const indexPath = path.join(__dirname, "..", "renderer", "index.html");
    void window.loadURL(pathToFileURL(indexPath).toString());
  }

  return window;
}

function attachStatePublisher(window: BrowserWindow): void {
  stopPublishingState?.();
  stopPublishingSelectedTranscript?.();
  stopPublishingState = store.subscribe((state) => {
    if (canPublishToWindow(window)) {
      window.webContents.send(desktopIpc.stateChanged, state);
    }
  });
  stopPublishingSelectedTranscript = store.subscribeToSelectedTranscript((payload) => {
    if (canPublishToWindow(window)) {
      window.webContents.send(desktopIpc.selectedTranscriptChanged, payload);
    }
  });
  window.webContents.once("render-process-gone", () => {
    stopPublishingState?.();
    stopPublishingState = undefined;
    stopPublishingSelectedTranscript?.();
    stopPublishingSelectedTranscript = undefined;
  });
  window.once("closed", () => {
    stopPublishingState?.();
    stopPublishingState = undefined;
    stopPublishingSelectedTranscript?.();
    stopPublishingSelectedTranscript = undefined;
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed();
}

async function pickWorkspaceViaDialog(): Promise<DesktopAppState> {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
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
    return store.getState();
  }
  const nextState = await store.addWorkspace(result.filePaths[0] as string);
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

async function runManualUpdateCheck(): Promise<void> {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
  const result = await checkForUpdate();

  if (result.status === "update-available") {
    return;
  }

  if (result.status === "up-to-date") {
    const options: MessageBoxOptions = {
      type: "info",
      title: "pi-gui",
      message: `You're up to date on version ${result.currentVersion}.`,
      buttons: ["OK"],
    };
    if (window) {
      await dialog.showMessageBox(window, options);
    } else {
      await dialog.showMessageBox(options);
    }
    return;
  }

  const options: MessageBoxOptions = {
    type: "warning",
    title: "pi-gui",
    message: "Could not check for updates right now.",
    detail: result.message,
    buttons: ["OK"],
  };
  if (window) {
    await dialog.showMessageBox(window, options);
  } else {
    await dialog.showMessageBox(options);
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
          id: OPEN_FOLDER_MENU_ITEM_ID,
          label: "Open Folder…",
          accelerator: "Command+O",
          click: () => {
            void pickWorkspaceViaDialog();
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

app.setName("pi");

app.whenReady().then(async () => {
  // On macOS, packaged builds already render the dock icon from `icon.icns`
  // in the app bundle. In dev we override the generic Electron dock icon with
  // the real PNG so the running app looks right end-to-end.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(appIcon);
  }

  const userDataDir = process.env.PI_APP_USER_DATA_DIR?.trim() || app.getPath("userData");
  let generateThreadTitleOverride:
    | ((workspace: WorkspaceRef, options: GenerateThreadTitleOptions) => Promise<string | null | undefined>)
    | undefined;
  let deferredThreadTitle:
    | {
        resolve: (title: string | null) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  store = new DesktopAppStore({
    userDataDir,
    initialWorkspacePaths: resolveInitialWorkspacePaths(),
    getWindow: () => mainWindow,
    generateThreadTitleOverride: async (workspace, options) => generateThreadTitleOverride?.(workspace, options),
  });
  await store.initialize();
  installApplicationMenu();
  if (process.env.PI_APP_TEST_MODE) {
    Object.assign(globalThis, {
      __PI_APP_TEST_HOOKS: {
        emitSessionEvent: (event: SessionDriverEvent) => store.emitTestSessionEvent(event),
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
  notificationManager = new NotificationManager(store, () => mainWindow);
  stopNotifications = notificationManager.start();
  if (!isDev) {
    stopUpdateChecker = initUpdateChecker();
  }

  ipcMain.handle(desktopIpc.ping, () =>
    devReloadMarkersEnabled ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}` : "pi desktop ready",
  );
  ipcMain.handle(desktopIpc.getThemeMode, () => themeManager.getMode());
  ipcMain.handle(desktopIpc.getResolvedTheme, () => themeManager.getResolvedTheme());
  ipcMain.handle(desktopIpc.setThemeMode, (_event, mode: ThemeMode) => {
    themeManager.setMode(mode);
    return mode;
  });
  ipcMain.handle(desktopIpc.openExternal, (_event, url: string) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Refusing to open unsupported URL: ${url}`);
    }
    return shell.openExternal(url);
  });
  ipcMain.handle(desktopIpc.stateRequest, () => store.getState());
  ipcMain.handle(desktopIpc.selectedTranscriptRequest, () => store.getSelectedTranscript());
  ipcMain.handle(desktopIpc.addWorkspacePath, (_event, workspacePath: string) => store.addWorkspace(workspacePath));
  ipcMain.handle(desktopIpc.pickWorkspace, () => pickWorkspaceViaDialog());
  ipcMain.handle(desktopIpc.selectWorkspace, (_event, workspaceId: string) => store.selectWorkspace(workspaceId));
  ipcMain.handle(desktopIpc.renameWorkspace, (_event, workspaceId: string, displayName: string) =>
    store.renameWorkspace(workspaceId, displayName),
  );
  ipcMain.handle(desktopIpc.removeWorkspace, (_event, workspaceId: string) => store.removeWorkspace(workspaceId));
  ipcMain.handle(desktopIpc.reorderWorkspaces, (_event, order: readonly string[]) => store.reorderWorkspaces(order));
  ipcMain.handle(desktopIpc.openWorkspaceInFinder, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await shell.openPath(workspacePath);
  });
  ipcMain.handle(desktopIpc.createWorktree, (_event, input: CreateWorktreeInput) =>
    store.createWorktree(input),
  );
  ipcMain.handle(desktopIpc.removeWorktree, (_event, input: RemoveWorktreeInput) =>
    store.removeWorktree(input),
  );
  ipcMain.handle(desktopIpc.syncCurrentWorkspace, () => store.syncCurrentWorkspace());
  ipcMain.handle(desktopIpc.selectSession, (_event, target: WorkspaceSessionTarget) =>
    store.selectSession(target),
  );
  ipcMain.handle(desktopIpc.archiveSession, (_event, target: WorkspaceSessionTarget) =>
    store.archiveSession(target),
  );
  ipcMain.handle(desktopIpc.unarchiveSession, (_event, target: WorkspaceSessionTarget) =>
    store.unarchiveSession(target),
  );
  ipcMain.handle(desktopIpc.setActiveView, (_event, activeView) => store.setActiveView(activeView));
  ipcMain.handle(desktopIpc.refreshRuntime, (_event, workspaceId?: string) => store.refreshRuntime(workspaceId));
  ipcMain.handle(desktopIpc.setModelSettingsScopeMode, (_event, mode) => store.setModelSettingsScopeMode(mode));
  ipcMain.handle(desktopIpc.setSessionModel, (_event, workspaceId: string, sessionId: string, provider: string, modelId: string) =>
    store.setSessionModel({ workspaceId, sessionId }, provider, modelId),
  );
  ipcMain.handle(desktopIpc.setDefaultModel, (_event, workspaceId: string, provider: string, modelId: string) =>
    store.setDefaultModel(workspaceId, provider, modelId),
  );
  ipcMain.handle(
    desktopIpc.setDefaultThinkingLevel,
    (_event, workspaceId: string, thinkingLevel) => store.setDefaultThinkingLevel(workspaceId, thinkingLevel),
  );
  ipcMain.handle(
    desktopIpc.setSessionThinkingLevel,
    (_event, workspaceId: string, sessionId: string, thinkingLevel) =>
      store.setSessionThinkingLevel({ workspaceId, sessionId }, thinkingLevel),
  );
  ipcMain.handle(desktopIpc.loginProvider, (_event, workspaceId: string, providerId: string) =>
    store.loginProvider(workspaceId, providerId, createRuntimeLoginCallbacks()),
  );
  ipcMain.handle(desktopIpc.logoutProvider, (_event, workspaceId: string, providerId: string) =>
    store.logoutProvider(workspaceId, providerId),
  );
  ipcMain.handle(desktopIpc.setProviderApiKey, (_event, workspaceId: string, providerId: string, apiKey: string) =>
    store.setProviderApiKey(workspaceId, providerId, apiKey),
  );
  ipcMain.handle(desktopIpc.setEnableSkillCommands, (_event, workspaceId: string, enabled: boolean) =>
    store.setEnableSkillCommands(workspaceId, enabled),
  );
  ipcMain.handle(desktopIpc.setScopedModelPatterns, (_event, workspaceId: string, patterns: readonly string[]) =>
    store.setScopedModelPatterns(workspaceId, patterns),
  );
  ipcMain.handle(desktopIpc.setSkillEnabled, (_event, workspaceId: string, filePath: string, enabled: boolean) =>
    store.setSkillEnabled(workspaceId, filePath, enabled),
  );
  ipcMain.handle(desktopIpc.setExtensionEnabled, (_event, workspaceId: string, filePath: string, enabled: boolean) =>
    store.setExtensionEnabled(workspaceId, filePath, enabled),
  );
  ipcMain.handle(desktopIpc.respondToHostUiRequest, (_event, workspaceId: string, sessionId: string, response) =>
    store.respondToHostUiRequest({ workspaceId, sessionId }, response),
  );
  ipcMain.handle(desktopIpc.setNotificationPreferences, (_event, preferences) =>
    store.setNotificationPreferences(preferences),
  );
  ipcMain.handle(desktopIpc.getNotificationPermissionStatus, () =>
    getNotificationPermissionStatus(mainWindow),
  );
  ipcMain.handle(desktopIpc.requestNotificationPermission, () =>
    requestNotificationPermission(mainWindow),
  );
  ipcMain.handle(desktopIpc.openSystemNotificationSettings, () => openSystemNotificationSettings());
  ipcMain.handle(desktopIpc.createSession, (_event, input: CreateSessionInput) =>
    store.createSession(input),
  );
  ipcMain.handle(desktopIpc.startThread, (_event, input: StartThreadInput) => store.startThread(input));
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
  ipcMain.handle(desktopIpc.cancelCurrentRun, () => store.cancelCurrentRun());
  ipcMain.handle(desktopIpc.pickComposerAttachments, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      title: "Attach files",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return store.getState();
    }
    const attachments = await Promise.all(result.filePaths.map(readComposerAttachment));
    return store.addComposerAttachments(attachments);
  });
  ipcMain.on(desktopIpc.readClipboardImage, (event) => {
    event.returnValue = readClipboardImageAttachment();
  });
  ipcMain.handle(desktopIpc.addComposerAttachments, (_event, attachments: readonly ComposerAttachment[]) => {
    const validated = attachments.flatMap(validateComposerAttachmentPayload);
    return store.addComposerAttachments(validated);
  });
  ipcMain.handle(desktopIpc.removeComposerAttachment, (_event, attachmentId: string) =>
    store.removeComposerAttachment(attachmentId),
  );
  ipcMain.handle(desktopIpc.editQueuedComposerMessage, (_event, messageId: string, currentDraft?: string) =>
    store.editQueuedComposerMessage(messageId, currentDraft),
  );
  ipcMain.handle(desktopIpc.cancelQueuedComposerEdit, () =>
    store.cancelQueuedComposerEdit(),
  );
  ipcMain.handle(desktopIpc.removeQueuedComposerMessage, (_event, messageId: string) =>
    store.removeQueuedComposerMessage(messageId),
  );
  ipcMain.handle(desktopIpc.steerQueuedComposerMessage, (_event, messageId: string) =>
    store.steerQueuedComposerMessage(messageId),
  );
  ipcMain.handle(desktopIpc.updateComposerDraft, (_event, composerDraft: string) =>
    store.updateComposerDraft(composerDraft),
  );
  ipcMain.handle(
    desktopIpc.submitComposer,
    (_event, text: string, options?: { readonly deliverAs?: "steer" | "followUp" }) => store.submitComposer(text, options),
  );
  ipcMain.handle(desktopIpc.getSessionTree, (_event, target: WorkspaceSessionTarget) =>
    store.getSessionTree(target),
  );
  ipcMain.handle(
    desktopIpc.navigateSessionTree,
    (_event, target: WorkspaceSessionTarget, targetId: string, options) =>
      store.navigateSessionTree(target, targetId, options),
  );
  ipcMain.handle(desktopIpc.listWorkspaceFiles, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return [];
    }
    return listWorkspaceFiles(workspacePath);
  });
  ipcMain.handle(desktopIpc.getChangedFiles, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return [];
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
  ipcMain.handle(desktopIpc.stageFile, async (_event, workspaceId: string, filePath: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await stageFile(workspacePath, filePath);
  });
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

  mainWindow = createWindow();
  notificationManager.trackWindow(mainWindow);
  themeManager.setWindow(mainWindow);
  attachStatePublisher(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      notificationManager?.trackWindow(mainWindow);
      themeManager.setWindow(mainWindow);
      attachStatePublisher(mainWindow);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopNotifications?.();
    stopNotifications = undefined;
    notificationManager = undefined;
    stopUpdateChecker?.();
    stopUpdateChecker = undefined;
    app.quit();
  }
});

app.on("before-quit", (event) => {
  stopNotifications?.();
  stopNotifications = undefined;
  notificationManager = undefined;
  stopUpdateChecker?.();
  stopUpdateChecker = undefined;
  if (quittingAfterStoreFlush || !store) {
    return;
  }

  event.preventDefault();
  quittingAfterStoreFlush = true;
  void store
    .flushPersistence()
    .catch(() => undefined)
    .finally(() => {
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

function resolveWindowTestMode(): "foreground" | "background" {
  return process.env.PI_APP_TEST_MODE?.trim().toLowerCase() === "background" ? "background" : "foreground";
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

function createRuntimeLoginCallbacks() {
  return {
    onAuth: async ({ url, instructions: _instructions }: { readonly url: string; readonly instructions?: string }) => {
      await shell.openExternal(url);
    },
    onPrompt: async ({ message, placeholder }: { readonly message: string; readonly placeholder?: string }) =>
      promptForText(message, placeholder),
  };
}

async function promptForText(message: string, placeholder = ""): Promise<string> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Main window is not available for login.");
  }
  window.show();
  window.focus();
  const result = await window.webContents.executeJavaScript(
    `window.prompt(${JSON.stringify(message)}, ${JSON.stringify(placeholder)})`,
    true,
  );
  if (typeof result !== "string" || result.trim().length === 0) {
    throw new Error("Login cancelled.");
  }
  return result.trim();
}
