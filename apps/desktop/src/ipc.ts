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
} from "./desktop-state";

export const desktopIpc = {
  stateRequest: "pi-app:state-request",
  stateChanged: "pi-app:state-changed",
  addWorkspacePath: "pi-app:add-workspace-path",
  pickWorkspace: "pi-app:pick-workspace",
  selectWorkspace: "pi-app:select-workspace",
  renameWorkspace: "pi-app:rename-workspace",
  removeWorkspace: "pi-app:remove-workspace",
  openWorkspaceInFinder: "pi-app:open-workspace-in-finder",
  createWorktree: "pi-app:create-worktree",
  removeWorktree: "pi-app:remove-worktree",
  openSkillInFinder: "pi-app:open-skill-in-finder",
  syncCurrentWorkspace: "pi-app:sync-current-workspace",
  selectSession: "pi-app:select-session",
  archiveSession: "pi-app:archive-session",
  unarchiveSession: "pi-app:unarchive-session",
  createSession: "pi-app:create-session",
  startThread: "pi-app:start-thread",
  cancelCurrentRun: "pi-app:cancel-current-run",
  setActiveView: "pi-app:set-active-view",
  refreshRuntime: "pi-app:refresh-runtime",
  setDefaultModel: "pi-app:set-default-model",
  setDefaultThinkingLevel: "pi-app:set-default-thinking-level",
  setSessionModel: "pi-app:set-session-model",
  setSessionThinkingLevel: "pi-app:set-session-thinking-level",
  loginProvider: "pi-app:login-provider",
  logoutProvider: "pi-app:logout-provider",
  setEnableSkillCommands: "pi-app:set-enable-skill-commands",
  setScopedModelPatterns: "pi-app:set-scoped-model-patterns",
  setSkillEnabled: "pi-app:set-skill-enabled",
  setNotificationPreferences: "pi-app:set-notification-preferences",
  pickComposerImages: "pi-app:pick-composer-images",
  addComposerImages: "pi-app:add-composer-images",
  removeComposerImage: "pi-app:remove-composer-image",
  updateComposerDraft: "pi-app:update-composer-draft",
  submitComposer: "pi-app:submit-composer",
  toggleWindowMaximize: "pi-app:toggle-window-maximize",
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
  renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState>;
  removeWorkspace(workspaceId: string): Promise<DesktopAppState>;
  openWorkspaceInFinder(workspaceId: string): Promise<void>;
  createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState>;
  removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState>;
  openSkillInFinder(workspaceId: string, filePath: string): Promise<void>;
  syncCurrentWorkspace(): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  startThread(input: StartThreadInput): Promise<DesktopAppState>;
  cancelCurrentRun(): Promise<DesktopAppState>;
  setActiveView(view: AppView): Promise<DesktopAppState>;
  refreshRuntime(workspaceId?: string): Promise<DesktopAppState>;
  setDefaultModel(workspaceId: string, provider: string, modelId: string): Promise<DesktopAppState>;
  setDefaultThinkingLevel(
    workspaceId: string,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<DesktopAppState>;
  setSessionModel(
    workspaceId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<DesktopAppState>;
  setSessionThinkingLevel(
    workspaceId: string,
    sessionId: string,
    thinkingLevel: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  ): Promise<DesktopAppState>;
  loginProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  logoutProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState>;
  setScopedModelPatterns(workspaceId: string, patterns: readonly string[]): Promise<DesktopAppState>;
  setSkillEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState>;
  setNotificationPreferences(preferences: Partial<NotificationPreferences>): Promise<DesktopAppState>;
  pickComposerImages(): Promise<DesktopAppState>;
  addComposerImages(attachments: readonly ComposerImageAttachment[]): Promise<DesktopAppState>;
  removeComposerImage(attachmentId: string): Promise<DesktopAppState>;
  updateComposerDraft(composerDraft: string): Promise<DesktopAppState>;
  submitComposer(text: string): Promise<DesktopAppState>;
  toggleWindowMaximize(): Promise<void>;
  openExternal(url: string): Promise<void>;
}
