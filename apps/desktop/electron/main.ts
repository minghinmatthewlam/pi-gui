import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopAppStore } from "./app-store";
import { desktopIpc } from "../src/ipc";
import type { CreateSessionInput, WorkspaceSessionTarget } from "../src/desktop-state";

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let store: DesktopAppStore;
let mainWindow: BrowserWindow | null = null;
let stopPublishingState: (() => void) | undefined;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#f3f4f8",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  if (isDev) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    if (process.env.PI_APP_OPEN_DEVTOOLS !== "0") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    const indexPath = path.join(app.getAppPath(), "dist", "index.html");
    void window.loadURL(pathToFileURL(indexPath).toString());
  }

  return window;
}

function attachStatePublisher(window: BrowserWindow): void {
  stopPublishingState?.();
  stopPublishingState = store.subscribe((state) => {
    if (!window.isDestroyed()) {
      window.webContents.send(desktopIpc.stateChanged, state);
    }
  });
  window.once("closed", () => {
    stopPublishingState?.();
    stopPublishingState = undefined;
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
}

app.setName("pi");

app.whenReady().then(async () => {
  const userDataDir = process.env.PI_APP_USER_DATA_DIR?.trim() || app.getPath("userData");
  store = new DesktopAppStore({
    userDataDir,
    initialWorkspacePaths: resolveInitialWorkspacePaths(),
  });
  await store.initialize();

  ipcMain.handle(desktopIpc.ping, () => "pi desktop ready");
  ipcMain.handle(desktopIpc.openExternal, (_event, url: string) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Refusing to open unsupported URL: ${url}`);
    }
    return shell.openExternal(url);
  });
  ipcMain.handle(desktopIpc.stateRequest, () => store.getState());
  ipcMain.handle(desktopIpc.addWorkspacePath, (_event, workspacePath: string) => store.addWorkspace(workspacePath));
  ipcMain.handle(desktopIpc.pickWorkspace, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Open workspace folder",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return store.getState();
    }
    return store.addWorkspace(result.filePaths[0] as string);
  });
  ipcMain.handle(desktopIpc.selectWorkspace, (_event, workspaceId: string) => store.selectWorkspace(workspaceId));
  ipcMain.handle(desktopIpc.syncCurrentWorkspace, () => store.syncCurrentWorkspace());
  ipcMain.handle(desktopIpc.selectSession, (_event, target: WorkspaceSessionTarget) =>
    store.selectSession(target),
  );
  ipcMain.handle(desktopIpc.createSession, (_event, input: CreateSessionInput) =>
    store.createSession(input),
  );
  ipcMain.handle(desktopIpc.cancelCurrentRun, () => store.cancelCurrentRun());
  ipcMain.handle(desktopIpc.updateComposerDraft, (_event, composerDraft: string) =>
    store.updateComposerDraft(composerDraft),
  );
  ipcMain.handle(desktopIpc.submitComposer, (_event, text: string) => store.submitComposer(text));

  mainWindow = createWindow();
  attachStatePublisher(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      attachStatePublisher(mainWindow);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
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
