import type { RuntimeSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  AppView,
  ComposerImageAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  ModelSettingsScopeMode,
  NotificationPreferences,
  RemoveWorktreeInput,
  SelectedTranscriptRecord,
  StartThreadInput,
  WorkspaceSessionTarget,
} from "./desktop-state";

export const desktopIpc = {
  stateRequest: "pi-gui:state-request",
  stateChanged: "pi-gui:state-changed",
  selectedTranscriptRequest: "pi-gui:selected-transcript-request",
  selectedTranscriptChanged: "pi-gui:selected-transcript-changed",
  appCommand: "pi-gui:app-command",
  addWorkspacePath: "pi-gui:add-workspace-path",
  pickWorkspace: "pi-gui:pick-workspace",
  selectWorkspace: "pi-gui:select-workspace",
  renameWorkspace: "pi-gui:rename-workspace",
  removeWorkspace: "pi-gui:remove-workspace",
  reorderWorkspaces: "pi-gui:reorder-workspaces",
  openWorkspaceInFinder: "pi-gui:open-workspace-in-finder",
  createWorktree: "pi-gui:create-worktree",
  removeWorktree: "pi-gui:remove-worktree",
  openSkillInFinder: "pi-gui:open-skill-in-finder",
  openExtensionInFinder: "pi-gui:open-extension-in-finder",
  syncCurrentWorkspace: "pi-gui:sync-current-workspace",
  selectSession: "pi-gui:select-session",
  archiveSession: "pi-gui:archive-session",
  unarchiveSession: "pi-gui:unarchive-session",
  createSession: "pi-gui:create-session",
  startThread: "pi-gui:start-thread",
  cancelCurrentRun: "pi-gui:cancel-current-run",
  setActiveView: "pi-gui:set-active-view",
  refreshRuntime: "pi-gui:refresh-runtime",
  setModelSettingsScopeMode: "pi-gui:set-model-settings-scope-mode",
  setDefaultModel: "pi-gui:set-default-model",
  setDefaultThinkingLevel: "pi-gui:set-default-thinking-level",
  setSessionModel: "pi-gui:set-session-model",
  setSessionThinkingLevel: "pi-gui:set-session-thinking-level",
  loginProvider: "pi-gui:login-provider",
  logoutProvider: "pi-gui:logout-provider",
  setEnableSkillCommands: "pi-gui:set-enable-skill-commands",
  setScopedModelPatterns: "pi-gui:set-scoped-model-patterns",
  setSkillEnabled: "pi-gui:set-skill-enabled",
  setExtensionEnabled: "pi-gui:set-extension-enabled",
  respondToHostUiRequest: "pi-gui:respond-to-host-ui-request",
  setNotificationPreferences: "pi-gui:set-notification-preferences",
  pickComposerImages: "pi-gui:pick-composer-images",
  readClipboardImage: "pi-gui:read-clipboard-image",
  addComposerImages: "pi-gui:add-composer-images",
  removeComposerImage: "pi-gui:remove-composer-image",
  updateComposerDraft: "pi-gui:update-composer-draft",
  submitComposer: "pi-gui:submit-composer",
  toggleWindowMaximize: "pi-gui:toggle-window-maximize",
  listWorkspaceFiles: "pi-gui:list-workspace-files",
  getChangedFiles: "pi-gui:get-changed-files",
  getFileDiff: "pi-gui:get-file-diff",
  stageFile: "pi-gui:stage-file",
  getThemeMode: "pi-gui:get-theme-mode",
  getResolvedTheme: "pi-gui:get-resolved-theme",
  setThemeMode: "pi-gui:set-theme-mode",
  themeChanged: "pi-gui:theme-changed",
  ping: "app:ping",
  openExternal: "app:open-external",
} as const;

export const desktopCommands = {
  openSettings: "open-settings",
  openNewThread: "open-new-thread",
} as const;

export type PiDesktopStateListener = (state: DesktopAppState) => void;
export type PiDesktopSelectedTranscriptListener = (payload: SelectedTranscriptRecord | null) => void;
export type PiDesktopCommand = (typeof desktopCommands)[keyof typeof desktopCommands];

export interface DesktopShortcutInput {
  readonly modifier: boolean;
  readonly shift: boolean;
  readonly key: string;
  readonly code?: string;
}

export function getDesktopCommandFromShortcut(input: DesktopShortcutInput): PiDesktopCommand | undefined {
  if (!input.modifier) {
    return undefined;
  }

  const lowerKey = input.key.toLowerCase();
  const isComma = input.key === "," || input.code === "Comma";
  const isShiftO = input.shift && (lowerKey === "o" || input.code === "KeyO");

  if (!input.shift && isComma) {
    return desktopCommands.openSettings;
  }

  if (isShiftO) {
    return desktopCommands.openNewThread;
  }

  return undefined;
}

export interface PiDesktopApi {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  ping(): Promise<string>;
  getState(): Promise<DesktopAppState>;
  onStateChanged(listener: PiDesktopStateListener): () => void;
  getSelectedTranscript(): Promise<SelectedTranscriptRecord | null>;
  onSelectedTranscriptChanged(listener: PiDesktopSelectedTranscriptListener): () => void;
  onCommand(listener: (command: PiDesktopCommand) => void): () => void;
  addWorkspacePath(path: string): Promise<DesktopAppState>;
  pickWorkspace(): Promise<DesktopAppState>;
  selectWorkspace(workspaceId: string): Promise<DesktopAppState>;
  renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState>;
  removeWorkspace(workspaceId: string): Promise<DesktopAppState>;
  reorderWorkspaces(workspaceOrder: readonly string[]): Promise<DesktopAppState>;
  openWorkspaceInFinder(workspaceId: string): Promise<void>;
  createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState>;
  removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState>;
  openSkillInFinder(workspaceId: string, filePath: string): Promise<void>;
  openExtensionInFinder(workspaceId: string, filePath: string): Promise<void>;
  syncCurrentWorkspace(): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  startThread(input: StartThreadInput): Promise<DesktopAppState>;
  cancelCurrentRun(): Promise<DesktopAppState>;
  setActiveView(view: AppView): Promise<DesktopAppState>;
  refreshRuntime(workspaceId?: string): Promise<DesktopAppState>;
  setModelSettingsScopeMode(mode: ModelSettingsScopeMode): Promise<DesktopAppState>;
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
  setExtensionEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState>;
  respondToHostUiRequest(
    workspaceId: string,
    sessionId: string,
    response:
      | { readonly requestId: string; readonly value: string }
      | { readonly requestId: string; readonly confirmed: boolean }
      | { readonly requestId: string; readonly cancelled: true },
  ): Promise<DesktopAppState>;
  setNotificationPreferences(preferences: Partial<NotificationPreferences>): Promise<DesktopAppState>;
  pickComposerImages(): Promise<DesktopAppState>;
  readClipboardImage(): ComposerImageAttachment | null;
  addComposerImages(attachments: readonly ComposerImageAttachment[]): Promise<DesktopAppState>;
  removeComposerImage(attachmentId: string): Promise<DesktopAppState>;
  updateComposerDraft(composerDraft: string): Promise<DesktopAppState>;
  submitComposer(text: string): Promise<DesktopAppState>;
  listWorkspaceFiles(workspaceId: string): Promise<string[]>;
  getChangedFiles(workspaceId: string): Promise<{ path: string; status: "added" | "modified" | "deleted" | "untracked" }[]>;
  getFileDiff(workspaceId: string, filePath: string): Promise<string>;
  stageFile(workspaceId: string, filePath: string): Promise<void>;
  toggleWindowMaximize(): Promise<void>;
  openExternal(url: string): Promise<void>;
  getThemeMode(): Promise<"system" | "light" | "dark">;
  getResolvedTheme(): Promise<"light" | "dark">;
  setThemeMode(mode: "system" | "light" | "dark"): Promise<string>;
  onThemeChanged(callback: (theme: "light" | "dark") => void): () => void;
}
