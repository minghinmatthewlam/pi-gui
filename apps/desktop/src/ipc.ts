import type { ComposerImageAttachment, CreateSessionInput, DesktopAppState, WorkspaceSessionTarget } from "./desktop-state";

export const desktopIpc = {
  stateRequest: "pi-app:state-request",
  stateChanged: "pi-app:state-changed",
  addWorkspacePath: "pi-app:add-workspace-path",
  pickWorkspace: "pi-app:pick-workspace",
  selectWorkspace: "pi-app:select-workspace",
  syncCurrentWorkspace: "pi-app:sync-current-workspace",
  selectSession: "pi-app:select-session",
  createSession: "pi-app:create-session",
  cancelCurrentRun: "pi-app:cancel-current-run",
  pickComposerImages: "pi-app:pick-composer-images",
  addComposerImages: "pi-app:add-composer-images",
  removeComposerImage: "pi-app:remove-composer-image",
  updateComposerDraft: "pi-app:update-composer-draft",
  submitComposer: "pi-app:submit-composer",
  ping: "app:ping",
  openExternal: "app:open-external",
} as const;

export type PiDesktopStateListener = (state: DesktopAppState) => void;

export interface PiDesktopApi {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  ping(): Promise<string>;
  getState(): Promise<DesktopAppState>;
  onStateChanged(listener: PiDesktopStateListener): () => void;
  addWorkspacePath(path: string): Promise<DesktopAppState>;
  pickWorkspace(): Promise<DesktopAppState>;
  selectWorkspace(workspaceId: string): Promise<DesktopAppState>;
  syncCurrentWorkspace(): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  cancelCurrentRun(): Promise<DesktopAppState>;
  pickComposerImages(): Promise<DesktopAppState>;
  addComposerImages(attachments: readonly ComposerImageAttachment[]): Promise<DesktopAppState>;
  removeComposerImage(attachmentId: string): Promise<DesktopAppState>;
  updateComposerDraft(composerDraft: string): Promise<DesktopAppState>;
  submitComposer(text: string): Promise<DesktopAppState>;
  openExternal(url: string): Promise<void>;
}
