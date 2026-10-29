import type {
  ExtensionFlagValues,
  HostUiRequest,
  SessionConfig,
  SessionUsageSnapshot,
} from "@pi-gui/session-driver";
import type {
  ModelSettingsSnapshot,
  RuntimeCommandRecord,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { SessionSchemaInfo } from "@pi-gui/session-driver";
export type { SessionSchemaInfo } from "@pi-gui/session-driver";
export type SessionStatus = "idle" | "running" | "failed";
export type { SessionRole, TimelineToolCall, TranscriptMessage } from "./timeline-types";
import type { TranscriptMessage } from "./timeline-types";
import type { ScheduledTaskRecord } from "./scheduled-tasks";
export type {
  CreateScheduledTaskInput,
  ScheduledTaskFilter,
  ScheduledTaskRecord,
  ScheduledTaskSchedule,
  ScheduledTaskStatus,
  ScheduledTaskTarget,
  UpdateScheduledTaskInput,
} from "./scheduled-tasks";

export type AppView = "threads" | "new-thread" | "scheduled" | "skills" | "extensions" | "settings";
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
export type ThreadGrouping = "time" | "workspace";

export function isThreadGrouping(value: unknown): value is ThreadGrouping {
  return value === "time" || value === "workspace";
}

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
  readonly lastInteractedAt?: string;
  readonly archivedAt?: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly runningSince?: string;
  readonly hasUnseenUpdate: boolean;
  readonly config?: SessionConfig;
}

export type OrchestrationChildThreadStatus =
  "queued" | "running" | "waiting" | "complete" | "failed";
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
export type OrchestrationEvidenceStatus =
  "reported" | "accepted" | "running" | "passed" | "failed" | "blocked";

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

/**
 * One parent/child link as the window draws it: ids, title and status only, never the
 * child's goal, transcript or evidence. Main derives these from orchestrationChildren.
 */
export interface ChildThreadLink {
  readonly id: string;
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly childWorkspaceId: string;
  readonly childSessionId: string;
  readonly title: string;
  readonly status: OrchestrationChildThreadStatus;
}

/** Derives the links, returning `previous` when nothing the window draws has changed. */
export function childThreadLinksOf(
  children: readonly OrchestrationChildThread[],
  previous: readonly ChildThreadLink[] = [],
): readonly ChildThreadLink[] {
  const same =
    children.length === previous.length &&
    children.every((child, index) => {
      const link = previous[index]!;
      return (
        link.id === child.id &&
        link.parentWorkspaceId === child.parentWorkspaceId &&
        link.parentSessionId === child.parentSessionId &&
        link.childWorkspaceId === child.childWorkspaceId &&
        link.childSessionId === child.childSessionId &&
        link.title === child.title &&
        link.status === child.status
      );
    });
  if (same) return previous;
  return children.map((child) => ({
    id: child.id,
    parentWorkspaceId: child.parentWorkspaceId,
    parentSessionId: child.parentSessionId,
    childWorkspaceId: child.childWorkspaceId,
    childSessionId: child.childSessionId,
    title: child.title,
    status: child.status,
  }));
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
  // Session-file schema-version skew, when known. `writtenByNewerRuntime` drives the version-skew
  // notice; undefined until the (async, static-per-session) header read resolves.
  readonly schemaInfo?: SessionSchemaInfo;
}

// What changed since the transcript last sent to a window: `deleteCount` rows at `start` were
// replaced by `rows`. Sending this instead of a tens-of-MB transcript keeps both processes free.
// `baseLength` is the length of that last-sent transcript. A window holding a transcript of
// another length asks for the whole transcript instead; this catches a lost or misapplied patch
// that changed the length, not one that replaced rows and kept it.
export interface SelectedTranscriptPatch {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly baseLength: number;
  readonly start: number;
  readonly deleteCount: number;
  readonly rows: readonly TranscriptMessage[];
}

// Rows are replaced, never edited in place, so identity finds the changed range.
// Undefined when only a whole record can describe the change.
export function selectedTranscriptPatch(
  previous: SelectedTranscriptRecord,
  next: SelectedTranscriptRecord,
): SelectedTranscriptPatch | undefined {
  if (
    previous.workspaceId !== next.workspaceId ||
    previous.sessionId !== next.sessionId ||
    previous.schemaInfo !== next.schemaInfo
  ) {
    return undefined;
  }
  const before = previous.transcript;
  const after = next.transcript;
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) {
    start += 1;
  }
  let end = 0;
  while (
    end < shorter - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }
  return {
    workspaceId: next.workspaceId,
    sessionId: next.sessionId,
    baseLength: before.length,
    start,
    deleteCount: before.length - start - end,
    rows: after.slice(start, after.length - end),
  };
}

// Undefined when the patch does not fit this record, so the window must pull the whole transcript.
export function applySelectedTranscriptPatch(
  record: SelectedTranscriptRecord | null,
  patch: SelectedTranscriptPatch,
): SelectedTranscriptRecord | undefined {
  if (
    !record ||
    record.workspaceId !== patch.workspaceId ||
    record.sessionId !== patch.sessionId ||
    record.transcript.length !== patch.baseLength ||
    patch.start + patch.deleteCount > patch.baseLength
  ) {
    return undefined;
  }
  return {
    ...record,
    transcript: [
      ...record.transcript.slice(0, patch.start),
      ...patch.rows,
      ...record.transcript.slice(patch.start + patch.deleteCount),
    ],
  };
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

export interface SessionExtensionNoticeRecord {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly createdAt: string;
}

export interface SessionExtensionUiStateRecord {
  readonly instanceId: string;
  readonly statuses: readonly SessionExtensionStatusRecord[];
  readonly widgets: readonly SessionExtensionWidgetRecord[];
  readonly pendingDialogs: readonly SessionExtensionDialogRecord[];
  /** `ctx.ui.notify` toasts, newest last. Main caps and expires them; the renderer only draws them. */
  readonly notices: readonly SessionExtensionNoticeRecord[];
  readonly title?: string;
  readonly editorText?: string;
}

/**
 * One session's extension UI, sent on its own when only its status, widgets or title changed.
 * `revision` comes from the same counter as full state pushes, so a stale one is dropped.
 */
export interface SessionExtensionUiUpdate {
  readonly sessionKey: string;
  readonly ui: SessionExtensionUiStateRecord;
  readonly revision: number;
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
  /**
   * The flag values chosen for this thread, `false` and empty strings included so
   * they are remembered as the workspace's next defaults. Main checks them against
   * the flags the workspace's extensions registered before pi sees them.
   */
  readonly extensionFlags?: ExtensionFlagValues;
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

export interface StartupDiagnostic {
  readonly scope: "application" | "workspace";
  readonly message: string;
  readonly workspacePath?: string;
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
  readonly sessionCommandsBySession: Readonly<Record<string, readonly RuntimeCommandRecord[]>>;
  /** Context, cache and usage for open sessions; absent until pi reports it. */
  readonly sessionUsageBySession: Readonly<Record<string, SessionUsageSnapshot>>;
  readonly sessionExtensionUiBySession: Readonly<Record<string, SessionExtensionUiStateRecord>>;
  readonly extensionCommandCompatibilityByWorkspace: Readonly<
    Record<string, readonly ExtensionCommandCompatibilityRecord[]>
  >;
  /** Flag values last chosen for a new thread in each root workspace: the next thread's defaults. */
  readonly extensionFlagsByWorkspace: Readonly<Record<string, ExtensionFlagValues>>;
  /** Flag values each thread's pi session started with (only the ones pi receives). */
  readonly extensionFlagsBySession: Readonly<Record<string, ExtensionFlagValues>>;
  /**
   * Main's full child records, transcripts included. Window state pushes leave this
   * empty; the window reads childThreadLinks instead.
   */
  readonly orchestrationChildren: readonly OrchestrationChildThread[];
  readonly childThreadLinks: readonly ChildThreadLink[];
  readonly scheduledTasks: readonly ScheduledTaskRecord[];
  readonly notificationPreferences: NotificationPreferences;
  readonly integratedTerminalShell: string;
  readonly lastViewedAtBySession: Readonly<Record<string, string>>;
  readonly lastInteractedAtBySession: Readonly<Record<string, string>>;
  readonly pinnedAtBySession: Readonly<Record<string, string>>;
  readonly pinnedSessionOrder: readonly string[];
  readonly workspaceOrder: readonly string[];
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly globalModelSettings: ModelSettingsSnapshot;
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  readonly sidebarCollapsed: boolean;
  readonly threadGrouping: ThreadGrouping;
  /** Folder groups the user collapsed in the sidebar, by workspace id. */
  readonly collapsedWorkspaceIds: readonly string[];
  readonly enableTransparency: boolean;
  readonly startupDiagnostics: readonly StartupDiagnostic[];
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
    sessionCommandsBySession: {},
    sessionUsageBySession: {},
    sessionExtensionUiBySession: {},
    extensionCommandCompatibilityByWorkspace: {},
    extensionFlagsByWorkspace: {},
    extensionFlagsBySession: {},
    orchestrationChildren: [],
    childThreadLinks: [],
    scheduledTasks: [],
    notificationPreferences: {
      backgroundCompletion: true,
      backgroundFailure: true,
      attentionNeeded: true,
    },
    integratedTerminalShell: "",
    lastViewedAtBySession: {},
    lastInteractedAtBySession: {},
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
    threadGrouping: "time",
    collapsedWorkspaceIds: [],
    enableTransparency: false,
    startupDiagnostics: [],
    revision: 0,
  };
}

export function getSelectedWorkspace(state: DesktopAppState): WorkspaceRecord | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

export interface DesktopAppViewState {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly activeView?: AppView;
  readonly sidebarCollapsed?: boolean;
}

export function getSelectedSession(state: DesktopAppState): SessionRecord | undefined {
  return getSelectedWorkspace(state)?.sessions.find(
    (session) => session.id === state.selectedSessionId,
  );
}
