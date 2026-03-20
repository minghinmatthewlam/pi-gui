import { contextBridge, ipcRenderer } from "electron";
import { desktopIpc } from "../src/ipc";
import type { ComposerImageAttachment, CreateSessionInput, DesktopAppState, WorkspaceSessionTarget } from "../src/desktop-state";

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
  syncCurrentWorkspace: () =>
    ipcRenderer.invoke(desktopIpc.syncCurrentWorkspace) as Promise<DesktopAppState>,
  selectSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.selectSession, target) as Promise<DesktopAppState>,
  createSession: (input: CreateSessionInput) =>
    ipcRenderer.invoke(desktopIpc.createSession, input) as Promise<DesktopAppState>,
  cancelCurrentRun: () => ipcRenderer.invoke(desktopIpc.cancelCurrentRun) as Promise<DesktopAppState>,
  pickComposerImages: () => ipcRenderer.invoke(desktopIpc.pickComposerImages) as Promise<DesktopAppState>,
  addComposerImages: (attachments: readonly ComposerImageAttachment[]) =>
    ipcRenderer.invoke(desktopIpc.addComposerImages, attachments) as Promise<DesktopAppState>,
  removeComposerImage: (attachmentId: string) =>
    ipcRenderer.invoke(desktopIpc.removeComposerImage, attachmentId) as Promise<DesktopAppState>,
  updateComposerDraft: (composerDraft: string) =>
    ipcRenderer.invoke(desktopIpc.updateComposerDraft, composerDraft) as Promise<DesktopAppState>,
  submitComposer: (text: string) =>
    ipcRenderer.invoke(desktopIpc.submitComposer, text) as Promise<DesktopAppState>,
  openExternal: (url: string) => ipcRenderer.invoke(desktopIpc.openExternal, url) as Promise<void>,
});
