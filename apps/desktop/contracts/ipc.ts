import type {
  ExtensionViewOpenFile,
  DesktopExtensionViewInfo,
  OpenExtensionViewInput,
  ExtensionViewConnection,
  ExtensionViewMessage,
  ExtensionViewCatalogChange,
} from "./extension-views";
import type { RuntimeSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from "@pi-gui/session-driver/types";
import type { ClipboardImageRead } from "./composer-attachments";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { SaveTaskWorkbenchTemplateInput, TaskWorkbenchTemplate } from "./workbench";
import type {
  ResolveTurnReviewInput,
  ResolveTurnReviewResult,
  GetReviewInput,
  ReviewResult,
  ReviewFileInput,
  ReviewFileResult,
  SetReviewFileReviewedInput,
  SetReviewFileReviewedResult,
  ChangeReviewFileStageInput,
  ChangeReviewFileStageResult,
} from "./review";
import type {
  AppView,
  ComposerAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  ForkThreadInput,
  ModelSettingsScopeMode,
  NotificationPreferences,
  RemoveWorktreeInput,
  SendChildThreadFollowUpInput,
  SetChildSupervisionLoopInput,
  SelectedTranscriptRecord,
  StartThreadInput,
  ThemePresetId,
  ThreadGrouping,
  WorkspaceSessionTarget,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from "./desktop-state";

export type DesktopNotificationPermissionStatus =
  "granted" | "denied" | "default" | "unsupported" | "unknown";

export interface CustomProviderModelConfig {
  readonly id: string;
  readonly contextWindow?: number;
}

export interface CustomProviderConfig {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelConfig[];
}

export interface CustomProviderProbeInput {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export type CustomProviderProbeResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly error: string };

export const desktopIpc = {
  extensionViewOpenFile: "pi-gui:extension-view-open-file",
  listExtensionViews: "pi-gui:list-extension-views",
  openExtensionView: "pi-gui:open-extension-view",
  sendExtensionViewMessage: "pi-gui:send-extension-view-message",
  closeExtensionView: "pi-gui:close-extension-view",
  extensionViewMessage: "pi-gui:extension-view-message",
  extensionViewCatalogChanged: "pi-gui:extension-view-catalog-changed",
  stateRequest: "pi-gui:state-request",
  stateChanged: "pi-gui:state-changed",
  getTaskWorkbenchTemplate: "pi-gui:get-task-workbench-template",
  saveTaskWorkbenchTemplate: "pi-gui:save-task-workbench-template",
  selectedTranscriptRequest: "pi-gui:selected-transcript-request",
  selectedTranscriptChanged: "pi-gui:selected-transcript-changed",
  appCommand: "pi-gui:app-command",
  workspacePicked: "pi-gui:workspace-picked",
  clipboardImagePasted: "pi-gui:clipboard-image-pasted",
  addWorkspacePath: "pi-gui:add-workspace-path",
  pickWorkspace: "pi-gui:pick-workspace",
  selectWorkspace: "pi-gui:select-workspace",
  renameWorkspace: "pi-gui:rename-workspace",
  removeWorkspace: "pi-gui:remove-workspace",
  reorderWorkspaces: "pi-gui:reorder-workspaces",
  reorderPinnedSessions: "pi-gui:reorder-pinned-sessions",
  openWorkspaceInFinder: "pi-gui:open-workspace-in-finder",
  createWorktree: "pi-gui:create-worktree",
  removeWorktree: "pi-gui:remove-worktree",
  openSkillInFinder: "pi-gui:open-skill-in-finder",
  openExtensionInFinder: "pi-gui:open-extension-in-finder",
  syncCurrentWorkspace: "pi-gui:sync-current-workspace",
  selectSession: "pi-gui:select-session",
  renameSession: "pi-gui:rename-session",
  archiveSession: "pi-gui:archive-session",
  unarchiveSession: "pi-gui:unarchive-session",
  markSessionRead: "pi-gui:mark-session-read",
  setSessionPinned: "pi-gui:set-session-pinned",
  createSession: "pi-gui:create-session",
  startThread: "pi-gui:start-thread",
  forkThread: "pi-gui:fork-thread",
  sendChildThreadFollowUp: "pi-gui:send-child-thread-follow-up",
  setChildSupervisionLoop: "pi-gui:set-child-supervision-loop",
  createScheduledTask: "pi-gui:create-scheduled-task",
  updateScheduledTask: "pi-gui:update-scheduled-task",
  deleteScheduledTask: "pi-gui:delete-scheduled-task",
  beginScheduledTaskInterview: "pi-gui:begin-scheduled-task-interview",
  cancelCurrentRun: "pi-gui:cancel-current-run",
  setActiveView: "pi-gui:set-active-view",
  setSidebarCollapsed: "pi-gui:set-sidebar-collapsed",
  setThreadGrouping: "pi-gui:set-thread-grouping",
  refreshRuntime: "pi-gui:refresh-runtime",
  setModelSettingsScopeMode: "pi-gui:set-model-settings-scope-mode",
  setDefaultModel: "pi-gui:set-default-model",
  setDefaultThinkingLevel: "pi-gui:set-default-thinking-level",
  setSessionModel: "pi-gui:set-session-model",
  setSessionThinkingLevel: "pi-gui:set-session-thinking-level",
  loginProvider: "pi-gui:login-provider",
  logoutProvider: "pi-gui:logout-provider",
  setProviderApiKey: "pi-gui:set-provider-api-key",
  listCustomProviders: "pi-gui:list-custom-providers",
  setCustomProvider: "pi-gui:set-custom-provider",
  deleteCustomProvider: "pi-gui:delete-custom-provider",
  probeCustomProviderModels: "pi-gui:probe-custom-provider-models",
  setEnableSkillCommands: "pi-gui:set-enable-skill-commands",
  setScopedModelPatterns: "pi-gui:set-scoped-model-patterns",
  setSkillEnabled: "pi-gui:set-skill-enabled",
  setExtensionEnabled: "pi-gui:set-extension-enabled",
  respondToHostUiRequest: "pi-gui:respond-to-host-ui-request",
  setNotificationPreferences: "pi-gui:set-notification-preferences",
  setIntegratedTerminalShell: "pi-gui:set-integrated-terminal-shell",
  setEnableTransparency: "pi-gui:set-enable-transparency",
  terminalEnsurePanel: "pi-gui:terminal-ensure-panel",
  terminalCreateSession: "pi-gui:terminal-create-session",
  terminalSetActiveSession: "pi-gui:terminal-set-active-session",
  terminalWrite: "pi-gui:terminal-write",
  terminalResize: "pi-gui:terminal-resize",
  terminalRestartSession: "pi-gui:terminal-restart-session",
  terminalCloseSession: "pi-gui:terminal-close-session",
  terminalSetTitle: "pi-gui:terminal-set-title",
  terminalSetFocused: "pi-gui:terminal-set-focused",
  sidePanelSetFocused: "pi-gui:side-panel-set-focused",
  terminalData: "pi-gui:terminal-data",
  terminalExit: "pi-gui:terminal-exit",
  terminalError: "pi-gui:terminal-error",
  getNotificationPermissionStatus: "pi-gui:get-notification-permission-status",
  requestNotificationPermission: "pi-gui:request-notification-permission",
  openSystemNotificationSettings: "pi-gui:open-system-notification-settings",
  notificationPermissionStatusChanged: "pi-gui:notification-permission-status-changed",
  pickComposerAttachments: "pi-gui:pick-composer-attachments",
  readClipboardImage: "pi-gui:read-clipboard-image",
  addComposerAttachments: "pi-gui:add-composer-attachments",
  removeComposerAttachment: "pi-gui:remove-composer-attachment",
  editQueuedComposerMessage: "pi-gui:edit-queued-composer-message",
  cancelQueuedComposerEdit: "pi-gui:cancel-queued-composer-edit",
  removeQueuedComposerMessage: "pi-gui:remove-queued-composer-message",
  steerQueuedComposerMessage: "pi-gui:steer-queued-composer-message",
  persistComposerDraft: "pi-gui:persist-composer-draft",
  updateComposerDraft: "pi-gui:update-composer-draft",
  submitComposer: "pi-gui:submit-composer",
  getSessionTree: "pi-gui:get-session-tree",
  navigateSessionTree: "pi-gui:navigate-session-tree",
  toggleWindowMaximize: "pi-gui:toggle-window-maximize",
  listWorkspaceFiles: "pi-gui:list-workspace-files",
  readWorkspaceFile: "pi-gui:read-workspace-file",
  revealWorkspaceFile: "pi-gui:reveal-workspace-file",
  getChangedFiles: "pi-gui:get-changed-files",
  getFileDiff: "pi-gui:get-file-diff",
  stageFile: "pi-gui:stage-file",
  resolveTurnReview: "pi-gui:resolve-turn-review",
  getReview: "pi-gui:get-review",
  getReviewFile: "pi-gui:get-review-file",
  setReviewFileReviewed: "pi-gui:set-review-file-reviewed",
  changeReviewFileStage: "pi-gui:change-review-file-stage",
  getThemeMode: "pi-gui:get-theme-mode",
  getResolvedTheme: "pi-gui:get-resolved-theme",
  setThemeMode: "pi-gui:set-theme-mode",
  setThemePresetId: "pi-gui:set-theme-preset-id",
  themeChanged: "pi-gui:theme-changed",
  ping: "app:ping",
  openExternal: "app:open-external",
  relaunchApplication: "pi-gui:relaunch-application",
} as const;

export const desktopCommands = {
  openSettings: "open-settings",
  openNewThread: "open-new-thread",
  toggleTerminal: "toggle-terminal",
  toggleSidePanel: "toggle-side-panel",
  toggleChanges: "toggle-changes",
  closeFocusedSurface: "close-focused-surface",
  toggleSidebar: "toggle-sidebar",
  openCommandPalette: "open-command-palette",
  openFilePalette: "open-file-palette",
  selectRecentThread1: "select-recent-thread-1",
  selectRecentThread2: "select-recent-thread-2",
  selectRecentThread3: "select-recent-thread-3",
  selectRecentThread4: "select-recent-thread-4",
  selectRecentThread5: "select-recent-thread-5",
  selectRecentThread6: "select-recent-thread-6",
  selectRecentThread7: "select-recent-thread-7",
  selectRecentThread8: "select-recent-thread-8",
  selectRecentThread9: "select-recent-thread-9",
} as const;

const RECENT_THREAD_COMMANDS = [
  desktopCommands.selectRecentThread1,
  desktopCommands.selectRecentThread2,
  desktopCommands.selectRecentThread3,
  desktopCommands.selectRecentThread4,
  desktopCommands.selectRecentThread5,
  desktopCommands.selectRecentThread6,
  desktopCommands.selectRecentThread7,
  desktopCommands.selectRecentThread8,
  desktopCommands.selectRecentThread9,
] as const;

export const THREAD_SHORTCUT_SLOT_COUNT = RECENT_THREAD_COMMANDS.length;

export function getDesktopShortcutLabel(platform: NodeJS.Platform, key: string): string {
  return `${platform === "darwin" ? "⌘" : "Ctrl+"}${key.toUpperCase()}`;
}

export function getSidePanelToggleShortcutLabel(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "⌘⌥B" : "Ctrl+Alt+B";
}

export type PiDesktopStateListener = (state: DesktopAppState) => void;
export type PiDesktopSelectedTranscriptListener = (
  payload: SelectedTranscriptRecord | null,
) => void;
export type PiDesktopCommand = (typeof desktopCommands)[keyof typeof desktopCommands];

export function recentThreadShortcutIndex(command: PiDesktopCommand): number | undefined {
  const index = (RECENT_THREAD_COMMANDS as readonly string[]).indexOf(command);
  return index >= 0 ? index : undefined;
}

export type ChangedFileStatus =
  "added" | "copied" | "deleted" | "modified" | "renamed" | "untracked";

export interface ChangedFileEntry {
  readonly path: string;
  readonly previousPath?: string;
  readonly stagingSourcePath?: string;
  readonly status: ChangedFileStatus;
  readonly staged: boolean;
}

export type ChangedFilesErrorCode =
  "git-status-failed" | "git-status-invalid" | "workspace-unavailable";

export interface ChangedFilesError {
  readonly code: ChangedFilesErrorCode;
  readonly message: string;
}

export type ChangedFilesResult =
  | {
      readonly state: "available";
      readonly files: readonly ChangedFileEntry[];
    }
  | {
      readonly state: "unavailable";
      readonly error: ChangedFilesError;
    };

export interface WorkspaceFilePreview {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly sizeBytes: number;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export type TerminalSessionStatus = "running" | "exited" | "error";

export interface TerminalSessionSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly title: string;
  readonly status: TerminalSessionStatus;
  readonly replay: string;
  readonly truncated: boolean;
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface TerminalPanelSnapshot {
  readonly workspaceId: string;
  readonly rootKey: string;
  readonly activeSessionId: string;
  readonly sessions: readonly TerminalSessionSnapshot[];
}

export interface TerminalDataEvent {
  readonly terminalId: string;
  readonly data: string;
}

export interface TerminalExitEvent {
  readonly terminalId: string;
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface TerminalErrorEvent {
  readonly terminalId: string;
  readonly message: string;
}

export interface DesktopShortcutInput {
  readonly modifier: boolean;
  readonly alt?: boolean;
  readonly shift: boolean;
  readonly key: string;
  readonly code?: string;
}

/** Command on macOS, Control on Windows and Linux. */
export function platformShortcutModifier(
  platform: NodeJS.Platform,
  input: { readonly meta: boolean; readonly control: boolean },
): boolean {
  return platform === "darwin" ? input.meta : input.control;
}

const MAX_QUEUED_DESKTOP_COMMANDS = 16;

/**
 * Delivers main-process shortcuts to the renderer.
 * A chord can arrive before React subscribes, or in the gap while a listener
 * is swapped. Those commands are kept until the next subscriber.
 */
export function createDesktopCommandSubscription() {
  let listener: ((command: PiDesktopCommand) => void) | null = null;
  const queued: PiDesktopCommand[] = [];
  return {
    subscribe(next: (command: PiDesktopCommand) => void): () => void {
      listener = next;
      const pending = queued.splice(0, queued.length);
      for (const command of pending) next(command);
      return () => {
        if (listener === next) listener = null;
      };
    },
    deliver(command: PiDesktopCommand): void {
      if (listener) {
        listener(command);
        return;
      }
      queued.push(command);
      if (queued.length > MAX_QUEUED_DESKTOP_COMMANDS) queued.shift();
    },
  };
}

/** Collapses a repeated keydown from one physical chord so a toggle stays open. */
export const SEARCH_CHORD_TOGGLE_MS = 200;
export const CHANGES_TOGGLE_DEDUPE_MS = 8;

export function createChordToggleGate(windowMs = SEARCH_CHORD_TOGGLE_MS) {
  let last = Number.NEGATIVE_INFINITY;
  return (now: number): boolean => {
    if (now - last < windowMs) return false;
    last = now;
    return true;
  };
}

export interface EarlyModifierChord {
  readonly key: string;
  readonly code: string;
}

function isBufferedModifierChord(key: string, code?: string): boolean {
  const lower = key.toLowerCase();
  if (lower === "f" || code === "KeyF") return true;
  if (lower === "," || code === "Comma") return true;
  if (lower === "d" || code === "KeyD") return true;
  return /^[1-9]$/.test(key) || /^Digit[1-9]$/.test(code ?? "");
}

/**
 * Keeps Command/Ctrl chords that arrive before the React shortcut listener
 * exists. Search, settings, Changes, and thread digits are replayed.
 */
export function createEarlyModifierChordBuffer() {
  const pending: EarlyModifierChord[] = [];
  let ready = false;
  return {
    note(
      input: EarlyModifierChord & { readonly modifier: boolean; readonly shift: boolean },
    ): void {
      if (ready || !input.modifier || input.shift) return;
      if (!isBufferedModifierChord(input.key, input.code)) return;
      pending.push({ key: input.key, code: input.code });
      if (pending.length > 8) pending.shift();
    },
    arm(): readonly EarlyModifierChord[] {
      ready = true;
      return pending.splice(0, pending.length);
    },
  };
}

export const earlyModifierChords = createEarlyModifierChordBuffer();

export function getDesktopCommandFromShortcut(
  input: DesktopShortcutInput,
): PiDesktopCommand | undefined {
  if (!input.modifier) {
    return undefined;
  }

  const lowerKey = input.key.toLowerCase();
  const isComma = input.key === "," || input.code === "Comma";
  const isB = lowerKey === "b" || input.code === "KeyB";
  const isJ = lowerKey === "j" || input.code === "KeyJ";
  const isD = lowerKey === "d" || input.code === "KeyD";
  const isK = lowerKey === "k" || input.code === "KeyK";
  const isP = lowerKey === "p" || input.code === "KeyP";
  const isShiftO = input.shift && (lowerKey === "o" || input.code === "KeyO");

  if (input.alt) {
    if (!input.shift && isB) {
      return desktopCommands.toggleSidePanel;
    }
    return undefined;
  }

  if (!input.shift && isComma) {
    return desktopCommands.openSettings;
  }

  if (!input.shift && isJ) {
    return desktopCommands.toggleTerminal;
  }

  if (!input.shift && isD) {
    return desktopCommands.toggleChanges;
  }

  if (!input.shift && isB) {
    return desktopCommands.toggleSidebar;
  }

  if (!input.shift && isK) {
    return desktopCommands.openCommandPalette;
  }

  if (!input.shift && isP) {
    return desktopCommands.openFilePalette;
  }

  if (isShiftO) {
    return desktopCommands.openNewThread;
  }

  if (!input.shift) {
    const digitFromKey = /^[1-9]$/.test(input.key) ? input.key : undefined;
    const digitFromCode = input.code?.match(/^Digit([1-9])$/)?.[1];
    const digit = digitFromKey ?? digitFromCode;
    if (digit) {
      return RECENT_THREAD_COMMANDS[Number(digit) - 1];
    }
  }

  return undefined;
}

/**
 * Callers accept palette commands only from the platform modifier, so macOS
 * Control+K and Control+P stay with text fields, and only from a first press.
 */
export function isPaletteCommand(command: PiDesktopCommand | undefined): boolean {
  return (
    command === desktopCommands.openCommandPalette || command === desktopCommands.openFilePalette
  );
}

export function isCloseFocusedSurfaceShortcut(input: {
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string;
  readonly code?: string;
  readonly platform: NodeJS.Platform;
}): boolean {
  if (input.alt || input.shift) {
    return false;
  }
  const platformModifier = input.platform === "darwin" ? input.meta : input.control;
  const otherModifier = input.platform === "darwin" ? input.control : input.meta;
  if (!platformModifier || otherModifier) {
    return false;
  }
  return input.key.toLowerCase() === "w" || input.code === "KeyW";
}

export interface PiDesktopApi {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  ping(): Promise<string>;
  getState(): Promise<DesktopAppState>;
  getTaskWorkbenchTemplate(target: SessionRef): Promise<TaskWorkbenchTemplate | null>;
  saveTaskWorkbenchTemplate(input: SaveTaskWorkbenchTemplateInput): Promise<void>;
  onStateChanged(listener: PiDesktopStateListener): () => void;
  getSelectedTranscript(): Promise<SelectedTranscriptRecord | null>;
  onSelectedTranscriptChanged(listener: PiDesktopSelectedTranscriptListener): () => void;
  onCommand(listener: (command: PiDesktopCommand) => void): () => void;
  onWorkspacePicked(listener: (workspaceId: string) => void): () => void;
  onClipboardImagePasted(listener: (result: ClipboardImageRead) => void): () => void;
  getPathForFile(file: File): string;
  addWorkspacePath(path: string): Promise<DesktopAppState>;
  pickWorkspace(): Promise<DesktopAppState>;
  selectWorkspace(workspaceId: string): Promise<DesktopAppState>;
  renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState>;
  removeWorkspace(workspaceId: string): Promise<DesktopAppState>;
  reorderWorkspaces(workspaceOrder: readonly string[]): Promise<DesktopAppState>;
  reorderPinnedSessions(pinnedSessionOrder: readonly string[]): Promise<DesktopAppState>;
  openWorkspaceInFinder(workspaceId: string): Promise<void>;
  createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState>;
  removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState>;
  openSkillInFinder(workspaceId: string, filePath: string): Promise<void>;
  openExtensionInFinder(workspaceId: string, filePath: string): Promise<void>;
  syncCurrentWorkspace(): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  renameSession(target: WorkspaceSessionTarget, title: string): Promise<DesktopAppState>;
  archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  markSessionRead(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  setSessionPinned(target: WorkspaceSessionTarget, pinned: boolean): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  startThread(input: StartThreadInput): Promise<DesktopAppState>;
  forkThread(input: ForkThreadInput): Promise<DesktopAppState>;
  sendChildThreadFollowUp(input: SendChildThreadFollowUpInput): Promise<DesktopAppState>;
  setChildSupervisionLoop(input: SetChildSupervisionLoopInput): Promise<DesktopAppState>;
  createScheduledTask(input: CreateScheduledTaskInput): Promise<DesktopAppState>;
  updateScheduledTask(id: string, patch: UpdateScheduledTaskInput): Promise<DesktopAppState>;
  deleteScheduledTask(id: string): Promise<DesktopAppState>;
  beginScheduledTaskInterview(): Promise<DesktopAppState>;
  cancelCurrentRun(): Promise<DesktopAppState>;
  setActiveView(view: AppView): Promise<DesktopAppState>;
  setSidebarCollapsed(collapsed: boolean): Promise<DesktopAppState>;
  setThreadGrouping(grouping: ThreadGrouping): Promise<DesktopAppState>;
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
  setProviderApiKey(
    workspaceId: string,
    providerId: string,
    apiKey: string,
  ): Promise<DesktopAppState>;
  listCustomProviders(): Promise<readonly CustomProviderConfig[]>;
  setCustomProvider(workspaceId: string, config: CustomProviderConfig): Promise<DesktopAppState>;
  deleteCustomProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  probeCustomProviderModels(input: CustomProviderProbeInput): Promise<CustomProviderProbeResult>;
  setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState>;
  setScopedModelPatterns(
    workspaceId: string,
    patterns: readonly string[],
  ): Promise<DesktopAppState>;
  setSkillEnabled(
    workspaceId: string,
    filePath: string,
    enabled: boolean,
  ): Promise<DesktopAppState>;
  setExtensionEnabled(
    workspaceId: string,
    filePath: string,
    enabled: boolean,
  ): Promise<DesktopAppState>;
  respondToHostUiRequest(
    workspaceId: string,
    sessionId: string,
    response:
      | { readonly requestId: string; readonly value: string }
      | { readonly requestId: string; readonly confirmed: boolean }
      | { readonly requestId: string; readonly cancelled: true },
  ): Promise<DesktopAppState>;
  setNotificationPreferences(
    preferences: Partial<NotificationPreferences>,
  ): Promise<DesktopAppState>;
  setIntegratedTerminalShell(shell: string): Promise<DesktopAppState>;
  setEnableTransparency(enabled: boolean): Promise<DesktopAppState>;
  setThemePresetId(presetId: ThemePresetId): Promise<DesktopAppState>;
  ensureTerminalPanel(
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot>;
  createTerminalSession(
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot>;
  setActiveTerminalSession(
    workspaceId: string,
    terminalScopeId: string,
    terminalId: string,
  ): Promise<TerminalPanelSnapshot>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, size: TerminalSize): Promise<void>;
  restartTerminalSession(
    terminalId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot>;
  closeTerminalSession(terminalId: string): Promise<TerminalPanelSnapshot | null>;
  setTerminalTitle(terminalId: string, title: string): Promise<void>;
  setTerminalFocused(focused: boolean): Promise<void>;
  setSidePanelFocused(focused: boolean): Promise<void>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void;
  onTerminalError(listener: (event: TerminalErrorEvent) => void): () => void;
  getNotificationPermissionStatus(): Promise<DesktopNotificationPermissionStatus>;
  requestNotificationPermission(): Promise<DesktopNotificationPermissionStatus>;
  openSystemNotificationSettings(): Promise<void>;
  onNotificationPermissionStatusChanged(
    callback: (status: DesktopNotificationPermissionStatus) => void,
  ): () => void;
  pickComposerAttachments(): Promise<DesktopAppState>;
  readClipboardImage(): ClipboardImageRead;
  addComposerAttachments(attachments: readonly ComposerAttachment[]): Promise<DesktopAppState>;
  removeComposerAttachment(attachmentId: string): Promise<DesktopAppState>;
  editQueuedComposerMessage(messageId: string, currentDraft?: string): Promise<DesktopAppState>;
  cancelQueuedComposerEdit(): Promise<DesktopAppState>;
  removeQueuedComposerMessage(messageId: string): Promise<DesktopAppState>;
  steerQueuedComposerMessage(messageId: string): Promise<DesktopAppState>;
  persistComposerDraft(input: {
    readonly target: SessionRef;
    readonly draft: string;
  }): Promise<void>;
  updateComposerDraft(composerDraft: string): Promise<DesktopAppState>;
  submitComposer(
    text: string,
    options?: { readonly deliverAs?: "steer" | "followUp" },
  ): Promise<DesktopAppState>;
  getSessionTree(target: WorkspaceSessionTarget): Promise<SessionTreeSnapshot>;
  navigateSessionTree(
    target: WorkspaceSessionTarget,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ): Promise<{ readonly state: DesktopAppState; readonly result: NavigateSessionTreeResult }>;
  listWorkspaceFiles(
    workspaceId: string,
    options?: { readonly force?: boolean },
  ): Promise<string[]>;
  readWorkspaceFile(workspaceId: string, filePath: string): Promise<WorkspaceFilePreview>;
  revealWorkspaceFile(workspaceId: string, filePath: string): Promise<void>;
  getChangedFiles(workspaceId: string): Promise<ChangedFilesResult>;
  getFileDiff(workspaceId: string, filePath: string): Promise<string>;
  stageFile(workspaceId: string, filePath: string, stagingSourcePath?: string): Promise<void>;
  onExtensionViewOpenFile(listener: (event: ExtensionViewOpenFile) => void): () => void;
  listExtensionViews(target: SessionRef): Promise<readonly DesktopExtensionViewInfo[]>;
  openExtensionView(input: OpenExtensionViewInput): Promise<ExtensionViewConnection>;
  sendExtensionViewMessage(input: ExtensionViewMessage): Promise<void>;
  closeExtensionView(connectionId: string): Promise<void>;
  onExtensionViewMessage(listener: (event: ExtensionViewMessage) => void): () => void;
  onExtensionViewCatalogChanged(listener: (event: ExtensionViewCatalogChange) => void): () => void;
  resolveTurnReview(input: ResolveTurnReviewInput): Promise<ResolveTurnReviewResult>;
  getReview(input: GetReviewInput): Promise<ReviewResult>;
  getReviewFile(input: ReviewFileInput): Promise<ReviewFileResult>;
  setReviewFileReviewed(input: SetReviewFileReviewedInput): Promise<SetReviewFileReviewedResult>;
  changeReviewFileStage(input: ChangeReviewFileStageInput): Promise<ChangeReviewFileStageResult>;
  toggleWindowMaximize(): Promise<void>;
  openExternal(url: string): Promise<void>;
  getThemeMode(): Promise<"system" | "light" | "dark">;
  getResolvedTheme(): Promise<"light" | "dark">;
  setThemeMode(mode: "system" | "light" | "dark"): Promise<DesktopAppState>;
  onThemeChanged(callback: (theme: "light" | "dark") => void): () => void;
  relaunchApplication(): Promise<void>;
}
