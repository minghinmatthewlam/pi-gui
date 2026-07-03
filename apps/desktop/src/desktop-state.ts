import type { HostUiRequest, SessionConfig } from "@pi-gui/session-driver";
import type { ModelSettingsSnapshot, RuntimeCommandRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
export type SessionStatus = "idle" | "running" | "failed";
export type { SessionRole, TimelineToolCall, TranscriptMessage } from "./timeline-types";
import type { TranscriptMessage } from "./timeline-types";

export type AppView = "threads" | "new-thread" | "skills" | "extensions" | "packages" | "settings";
export type WorkspaceKind = "primary" | "worktree";
export type WorktreeStatus = "ready" | "missing" | "error";
export type NewThreadEnvironment = "local" | "worktree";
export type ThemeMode = "system" | "light" | "dark";
export const themePresetIds = [
  "default",
  "catppuccin",
  "tokyo-night",
  "nord",
  "dracula",
  "gruvbox",
  "github",
  "vscode",
] as const;
export type ThemePresetId = (typeof themePresetIds)[number];
export type ModelSettingsScopeMode = "app-global" | "per-repo";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function isThemePresetId(value: unknown): value is ThemePresetId {
  return typeof value === "string" && themePresetIds.includes(value as ThemePresetId);
}
export type ComposerDraftSyncSource =
  | "state"
  | "selection"
  | "persist"
  | "remote-persist"
  | "command"
  | "extension-editor-text"
  | "queued-message-edit";

export interface NotificationPreferences {
  readonly backgroundCompletion: boolean;
  readonly backgroundFailure: boolean;
  readonly attentionNeeded: boolean;
}

export interface ComposerImageAttachment {
  readonly id: string;
  readonly kind: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

export interface ComposerFileAttachment {
  readonly id: string;
  readonly kind: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly fsPath: string;
  readonly sizeBytes?: number;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;

export type QueuedComposerMessageMode = "steer" | "followUp";

export interface QueuedComposerMessage {
  readonly id: string;
  readonly mode: QueuedComposerMessageMode;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly lastViewedAt?: string;
  readonly archivedAt?: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly runningSince?: string;
  readonly hasUnseenUpdate: boolean;
  readonly config?: SessionConfig;
}

export type OrchestrationChildThreadStatus = "running" | "waiting" | "complete" | "failed";
export type OrchestrationSupervisionGate = "continue" | "stop" | "wake";
export type OrchestrationSupervisionStatus = "monitoring" | "attention" | "stopped";
export type OrchestrationEvidenceKind =
  | "worker_report"
  | "orchestrator_acceptance"
  | "orchestrator_observation"
  | "orchestrator_action"
  | "command"
  | "review_finding"
  | "blocker";
export type OrchestrationEvidenceSource =
  | "worker-reported"
  | "orchestrator-accepted"
  | "orchestrator-observed"
  | "orchestrator-action"
  | "command"
  | "review"
  | "blocker";
export type OrchestrationEvidenceStatus = "reported" | "accepted" | "running" | "passed" | "failed" | "blocked";

export interface OrchestrationEvidenceGitRef {
  readonly workspaceId: string;
  readonly branchName?: string;
  readonly headSha?: string;
}

export interface OrchestrationEvidenceRecord {
  readonly id: string;
  readonly childThreadId: string;
  readonly kind: OrchestrationEvidenceKind;
  readonly source: OrchestrationEvidenceSource;
  readonly status: OrchestrationEvidenceStatus;
  readonly title: string;
  readonly detail?: string;
  readonly command?: string;
  readonly toolName?: string;
  readonly severity?: "P0" | "P1" | "P2" | "P3";
  readonly parentSessionId?: string;
  readonly childSessionId?: string;
  readonly git?: OrchestrationEvidenceGitRef;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface OrchestrationSupervisionLoop {
  readonly id: string;
  readonly status: OrchestrationSupervisionStatus;
  readonly gate: OrchestrationSupervisionGate;
  readonly intervalMs: number;
  readonly iterationCount: number;
  readonly lastCheckedAt: string;
  readonly nextRunAt?: string;
  readonly reason: string;
  readonly lastChildStatus: OrchestrationChildThreadStatus;
  readonly stoppedAt?: string;
}

export interface OrchestrationChildTranscriptMessage {
  readonly id: string;
  readonly role: "parent" | "child" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export interface OrchestrationChildThread {
  readonly id: string;
  readonly sourceToolCallId?: string;
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly childWorkspaceId: string;
  readonly childSessionId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: OrchestrationChildThreadStatus;
  readonly latestTranscript: string;
  readonly transcript: readonly OrchestrationChildTranscriptMessage[];
  readonly evidence: readonly OrchestrationEvidenceRecord[];
  readonly supervisionLoop?: OrchestrationSupervisionLoop;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SendChildThreadFollowUpInput {
  readonly childThreadId: string;
  readonly text: string;
}

export interface SetChildSupervisionLoopInput {
  readonly childThreadId: string;
  readonly gate: Extract<OrchestrationSupervisionGate, "continue" | "stop">;
}

export interface SelectedTranscriptRecord {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly transcript: readonly TranscriptMessage[];
}

export interface WorktreeRecord {
  readonly id: string;
  readonly rootWorkspaceId: string;
  readonly linkedWorkspaceId?: string;
  readonly name: string;
  readonly path: string;
  readonly status: WorktreeStatus;
  readonly branchName?: string;
  readonly updatedAt: string;
}

export interface SessionExtensionStatusRecord {
  readonly key: string;
  readonly text: string;
}

export interface SessionExtensionWidgetRecord {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "aboveComposer" | "belowComposer";
}

export type SessionExtensionDialogRecord = Extract<
  HostUiRequest,
  { readonly kind: "confirm" | "select" | "input" | "editor" }
>;

export interface SessionExtensionUiStateRecord {
  readonly statuses: readonly SessionExtensionStatusRecord[];
  readonly widgets: readonly SessionExtensionWidgetRecord[];
  readonly pendingDialogs: readonly SessionExtensionDialogRecord[];
  readonly title?: string;
  readonly editorText?: string;
}

export type ExtensionCommandCompatibilityStatus = "supported" | "terminal-only";

export interface ExtensionCommandCompatibilityRecord {
  readonly commandName: string;
  readonly extensionPath: string;
  readonly status: ExtensionCommandCompatibilityStatus;
  readonly message: string;
  readonly capability: string;
  readonly updatedAt: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
  readonly kind: WorkspaceKind;
  readonly rootWorkspaceId?: string;
  readonly branchName?: string;
  readonly sessions: readonly SessionRecord[];
}

export interface CreateWorktreeInput {
  readonly workspaceId: string;
  readonly fromSessionWorkspaceId?: string;
  readonly fromSessionId?: string;
}

export type StartThreadInput = {
  readonly rootWorkspaceId: string;
  readonly environment: NewThreadEnvironment;
  readonly prompt?: string;
  readonly attachments?: readonly ComposerAttachment[];
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
};

export type ForkThreadPosition = "before" | "at" | "after";

export type ForkThreadInput = {
  readonly sourceWorkspaceId: string;
  readonly sourceSessionId: string;
  /** Root workspace used as the base when forking into a new worktree. */
  readonly rootWorkspaceId: string;
  /** "local" forks into the source workspace; "worktree" creates a new worktree. */
  readonly environment: NewThreadEnvironment;
  /** ID of the rendered transcript message selected as the fork point, when it maps to a session entry. */
  readonly sourceMessageId?: string;
  /** 0-based index of the rendered transcript message selected as the fork point. */
  readonly sourceMessageIndex?: number;
  /** 0-based rendered user-message index kept as a fallback for older callers. */
  readonly userMessageIndex?: number;
  readonly position?: ForkThreadPosition;
};

export interface RemoveWorktreeInput {
  readonly workspaceId: string;
  readonly worktreeId: string;
}

export type PackageKind = "npm" | "git" | "local";
export type PackageScope = "user" | "project";

export interface PackageRecord {
  readonly source: string;
  readonly kind: PackageKind;
  readonly displayName: string;
  readonly description?: string;
  readonly scope: PackageScope;
  readonly enabled: boolean;
  readonly extensionCount: number;
  readonly skillCount: number;
  readonly promptCount: number;
  readonly themeCount: number;
}

export interface DesktopAppState {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly worktreesByWorkspace: Readonly<Record<string, readonly WorktreeRecord[]>>;
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly composerDraft: string;
  readonly composerDraftSyncSource: ComposerDraftSyncSource;
  readonly composerDraftSyncNonce: number;
  readonly composerAttachments: readonly ComposerAttachment[];
  readonly queuedComposerMessages: readonly QueuedComposerMessage[];
  readonly editingQueuedMessageId?: string;
  readonly runtimeByWorkspace: Readonly<Record<string, RuntimeSnapshot>>;
  readonly packagesByWorkspace: Readonly<Record<string, readonly PackageRecord[]>>;
  readonly sessionCommandsBySession: Readonly<Record<string, readonly RuntimeCommandRecord[]>>;
  readonly sessionExtensionUiBySession: Readonly<Record<string, SessionExtensionUiStateRecord>>;
  readonly extensionCommandCompatibilityByWorkspace: Readonly<Record<string, readonly ExtensionCommandCompatibilityRecord[]>>;
  readonly orchestrationChildren: readonly OrchestrationChildThread[];
  readonly notificationPreferences: NotificationPreferences;
  readonly integratedTerminalShell: string;
  readonly lastViewedAtBySession: Readonly<Record<string, string>>;
  readonly pinnedAtBySession: Readonly<Record<string, string>>;
  readonly pinnedSessionOrder: readonly string[];
  readonly workspaceOrder: readonly string[];
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly globalModelSettings: ModelSettingsSnapshot;
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  readonly sidebarCollapsed: boolean;
  readonly enableTransparency: boolean;
  readonly revision: number;
  readonly lastError?: string;
}

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly title?: string;
}

export interface WorkspaceSessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export function createEmptyDesktopAppState(): DesktopAppState {
  return {
    workspaces: [],
    worktreesByWorkspace: {},
    selectedWorkspaceId: "",
    selectedSessionId: "",
    activeView: "threads",
    composerDraft: "",
    composerDraftSyncSource: "state",
    composerDraftSyncNonce: 0,
    composerAttachments: [],
    queuedComposerMessages: [],
    runtimeByWorkspace: {},
    packagesByWorkspace: {},
    sessionCommandsBySession: {},
    sessionExtensionUiBySession: {},
    extensionCommandCompatibilityByWorkspace: {},
    orchestrationChildren: [],
    notificationPreferences: {
      backgroundCompletion: true,
      backgroundFailure: true,
      attentionNeeded: true,
    },
    integratedTerminalShell: "",
    lastViewedAtBySession: {},
    pinnedAtBySession: {},
    pinnedSessionOrder: [],
    workspaceOrder: [],
    modelSettingsScopeMode: "app-global",
    globalModelSettings: {
      enabledModelPatterns: [],
    },
    themeMode: "system",
    themePresetId: "default",
    sidebarCollapsed: false,
    enableTransparency: false,
    revision: 0,
  };
}

export function getSelectedWorkspace(state: DesktopAppState): WorkspaceRecord | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

export function getSelectedSession(state: DesktopAppState): SessionRecord | undefined {
  return getSelectedWorkspace(state)?.sessions.find((session) => session.id === state.selectedSessionId);
}
