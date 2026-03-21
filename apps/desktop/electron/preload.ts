import { contextBridge, ipcRenderer } from "electron";
import { desktopIpc } from "../src/ipc";
import type { RuntimeSettingsSnapshot } from "@pi-app/session-driver/runtime-types";
import type {
  AppView,
  ComposerImageAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  NotificationPreferences,
  RemoveWorktreeInput,
  StartThreadInput,
  WorkspaceSessionTarget,
} from "../src/desktop-state";

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
  addWorkspacePath: (workspacePath: string) =>
    ipcRenderer.invoke(desktopIpc.addWorkspacePath, workspacePath) as Promise<DesktopAppState>,
  pickWorkspace: () => ipcRenderer.invoke(desktopIpc.pickWorkspace) as Promise<DesktopAppState>,
  selectWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.selectWorkspace, workspaceId) as Promise<DesktopAppState>,
  renameWorkspace: (workspaceId: string, displayName: string) =>
    ipcRenderer.invoke(desktopIpc.renameWorkspace, workspaceId, displayName) as Promise<DesktopAppState>,
  removeWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.removeWorkspace, workspaceId) as Promise<DesktopAppState>,
  openWorkspaceInFinder: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.openWorkspaceInFinder, workspaceId) as Promise<void>,
  createWorktree: (input: CreateWorktreeInput) =>
    ipcRenderer.invoke(desktopIpc.createWorktree, input) as Promise<DesktopAppState>,
  removeWorktree: (input: RemoveWorktreeInput) =>
    ipcRenderer.invoke(desktopIpc.removeWorktree, input) as Promise<DesktopAppState>,
  openSkillInFinder: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.openSkillInFinder, workspaceId, filePath) as Promise<void>,
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
  setNotificationPreferences: (preferences: Partial<NotificationPreferences>) =>
    ipcRenderer.invoke(desktopIpc.setNotificationPreferences, preferences) as Promise<DesktopAppState>,
  pickComposerImages: () => ipcRenderer.invoke(desktopIpc.pickComposerImages) as Promise<DesktopAppState>,
  addComposerImages: (attachments: readonly ComposerImageAttachment[]) =>
    ipcRenderer.invoke(desktopIpc.addComposerImages, attachments) as Promise<DesktopAppState>,
  removeComposerImage: (attachmentId: string) =>
    ipcRenderer.invoke(desktopIpc.removeComposerImage, attachmentId) as Promise<DesktopAppState>,
  updateComposerDraft: (composerDraft: string) =>
    ipcRenderer.invoke(desktopIpc.updateComposerDraft, composerDraft) as Promise<DesktopAppState>,
  submitComposer: (text: string) =>
    ipcRenderer.invoke(desktopIpc.submitComposer, text) as Promise<DesktopAppState>,
  toggleWindowMaximize: () => ipcRenderer.invoke(desktopIpc.toggleWindowMaximize) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke(desktopIpc.openExternal, url) as Promise<void>,
});
