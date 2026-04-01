import { contextBridge, ipcRenderer } from "electron";
import { PRELOAD_DEV_RELOAD_MARKER } from "./dev-reload-preload-probe";
import { desktopIpc, type PiDesktopCommand } from "../src/ipc";
import type { HostUiResponse } from "@pi-gui/session-driver";
import type { RuntimeSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  AppView,
  ComposerImageAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  NotificationPreferences,
  RemoveWorktreeInput,
  SelectedTranscriptRecord,
  StartThreadInput,
  WorkspaceSessionTarget,
} from "../src/desktop-state";

const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";

function resolveDevReloadMarkers() {
  if (!devReloadMarkersEnabled) {
    return undefined;
  }

  return {
    preload: PRELOAD_DEV_RELOAD_MARKER,
  };
}

const devReloadMarkers = resolveDevReloadMarkers();

if (devReloadMarkers) {
  contextBridge.exposeInMainWorld("__piDevReloadHost", devReloadMarkers);
}

contextBridge.exposeInMainWorld("piApp", {
  platform: process.platform,
  versions: process.versions,
  ping: () => ipcRenderer.invoke(desktopIpc.ping) as Promise<string>,
  getState: () => ipcRenderer.invoke(desktopIpc.stateRequest) as Promise<DesktopAppState>,
  onStateChanged: (listener: (state: DesktopAppState) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: DesktopAppState) => {
      listener(state);
    };
    ipcRenderer.on(desktopIpc.stateChanged, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.stateChanged, handle);
    };
  },
  getSelectedTranscript: () =>
    ipcRenderer.invoke(desktopIpc.selectedTranscriptRequest) as Promise<SelectedTranscriptRecord | null>,
  onSelectedTranscriptChanged: (listener: (payload: SelectedTranscriptRecord | null) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, payload: SelectedTranscriptRecord | null) => {
      listener(payload);
    };
    ipcRenderer.on(desktopIpc.selectedTranscriptChanged, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.selectedTranscriptChanged, handle);
    };
  },
  onCommand: (listener: (command: PiDesktopCommand) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, command: PiDesktopCommand) => {
      listener(command);
    };
    ipcRenderer.on(desktopIpc.appCommand, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.appCommand, handle);
    };
  },
  addWorkspacePath: (workspacePath: string) =>
    ipcRenderer.invoke(desktopIpc.addWorkspacePath, workspacePath) as Promise<DesktopAppState>,
  pickWorkspace: () => ipcRenderer.invoke(desktopIpc.pickWorkspace) as Promise<DesktopAppState>,
  selectWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.selectWorkspace, workspaceId) as Promise<DesktopAppState>,
  renameWorkspace: (workspaceId: string, displayName: string) =>
    ipcRenderer.invoke(desktopIpc.renameWorkspace, workspaceId, displayName) as Promise<DesktopAppState>,
  removeWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.removeWorkspace, workspaceId) as Promise<DesktopAppState>,
  reorderWorkspaces: (workspaceOrder: readonly string[]) =>
    ipcRenderer.invoke(desktopIpc.reorderWorkspaces, workspaceOrder) as Promise<DesktopAppState>,
  openWorkspaceInFinder: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.openWorkspaceInFinder, workspaceId) as Promise<void>,
  createWorktree: (input: CreateWorktreeInput) =>
    ipcRenderer.invoke(desktopIpc.createWorktree, input) as Promise<DesktopAppState>,
  removeWorktree: (input: RemoveWorktreeInput) =>
    ipcRenderer.invoke(desktopIpc.removeWorktree, input) as Promise<DesktopAppState>,
  openSkillInFinder: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.openSkillInFinder, workspaceId, filePath) as Promise<void>,
  openExtensionInFinder: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.openExtensionInFinder, workspaceId, filePath) as Promise<void>,
  syncCurrentWorkspace: () =>
    ipcRenderer.invoke(desktopIpc.syncCurrentWorkspace) as Promise<DesktopAppState>,
  selectSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.selectSession, target) as Promise<DesktopAppState>,
  archiveSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.archiveSession, target) as Promise<DesktopAppState>,
  unarchiveSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.unarchiveSession, target) as Promise<DesktopAppState>,
  createSession: (input: CreateSessionInput) =>
    ipcRenderer.invoke(desktopIpc.createSession, input) as Promise<DesktopAppState>,
  startThread: (input: StartThreadInput) =>
    ipcRenderer.invoke(desktopIpc.startThread, input) as Promise<DesktopAppState>,
  cancelCurrentRun: () => ipcRenderer.invoke(desktopIpc.cancelCurrentRun) as Promise<DesktopAppState>,
  setActiveView: (view: AppView) =>
    ipcRenderer.invoke(desktopIpc.setActiveView, view) as Promise<DesktopAppState>,
  refreshRuntime: (workspaceId?: string) =>
    ipcRenderer.invoke(desktopIpc.refreshRuntime, workspaceId) as Promise<DesktopAppState>,
  setModelSettingsScopeMode: (mode: "app-global" | "per-repo") =>
    ipcRenderer.invoke(desktopIpc.setModelSettingsScopeMode, mode) as Promise<DesktopAppState>,
  setDefaultModel: (workspaceId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke(desktopIpc.setDefaultModel, workspaceId, provider, modelId) as Promise<DesktopAppState>,
  setDefaultThinkingLevel: (workspaceId: string, thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) =>
    ipcRenderer.invoke(desktopIpc.setDefaultThinkingLevel, workspaceId, thinkingLevel) as Promise<DesktopAppState>,
  setSessionModel: (workspaceId: string, sessionId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke(desktopIpc.setSessionModel, workspaceId, sessionId, provider, modelId) as Promise<DesktopAppState>,
  setSessionThinkingLevel: (workspaceId: string, sessionId: string, thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) =>
    ipcRenderer.invoke(desktopIpc.setSessionThinkingLevel, workspaceId, sessionId, thinkingLevel) as Promise<DesktopAppState>,
  loginProvider: (workspaceId: string, providerId: string) =>
    ipcRenderer.invoke(desktopIpc.loginProvider, workspaceId, providerId) as Promise<DesktopAppState>,
  logoutProvider: (workspaceId: string, providerId: string) =>
    ipcRenderer.invoke(desktopIpc.logoutProvider, workspaceId, providerId) as Promise<DesktopAppState>,
  setEnableSkillCommands: (workspaceId: string, enabled: boolean) =>
    ipcRenderer.invoke(desktopIpc.setEnableSkillCommands, workspaceId, enabled) as Promise<DesktopAppState>,
  setScopedModelPatterns: (workspaceId: string, patterns: readonly string[]) =>
    ipcRenderer.invoke(desktopIpc.setScopedModelPatterns, workspaceId, patterns) as Promise<DesktopAppState>,
  setSkillEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
    ipcRenderer.invoke(desktopIpc.setSkillEnabled, workspaceId, filePath, enabled) as Promise<DesktopAppState>,
  setExtensionEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
    ipcRenderer.invoke(desktopIpc.setExtensionEnabled, workspaceId, filePath, enabled) as Promise<DesktopAppState>,
  respondToHostUiRequest: (workspaceId: string, sessionId: string, response: HostUiResponse) =>
    ipcRenderer.invoke(desktopIpc.respondToHostUiRequest, workspaceId, sessionId, response) as Promise<DesktopAppState>,
  setNotificationPreferences: (preferences: Partial<NotificationPreferences>) =>
    ipcRenderer.invoke(desktopIpc.setNotificationPreferences, preferences) as Promise<DesktopAppState>,
  pickComposerImages: () => ipcRenderer.invoke(desktopIpc.pickComposerImages) as Promise<DesktopAppState>,
  readClipboardImage: () => ipcRenderer.sendSync(desktopIpc.readClipboardImage) as ComposerImageAttachment | null,
  addComposerImages: (attachments: readonly ComposerImageAttachment[]) =>
    ipcRenderer.invoke(desktopIpc.addComposerImages, attachments) as Promise<DesktopAppState>,
  removeComposerImage: (attachmentId: string) =>
    ipcRenderer.invoke(desktopIpc.removeComposerImage, attachmentId) as Promise<DesktopAppState>,
  updateComposerDraft: (composerDraft: string) =>
    ipcRenderer.invoke(desktopIpc.updateComposerDraft, composerDraft) as Promise<DesktopAppState>,
  submitComposer: (text: string) =>
    ipcRenderer.invoke(desktopIpc.submitComposer, text) as Promise<DesktopAppState>,
  listWorkspaceFiles: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.listWorkspaceFiles, workspaceId) as Promise<string[]>,
  getChangedFiles: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.getChangedFiles, workspaceId) as Promise<{ path: string; status: "added" | "modified" | "deleted" | "untracked" }[]>,
  getFileDiff: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.getFileDiff, workspaceId, filePath) as Promise<string>,
  stageFile: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.stageFile, workspaceId, filePath) as Promise<void>,
  toggleWindowMaximize: () => ipcRenderer.invoke(desktopIpc.toggleWindowMaximize) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke(desktopIpc.openExternal, url) as Promise<void>,
  getThemeMode: () => ipcRenderer.invoke(desktopIpc.getThemeMode) as Promise<"system" | "light" | "dark">,
  getResolvedTheme: () => ipcRenderer.invoke(desktopIpc.getResolvedTheme) as Promise<"light" | "dark">,
  setThemeMode: (mode: "system" | "light" | "dark") =>
    ipcRenderer.invoke(desktopIpc.setThemeMode, mode) as Promise<string>,
  onThemeChanged: (callback: (theme: "light" | "dark") => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: "light" | "dark") => callback(theme);
    ipcRenderer.on(desktopIpc.themeChanged, handler);
    return () => {
      ipcRenderer.removeListener(desktopIpc.themeChanged, handler);
    };
  },
});
