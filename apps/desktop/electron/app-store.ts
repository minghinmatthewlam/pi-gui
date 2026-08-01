import type { BrowserWindow } from "electron";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyHostUiRequestToExtensionUiState,
  type GenerateThreadTitleOptions,
  isExtensionUiDialogRequest,
  JsonCatalogStore,
  PiSdkDriver,
  type PiSdkDriverConfig,
  SessionLeasedError,
  type SessionSchemaInfo,
  sessionKey,
} from "@pi-gui/pi-sdk-driver";
import type { SessionCatalogEntry } from "@pi-gui/catalogs";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from "@pi-gui/session-driver/types";
import type {
  CreateSessionOptions,
  HostUiResponse,
  SessionConfig,
  SessionDriverEvent,
  SessionQueuedMessage,
  SessionRef,
  SessionSnapshot,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type {
  ModelSettingsSnapshot,
  RuntimeCommandRecord,
  RuntimeLoginCallbacks,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import {
  type AppView,
  type ComposerAttachment,
  type ComposerDraftSyncSource,
  type ExtensionCommandCompatibilityRecord,
  type ModelSettingsScopeMode,
  createEmptyDesktopAppState,
  type CreateSessionInput,
  type CreateWorktreeInput,
  type DesktopAppState,
  type ForkThreadInput,
  type NotificationPreferences,
  type QueuedComposerMessage,
  type RemoveWorktreeInput,
  type SendChildThreadFollowUpInput,
  type SetChildSupervisionLoopInput,
  type SelectedTranscriptRecord,
  type StartThreadInput,
  type StartupDiagnostic,
  type ThemeMode,
  type ThemePresetId,
  type TranscriptMessage,
  type WorkspaceSessionTarget,
  isThemeMode,
  isThemePresetId,
} from "../src/desktop-state";
import {
  applyTimelineEvent,
  appendAssistantDelta,
  clearActiveAssistantMessage,
  timelineFromDriverTranscript,
} from "./app-store-timeline";
import { applySessionEventState, updateSessionRecord } from "./app-store-session-state";
import type { AppStoreInternals, RefreshStateOptions } from "./app-store-internals";
import {
  readPersistedUiState,
  type LegacyPersistedUiState,
  type PersistedUiState,
  writePersistedUiState,
} from "./app-store-persistence";
import { JsonFileStore } from "./json-file-store";
import {
  type PendingRuntimeCommandExecution,
  getLearnedCommandCompatibility,
  pruneCompatibilityForRuntimeSnapshot,
  recordLearnedCommandCompatibility,
  restoreCompatibilityByWorkspace,
  serializeCompatibilityByWorkspace,
} from "./extension-command-compatibility";
import {
  buildWorktreeRecords,
  buildWorkspaceRecords,
  cloneComposerAttachment,
  cloneComposerAttachments,
  cloneTranscriptMessage,
  latestSessionActivityAt,
  mergeQueuedComposerMessages,
  mapToRecord,
  previewFromTranscript,
  toSessionQueuedMessages,
  toSessionRef,
} from "./app-store-utils";
import type { CustomProviderConfig } from "../src/ipc";
import { resolveRepoWorkspaceId } from "../src/workspace-roots";
import { SessionStateMap, type QueuedComposerEditState } from "./session-state-map";
import { createEmptyExtensionUiState, serializeExtensionUiState } from "./session-state-map";
import { GitWorktreeManager } from "./worktree-manager";
import * as workspace from "./app-store-workspace";
import * as worktree from "./app-store-worktree";
import * as composer from "./app-store-composer";
import * as orchestration from "./app-store-orchestration";
import { isSessionActivelyViewed, isSessionVisibleInWindow } from "./session-visibility";

type StateListener = (state: DesktopAppState) => void;
type SelectedTranscriptListener = (payload: SelectedTranscriptRecord | null) => void;
type SessionEventListener = (event: SessionDriverEvent, state: DesktopAppState) => void | Promise<void>;
type ExtensionUiDialogRequest = Extract<SessionDriverEvent, { type: "hostUiRequest" }>["request"] & {
  readonly requestId: string;
  readonly timeoutMs?: number;
};
export interface DesktopAppStoreOptions {
  readonly userDataDir: string;
  readonly initialWorkspacePaths: readonly string[];
  readonly getWindow?: () => BrowserWindow | null;
  readonly shouldKeepSessionDialogs?: (sessionRef: SessionRef) => boolean;
  readonly driverOptions?: Pick<PiSdkDriverConfig, "extensionFactories" | "inlineExtensionMetadata">;
  readonly generateThreadTitleOverride?: (
    workspace: WorkspaceRef,
    options: GenerateThreadTitleOptions,
  ) => Promise<string | null | undefined>;
}

export interface DesktopAppViewState {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly activeView?: AppView;
  readonly sidebarCollapsed?: boolean;
}

export class DesktopAppStore implements AppStoreInternals {
  state = createEmptyDesktopAppState();
  private readonly listeners = new Set<StateListener>();
  /** Monotonic publish counter; emit() stamps every published state with it. */
  private publishRevision = 1;
  /** Serialize full-state refreshes so stale async builders cannot publish over newer state. */
  private refreshStateQueue: Promise<void> = Promise.resolve();
  private readonly selectedTranscriptListeners = new Set<SelectedTranscriptListener>();
  private readonly sessionEventListeners = new Set<SessionEventListener>();
  private readonly sessionEventQueues = new Map<string, Promise<void>>();
  /**
   * Trailing-edge coalescers for per-session command refreshes, keyed by session
   * key. A refresh request that arrives while one is already in flight marks it
   * dirty instead of starting another driver round-trip; the runner then does one
   * trailing refresh so the final state is never dropped.
   */
  private readonly sessionCommandRefreshers = new Map<string, { dirty: boolean }>();
  /** Per-workspace serial queue so focus reconciles never overlap or race. */
  private readonly externalChangeQueues = new Map<string, Promise<void>>();
  /**
   * Last-seen `mtimeMs` per watched settings file (global + per-workspace). Focus
   * reconcile reloads runtime only when a file's mtime moved since the last check,
   * and the app records its own settings writes here so a self-write is never
   * mistaken for an external edit (which would clobber the just-applied selection).
   */
  private readonly settingsFileMtimes = new Map<string, number>();
  /**
   * Last-seen `{ mtimeMs, size }` of the selected session's JSONL, keyed by session
   * key. Focus reconcile republishes the viewed transcript only when the on-disk
   * file actually changed, so an unchanged session never re-triggers scroll restore.
   */
  private readonly selectedTranscriptFileStats = new Map<string, { readonly mtimeMs: number; readonly size: number }>();
  /** Cached session schema info (version-skew flag) projected onto the transcript payload. */
  private readonly sessionSchemaInfoCache = new Map<string, SessionSchemaInfo>();
  private readonly sessionSchemaInfoInFlight = new Set<string>();
  readonly driver: PiSdkDriver;
  readonly catalogStore: JsonCatalogStore;
  readonly worktreeManager: GitWorktreeManager;
  readonly worktreeRoot: string;
  private readonly uiStateFilePath: string;
  readonly attachmentStore: JsonFileStore<ComposerAttachment[]>;
  readonly sessionState = new SessionStateMap();
  readonly runtimeByWorkspace = new Map<string, RuntimeSnapshot>();
  readonly extensionCommandCompatibilityByWorkspace = new Map<string, Map<string, ExtensionCommandCompatibilityRecord>>();
  readonly pendingRuntimeCommandsBySession = new Map<string, PendingRuntimeCommandExecution>();
  private readonly reportedCompatibilityIssuesBySession = new Map<string, Set<string>>();
  private readonly initialWorkspacePaths: readonly string[];
  private readonly getWindow: () => BrowserWindow | null;
  private readonly shouldKeepSessionDialogs: (sessionRef: SessionRef) => boolean;
  private composerDraftSyncTarget: SessionRef | undefined;
  private composerDraftProjectionNonce = 0;
  private persistUiStateTimer: NodeJS.Timeout | undefined;
  private orchestrationSupervisionTimer: NodeJS.Timeout | undefined;
  private scheduledOrchestrationSupervisionRunAt: string | undefined;
  private readonly extensionDialogTimeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly restoredSelectedSessionKeysAwaitingSelection = new Set<string>();
  private initPromise: Promise<void> | undefined;
  private selectionEpoch = 0;
  private refreshStateDepth = 0;

  constructor(options: DesktopAppStoreOptions) {
    const catalogFilePath = join(options.userDataDir, "catalogs.json");
    this.catalogStore = new JsonCatalogStore({ catalogFilePath });
    const driverOptions: PiSdkDriverConfig = {
      catalogStorage: this.catalogStore,
      ...(options.driverOptions ?? {}),
      ...(options.generateThreadTitleOverride
        ? { generateThreadTitleOverride: options.generateThreadTitleOverride }
        : {}),
    };

    this.driver = new PiSdkDriver(driverOptions);
    this.worktreeManager = new GitWorktreeManager({ catalogStorage: this.catalogStore });
    this.worktreeRoot = join(options.userDataDir, "worktrees");
    this.uiStateFilePath = join(options.userDataDir, "ui-state.json");
    this.attachmentStore = new JsonFileStore<ComposerAttachment[]>(options.userDataDir, "attachments");
    this.initialWorkspacePaths = options.initialWorkspacePaths;
    this.getWindow = options.getWindow ?? (() => null);
    this.shouldKeepSessionDialogs = options.shouldKeepSessionDialogs ?? (() => false);
  }

  /* ── Lifecycle ──────────────────────────────────────────── */

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeInternal();
    }
    return this.initPromise;
  }

  async getState(): Promise<DesktopAppState> {
    await this.initialize();
    return structuredClone(this.state);
  }

  async getStateForView(view: DesktopAppViewState): Promise<DesktopAppState> {
    await this.initialize();
    return this.projectStateForView(view);
  }

  async getSelectedTranscript(): Promise<SelectedTranscriptRecord | null> {
    await this.initialize();
    const sessionRef = this.selectedSessionRef();
    if (!sessionRef) {
      return null;
    }
    await this.ensureTranscriptLoaded(sessionRef);
    return this.buildSelectedTranscriptRecord(sessionRef);
  }

  async getSelectedTranscriptForView(view: DesktopAppViewState): Promise<SelectedTranscriptRecord | null> {
    await this.initialize();
    const sessionRef = this.selectedSessionRefForView(view);
    if (!sessionRef) {
      return null;
    }
    await this.ensureTranscriptLoaded(sessionRef);
    return this.buildSelectedTranscriptRecord(sessionRef);
  }

  projectStateForView(
    view: DesktopAppViewState,
    state: DesktopAppState = this.state,
    previousView?: DesktopAppViewState,
  ): DesktopAppState {
    const selectedWorkspaceId = this.resolveViewWorkspaceId(view.selectedWorkspaceId, state);
    const selectedSessionId = this.resolveViewSessionId(selectedWorkspaceId, view.selectedSessionId, state);
    const previousWorkspaceId = previousView
      ? this.resolveViewWorkspaceId(previousView.selectedWorkspaceId, state)
      : selectedWorkspaceId;
    const previousSessionId = previousView
      ? this.resolveViewSessionId(previousWorkspaceId, previousView.selectedSessionId, state)
      : selectedSessionId;
    const selectionChanged =
      selectedWorkspaceId !== previousWorkspaceId || selectedSessionId !== previousSessionId;
    const matchesStateSelection =
      selectedWorkspaceId === state.selectedWorkspaceId && selectedSessionId === state.selectedSessionId;
    const syncTargetsProjectedSession =
      state.composerDraftSyncSource === "extension-editor-text" &&
      this.composerDraftSyncTarget?.workspaceId === selectedWorkspaceId &&
      this.composerDraftSyncTarget?.sessionId === selectedSessionId;
    const activeView = view.activeView ?? state.activeView;
    const sidebarCollapsed = view.sidebarCollapsed ?? state.sidebarCollapsed;

    return {
      ...structuredClone(state),
      selectedWorkspaceId,
      selectedSessionId,
      activeView,
      sidebarCollapsed,
      composerDraft: this.resolveComposerDraft(selectedWorkspaceId, selectedSessionId),
      composerDraftSyncSource: selectionChanged
        ? "selection"
        : syncTargetsProjectedSession || (matchesStateSelection && state.composerDraftSyncSource !== "extension-editor-text")
          ? state.composerDraftSyncSource
          : "state",
      composerDraftSyncNonce: selectionChanged
        ? this.allocateComposerDraftSyncNonce(state.composerDraftSyncNonce)
        : state.composerDraftSyncNonce,
      composerAttachments: this.resolveComposerAttachments(selectedWorkspaceId, selectedSessionId),
      queuedComposerMessages: this.resolveQueuedComposerMessages(selectedWorkspaceId, selectedSessionId),
      editingQueuedMessageId: this.resolveEditingQueuedMessageId(selectedWorkspaceId, selectedSessionId),
      lastError: this.resolveSelectedSessionError(selectedWorkspaceId, selectedSessionId, false) ?? (
        selectedSessionId ? undefined : state.lastError
      ),
    };
  }

  async flushPersistence(): Promise<void> {
    await this.initialize();
    if (this.persistUiStateTimer) {
      clearTimeout(this.persistUiStateTimer);
      this.persistUiStateTimer = undefined;
    }

    await this.persistUiState();
  }

  private scheduleOrchestrationSupervision(): void {
    const nextRunAt = orchestration.nextSupervisionRunAt(this.state.orchestrationChildren);
    if (nextRunAt && nextRunAt === this.scheduledOrchestrationSupervisionRunAt && this.orchestrationSupervisionTimer) {
      return;
    }
    if (this.orchestrationSupervisionTimer) {
      clearTimeout(this.orchestrationSupervisionTimer);
      this.orchestrationSupervisionTimer = undefined;
    }
    this.scheduledOrchestrationSupervisionRunAt = nextRunAt;
    if (!nextRunAt) {
      return;
    }
    const delayMs = Math.max(0, Date.parse(nextRunAt) - Date.now());
    this.orchestrationSupervisionTimer = setTimeout(() => {
      this.orchestrationSupervisionTimer = undefined;
      this.scheduledOrchestrationSupervisionRunAt = undefined;
      void this.runOrchestrationSupervisionTick();
    }, delayMs);
    this.orchestrationSupervisionTimer.unref?.();
  }

  private async runOrchestrationSupervisionTick(): Promise<void> {
    await this.initialize();
    const result = orchestration.reconcileDueSupervisionLoops(this);
    if (result.changed) {
      await this.persistUiState();
      this.emit();
    }
    this.scheduleOrchestrationSupervision();
  }

  async emitTestSessionEvent(event: SessionDriverEvent): Promise<void> {
    await this.initialize();
    await this.handleSessionEvent(event);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    void this.getState().then(listener).catch(() => undefined);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeToSelectedTranscript(listener: SelectedTranscriptListener): () => void {
    this.selectedTranscriptListeners.add(listener);
    void this.getSelectedTranscript().then(listener).catch(() => undefined);
    return () => {
      this.selectedTranscriptListeners.delete(listener);
    };
  }

  subscribeToSessionEvents(listener: SessionEventListener): () => void {
    this.sessionEventListeners.add(listener);
    return () => {
      this.sessionEventListeners.delete(listener);
    };
  }

  /* ── Workspace methods (delegated) ─────────────────────── */

  async addWorkspace(path: string): Promise<DesktopAppState> {
    return workspace.addWorkspace(this, path);
  }

  getWorkspacePath(workspaceId: string): string | undefined {
    return this.state.workspaces.find((w) => w.id === workspaceId)?.path;
  }

  getSkillFilePath(workspaceId: string, filePath: string): string | undefined {
    return this.runtimeByWorkspace.get(workspaceId)?.skills.find((s) => s.filePath === filePath)?.filePath;
  }

  getExtensionFilePath(workspaceId: string, filePath: string): string | undefined {
    return this.runtimeByWorkspace.get(workspaceId)?.extensions.find((entry) => entry.path === filePath)?.path;
  }

  async renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState> {
    return workspace.renameWorkspace(this, workspaceId, displayName);
  }

  async removeWorkspace(workspaceId: string): Promise<DesktopAppState> {
    return workspace.removeWorkspace(this, workspaceId);
  }

  async reorderWorkspaces(order: readonly string[]): Promise<DesktopAppState> {
    await this.initialize();
    const primaryIds = new Set(this.state.workspaces.filter((w) => w.kind === "primary").map((w) => w.id));
    const sanitized = [...new Set(order)].filter((id) => primaryIds.has(id));
    this.state = {
      ...this.state,
      workspaceOrder: sanitized,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async reorderPinnedSessions(order: readonly string[]): Promise<DesktopAppState> {
    await this.initialize();
    const pinnedSessionOrder = reconcilePinnedSessionOrder(this.sessionState.pinnedAtBySession, order);
    this.sessionState.pinnedSessionOrder = [...pinnedSessionOrder];
    this.state = {
      ...this.state,
      pinnedSessionOrder,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async selectWorkspace(workspaceId: string): Promise<DesktopAppState> {
    return workspace.selectWorkspace(this, workspaceId);
  }

  async selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.selectSession(this, target);
  }

  async selectSessionFast(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    if (!this.sessionFromState(sessionRef)) {
      return this.withErrorHandling(async () =>
        this.refreshState({
          selectedWorkspaceId: target.workspaceId,
          selectedSessionId: target.sessionId,
          clearLastError: true,
          activeView: "threads",
        }),
      );
    }

    return this.withErrorHandling(async () => {
      const selectionEpoch = ++this.selectionEpoch;
      this.applyFastSessionSelection(sessionRef);
      try {
        await this.hydrateSelectedSessionAfterSelection(sessionRef, selectionEpoch, { markViewed: true });
      } catch (error) {
        await this.handleSelectedSessionHydrationError(sessionRef, selectionEpoch, error);
      }
      return structuredClone(this.state);
    });
  }

  async renameSession(target: WorkspaceSessionTarget, title: string): Promise<DesktopAppState> {
    return workspace.renameSession(this, target, title);
  }

  async archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.archiveSession(this, target);
  }

  async unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.unarchiveSession(this, target);
  }

  async markSessionRead(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    if (!this.sessionFromState(sessionRef)) {
      return this.withError(`Unknown session: ${target.workspaceId}:${target.sessionId}`);
    }
    if (!this.markSessionViewed(sessionRef)) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setSessionPinned(target: WorkspaceSessionTarget, pinned: boolean): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    const session = this.sessionFromState(sessionRef);
    if (!session) {
      return this.withError(`Unknown session: ${target.workspaceId}:${target.sessionId}`);
    }
    if (pinned && session.archivedAt) {
      return this.withError(`Cannot pin archived session: ${target.workspaceId}:${target.sessionId}`);
    }

    const key = sessionKey(sessionRef);
    const currentPinnedAt = this.sessionState.pinnedAtBySession.get(key);
    const nextPinnedAt = pinned ? (currentPinnedAt ?? new Date().toISOString()) : undefined;
    if (currentPinnedAt === nextPinnedAt && session.pinnedAt === nextPinnedAt) {
      return structuredClone(this.state);
    }

    if (nextPinnedAt) {
      this.sessionState.pinnedAtBySession.set(key, nextPinnedAt);
      this.sessionState.pinnedSessionOrder = [
        key,
        ...this.sessionState.pinnedSessionOrder.filter((entry) => entry !== key),
      ];
    } else {
      this.sessionState.pinnedAtBySession.delete(key);
      this.sessionState.pinnedSessionOrder = this.sessionState.pinnedSessionOrder.filter((entry) => entry !== key);
    }

    const pinnedSessionOrder = reconcilePinnedSessionOrder(
      this.sessionState.pinnedAtBySession,
      this.sessionState.pinnedSessionOrder,
    );
    this.sessionState.pinnedSessionOrder = [...pinnedSessionOrder];
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map((workspaceEntry) =>
        workspaceEntry.id === target.workspaceId
          ? {
              ...workspaceEntry,
              sessions: workspaceEntry.sessions.map((entry) =>
                entry.id === target.sessionId
                  ? {
                      ...entry,
                      pinnedAt: nextPinnedAt,
                    }
                  : entry,
              ),
            }
          : workspaceEntry,
      ),
      pinnedAtBySession: mapToRecord(this.sessionState.pinnedAtBySession),
      pinnedSessionOrder,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async syncCurrentWorkspace(): Promise<DesktopAppState> {
    return workspace.syncCurrentWorkspace(this);
  }

  /* ── Worktree methods (delegated) ──────────────────────── */

  async createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState> {
    return worktree.createWorktree(this, input);
  }

  async forkThread(input: ForkThreadInput): Promise<DesktopAppState> {
    return worktree.forkThread(this, input);
  }

  async removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState> {
    return worktree.removeWorktree(this, input);
  }

  /* ── Composer methods (delegated) ──────────────────────── */

  async updateComposerDraft(composerDraft: string): Promise<DesktopAppState> {
    return composer.updateComposerDraft(this, composerDraft);
  }

  async addComposerAttachments(attachments: readonly ComposerAttachment[]): Promise<DesktopAppState> {
    return composer.addComposerAttachments(this, attachments);
  }

  async removeComposerAttachment(attachmentId: string): Promise<DesktopAppState> {
    return composer.removeComposerAttachment(this, attachmentId);
  }

  async submitComposer(
    textInput: string,
    options?: { readonly deliverAs?: "steer" | "followUp" },
  ): Promise<DesktopAppState> {
    return composer.submitComposer(this, textInput, options);
  }

  async editQueuedComposerMessage(messageId: string, currentDraft?: string): Promise<DesktopAppState> {
    return composer.editQueuedComposerMessage(this, messageId, currentDraft);
  }

  async cancelQueuedComposerEdit(): Promise<DesktopAppState> {
    return composer.cancelQueuedComposerEdit(this);
  }

  async removeQueuedComposerMessage(messageId: string): Promise<DesktopAppState> {
    return composer.removeQueuedComposerMessage(this, messageId);
  }

  async steerQueuedComposerMessage(messageId: string): Promise<DesktopAppState> {
    return composer.steerQueuedComposerMessage(this, messageId);
  }

  async cancelCurrentRun(): Promise<DesktopAppState> {
    const ref = this.selectedSessionRef();
    if (ref) {
      await orchestration.cancelChildRunsForParent(this, ref);
    }
    return composer.cancelCurrentRun(this);
  }

  async getSessionTree(target: WorkspaceSessionTarget): Promise<SessionTreeSnapshot> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    await this.ensureSessionReady(sessionRef);
    return this.driver.getSessionTree(sessionRef);
  }

  async navigateSessionTree(
    target: WorkspaceSessionTarget,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ): Promise<{ readonly state: DesktopAppState; readonly result: NavigateSessionTreeResult }> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    await this.ensureSessionReady(sessionRef);

    const result = await this.driver.navigateSessionTree(sessionRef, targetId, options);
    if (!result.cancelled && !result.aborted) {
      await this.reloadTranscriptFromDriver(sessionRef);
      await this.refreshSessionCommandsFor(sessionRef);
      const state = await this.refreshState({
        selectedWorkspaceId: target.workspaceId,
        selectedSessionId: target.sessionId,
        clearLastError: true,
        markSelectedSessionViewed: false,
      });
      return { state, result };
    }

    return {
      state: structuredClone(this.state),
      result,
    };
  }

  /* ── Session / thread methods (delegated) ───────────────── */

  async startThread(input: StartThreadInput): Promise<DesktopAppState> {
    return worktree.startThread(this, input);
  }

  async createSession(input: CreateSessionInput): Promise<DesktopAppState> {
    return workspace.createSession(this, input);
  }

  async sendChildThreadFollowUp(input: SendChildThreadFollowUpInput): Promise<DesktopAppState> {
    const state = await orchestration.sendChildThreadFollowUp(this, input);
    this.scheduleOrchestrationSupervision();
    return state;
  }

  async setChildSupervisionLoop(input: SetChildSupervisionLoopInput): Promise<DesktopAppState> {
    const state = await orchestration.setChildSupervisionLoopGate(this, input);
    this.scheduleOrchestrationSupervision();
    return state;
  }

  /* ── View / UI state ───────────────────────────────────── */

  async setActiveView(activeView: AppView): Promise<DesktopAppState> {
    await this.initialize();
    if (this.state.activeView === "threads" && activeView !== "threads") {
      const sessionRef = this.selectedSessionRef();
      if (sessionRef) {
        await this.cancelPendingDialogsForSession(sessionRef);
      }
    }
    this.state = {
      ...this.state,
      activeView,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    if (activeView === "threads") {
      this.markSelectedSessionViewedIfVisible();
    }
    await this.persistUiState();
    return this.emit();
  }

  async setSidebarCollapsed(sidebarCollapsed: boolean): Promise<DesktopAppState> {
    await this.initialize();
    if (this.state.sidebarCollapsed === sidebarCollapsed) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      sidebarCollapsed,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setNotificationPreferences(preferences: Partial<NotificationPreferences>): Promise<DesktopAppState> {
    await this.initialize();
    this.state = {
      ...this.state,
      notificationPreferences: {
        ...this.state.notificationPreferences,
        ...preferences,
      },
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setIntegratedTerminalShell(integratedTerminalShell: string): Promise<DesktopAppState> {
    await this.initialize();
    const normalizedShell = integratedTerminalShell.trim();
    if (this.state.integratedTerminalShell === normalizedShell) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      integratedTerminalShell: normalizedShell,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setEnableTransparency(enabled: boolean): Promise<DesktopAppState> {
    await this.initialize();
    if (this.state.enableTransparency === enabled) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      enableTransparency: enabled,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setThemeMode(themeMode: ThemeMode): Promise<DesktopAppState> {
    await this.initialize();
    if (!isThemeMode(themeMode)) {
      throw new Error(`Unsupported theme mode: ${String(themeMode)}`);
    }
    if (this.state.themeMode === themeMode) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      themeMode,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setThemePresetId(themePresetId: ThemePresetId): Promise<DesktopAppState> {
    await this.initialize();
    if (!isThemePresetId(themePresetId)) {
      throw new Error(`Unsupported theme preset: ${String(themePresetId)}`);
    }
    if (this.state.themePresetId === themePresetId) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      themePresetId,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setModelSettingsScopeMode(modelSettingsScopeMode: ModelSettingsScopeMode): Promise<DesktopAppState> {
    await this.initialize();
    if (this.state.modelSettingsScopeMode === modelSettingsScopeMode) {
      return this.emit();
    }
    if (modelSettingsScopeMode === "app-global") {
      await this.restoreGlobalModelSettings(this.state.globalModelSettings);
    }
    this.state = {
      ...this.state,
      modelSettingsScopeMode,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.refreshState({ clearLastError: true });
  }

  /* ── Runtime / model / provider settings ───────────────── */

  async refreshRuntime(workspaceId?: string): Promise<DesktopAppState> {
    await this.initialize();
    const resolvedWorkspaceId = workspaceId || this.state.selectedWorkspaceId;
    const ws = this.workspaceRefFromState(resolvedWorkspaceId);
    if (!ws) {
      return this.emit();
    }

    return this.withErrorHandling(async () => {
      const snapshot = await this.driver.runtimeSupervisor.refreshRuntime(ws);
      this.runtimeByWorkspace.set(ws.workspaceId, snapshot);
      this.clearExtensionUiForWorkspace(ws.workspaceId);
      await this.reloadSessionsForWorkspace(ws.workspaceId);
      await this.refreshSessionCommandsForWorkspace(ws.workspaceId);
      return this.refreshState({ clearLastError: true });
    });
  }

  async setSessionModel(target: WorkspaceSessionTarget, provider: string, modelId: string): Promise<DesktopAppState> {
    return composer.setSessionModel(this, target, provider, modelId);
  }

  async setDefaultModel(workspaceId: string, provider: string, modelId: string): Promise<DesktopAppState> {
    const targetWorkspaceId = this.resolveModelSettingsWorkspaceId(workspaceId);
    if (this.state.modelSettingsScopeMode !== "per-repo") {
      return this.withRuntimeUpdate(targetWorkspaceId, (ws) =>
        this.driver.runtimeSupervisor.setDefaultModel(ws, { provider, modelId }),
      );
    }
    await this.initialize();
    const ws = this.workspaceRefFromState(targetWorkspaceId);
    if (!ws) {
      return this.withError(`Unknown workspace: ${targetWorkspaceId}`);
    }
    return this.withErrorHandling(async () => {
      const snapshot = await this.driver.runtimeSupervisor.setProjectDefaultModel(ws, { provider, modelId });
      await this.recordSettingsSelfWrite();
      this.runtimeByWorkspace.set(ws.workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    });
  }

  async setDefaultThinkingLevel(
    workspaceId: string,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<DesktopAppState> {
    const targetWorkspaceId = this.resolveModelSettingsWorkspaceId(workspaceId);
    if (this.state.modelSettingsScopeMode !== "per-repo") {
      return this.withRuntimeUpdate(targetWorkspaceId, (ws) =>
        this.driver.runtimeSupervisor.setDefaultThinkingLevel(ws, thinkingLevel),
      );
    }
    await this.initialize();
    const ws = this.workspaceRefFromState(targetWorkspaceId);
    if (!ws) {
      return this.withError(`Unknown workspace: ${targetWorkspaceId}`);
    }
    return this.withErrorHandling(async () => {
      const snapshot = await this.driver.runtimeSupervisor.setProjectDefaultThinkingLevel(ws, thinkingLevel);
      await this.recordSettingsSelfWrite();
      this.runtimeByWorkspace.set(ws.workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    });
  }

  async setSessionThinkingLevel(
    sessionRef: SessionRef,
    thinkingLevel: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  ): Promise<DesktopAppState> {
    return composer.setSessionThinkingLevel(this, sessionRef, thinkingLevel);
  }

  async loginProvider(workspaceId: string, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<DesktopAppState> {
    await this.initialize();
    const targetWorkspaceId = this.resolveModelSettingsWorkspaceId(workspaceId);
    const ws = this.workspaceRefFromState(workspaceId);
    if (!ws) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    return this.withErrorHandling(async () => {
      const snapshot = await this.driver.runtimeSupervisor.login(ws, providerId, callbacks);
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      await this.autoEnableModelsForConnectedProvider(targetWorkspaceId, providerId, snapshot);
      await this.refreshSessionCommandsForWorkspace(workspaceId);
      return this.refreshState({ clearLastError: true });
    });
  }

  async logoutProvider(workspaceId: string, providerId: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.logout(ws, providerId),
    );
  }

  async setProviderApiKey(workspaceId: string, providerId: string, apiKey: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setProviderApiKey(ws, providerId, apiKey),
    );
  }

  async listCustomProviders(): Promise<readonly CustomProviderConfig[]> {
    await this.initialize();
    const entries = await this.driver.runtimeSupervisor.listCustomProviders();
    return entries.map((entry) => ({
      providerId: entry.providerId,
      baseUrl: entry.baseUrl,
      ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
      models: entry.models.map((model) => ({
        id: model.id,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      })),
    }));
  }

  async setCustomProvider(workspaceId: string, config: CustomProviderConfig): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setCustomProvider(ws, {
        providerId: config.providerId,
        baseUrl: config.baseUrl,
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        models: config.models.map((model) => ({
          id: model.id,
          ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        })),
      }),
      { refreshAllWorkspaces: true },
    );
  }

  async deleteCustomProvider(workspaceId: string, providerId: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.deleteCustomProvider(ws, providerId),
      { refreshAllWorkspaces: true },
    );
  }

  async setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setEnableSkillCommands(ws, enabled),
      { reloadSessions: true },
    );
  }

  async setScopedModelPatterns(workspaceId: string, patterns: readonly string[]): Promise<DesktopAppState> {
    const targetWorkspaceId = this.resolveModelSettingsWorkspaceId(workspaceId);
    if (this.state.modelSettingsScopeMode !== "per-repo") {
      return this.withRuntimeUpdate(targetWorkspaceId, (ws) =>
        this.driver.runtimeSupervisor.setScopedModelPatterns(ws, patterns),
      );
    }
    await this.initialize();
    const ws = this.workspaceRefFromState(targetWorkspaceId);
    if (!ws) {
      return this.withError(`Unknown workspace: ${targetWorkspaceId}`);
    }
    return this.withErrorHandling(async () => {
      const snapshot = await this.driver.runtimeSupervisor.setProjectScopedModelPatterns(ws, patterns);
      await this.recordSettingsSelfWrite();
      this.runtimeByWorkspace.set(ws.workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    });
  }

  private async autoEnableModelsForConnectedProvider(
    workspaceId: string,
    providerId: string,
    snapshot: RuntimeSnapshot,
  ): Promise<void> {
    const providerModelPatterns = [...new Set(
      snapshot.models
        .filter((model) => model.available && model.providerId === providerId)
        .map((model) => `${model.providerId}/${model.modelId}`),
    )];
    if (providerModelPatterns.length === 0) {
      return;
    }

    const currentPatterns = snapshot.settings.enabledModelPatterns;
    if (currentPatterns.length === 0) {
      return;
    }

    const nextPatterns = mergeEnabledModelPatterns(currentPatterns, providerModelPatterns);
    if (nextPatterns.length === currentPatterns.length) {
      return;
    }

    if (this.state.modelSettingsScopeMode !== "per-repo") {
      const ownerWorkspace = this.workspaceRefFromState(workspaceId);
      if (!ownerWorkspace) {
        return;
      }
      const updatedSnapshot = await this.driver.runtimeSupervisor.setScopedModelPatterns(ownerWorkspace, nextPatterns);
      this.runtimeByWorkspace.set(workspaceId, updatedSnapshot);
      return;
    }

    const ownerWorkspace = this.workspaceRefFromState(workspaceId);
    if (!ownerWorkspace) {
      return;
    }
    const updatedSnapshot = await this.driver.runtimeSupervisor.setProjectScopedModelPatterns(ownerWorkspace, nextPatterns);
    this.runtimeByWorkspace.set(workspaceId, updatedSnapshot);
  }

  async setSkillEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setSkillEnabled(ws, filePath, enabled),
      { reloadSessions: true },
    );
  }

  async setExtensionEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setExtensionEnabled(ws, filePath, enabled),
      { reloadSessions: true },
    );
  }

  private async withRuntimeUpdate(
    workspaceId: string,
    action: (ws: WorkspaceRef) => Promise<RuntimeSnapshot>,
    options?: {
      readonly reloadSessions?: boolean;
      readonly refreshAllWorkspaces?: boolean;
    },
  ): Promise<DesktopAppState> {
    await this.initialize();
    const ws = this.workspaceRefFromState(workspaceId);
    if (!ws) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    return this.withErrorHandling(async () => {
      const snapshot = await action(ws);
      // The action just flushed settings files that focus reconcile watches by mtime; record the
      // new mtimes so this self-write is not mistaken for an external edit on the next focus.
      await this.recordSettingsSelfWrite();
      if (options?.refreshAllWorkspaces) {
        await this.refreshRuntimeForAllWorkspaces(workspaceId, snapshot);
      } else {
        this.runtimeByWorkspace.set(workspaceId, snapshot);
      }
      if (options?.reloadSessions) {
        this.clearExtensionUiForWorkspace(workspaceId);
        await this.reloadSessionsForWorkspace(workspaceId);
      }
      if (options?.refreshAllWorkspaces) {
        await this.refreshSessionCommandsForAllWorkspaces();
      } else {
        await this.refreshSessionCommandsForWorkspace(workspaceId);
      }
      return this.refreshState({ clearLastError: true });
    });
  }

  private async refreshRuntimeForAllWorkspaces(
    updatedWorkspaceId: string,
    updatedSnapshot: RuntimeSnapshot,
  ): Promise<void> {
    this.runtimeByWorkspace.set(updatedWorkspaceId, updatedSnapshot);
    const workspacesToRefresh = this.state.workspaces.filter((workspace) => workspace.id !== updatedWorkspaceId);
    const snapshots = await Promise.allSettled(
      workspacesToRefresh.map(async (workspace) => {
        const runtime = await this.driver.runtimeSupervisor.refreshRuntime({
          workspaceId: workspace.id,
          path: workspace.path,
          displayName: workspace.name,
        });
        return [workspace, runtime] as const;
      }),
    );
    snapshots.forEach((result, index) => {
      const workspace = workspacesToRefresh[index];
      if (result.status === "fulfilled") {
        this.runtimeByWorkspace.set(result.value[0].id, result.value[1]);
        return;
      }
      console.warn(
        `[pi-gui] Failed to refresh runtime for ${workspace?.path ?? "unknown workspace"} after custom provider update: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
    });
  }

  private async refreshSessionCommandsForAllWorkspaces(): Promise<void> {
    const results = await Promise.allSettled(
      this.state.workspaces.map((workspace) => this.refreshSessionCommandsForWorkspace(workspace.id)),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        return;
      }
      const workspace = this.state.workspaces[index];
      console.warn(
        `[pi-gui] Failed to refresh session commands for ${workspace?.path ?? "unknown workspace"} after custom provider update: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
    });
  }

  /* ── Internal infrastructure (AppStoreInternals) ───────── */

  private async initializeInternal(): Promise<void> {
    const persisted = await this.readUiState();
    const startupDiagnostics: StartupDiagnostic[] = [];
    try {
      this.restorePersistedUiState(persisted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[app-store] ignoring malformed persisted UI state", error);
      startupDiagnostics.push({
        scope: "application",
        message: `Persisted UI state could not be fully restored: ${message}`,
      });
    }
    try {
      await this.migrateLegacyPersistence(persisted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[app-store] ignoring malformed legacy UI state", error);
      startupDiagnostics.push({
        scope: "application",
        message: `Legacy UI state could not be fully migrated: ${message}`,
      });
    }

    try {
      const initialWorkspacePaths = this.initialWorkspacePaths.map((path) => path.trim()).filter(Boolean);
      const knownWorkspaces = await this.driver.listWorkspaces();
      const workspacesToSync = new Map<string, string | undefined>();

      for (const workspacePath of initialWorkspacePaths) {
        workspacesToSync.set(workspacePath, undefined);
      }

      for (const ws of knownWorkspaces.workspaces) {
        workspacesToSync.set(ws.path, ws.displayName);
      }

      const syncDiagnostics = await Promise.all(
        [...workspacesToSync.entries()].map(([workspacePath, displayName]) =>
          this.syncStartupWorkspace(workspacePath, displayName),
        ),
      );
      startupDiagnostics.push(
        ...syncDiagnostics.filter((diagnostic): diagnostic is StartupDiagnostic => Boolean(diagnostic)),
      );

      await this.refreshState({
        selectedWorkspaceId: persisted.selectedWorkspaceId,
        selectedSessionId: persisted.selectedSessionId,
        composerDraft: persisted.composerDraft,
        clearLastError: true,
        refreshWorktrees: true,
        hydrateSelectedSession: false,
        markSelectedSessionViewed: false,
      });
      // Startup GC of leaked pi/* worktrees and branches; self-contained and
      // error-swallowing, so fire-and-forget without blocking initialization.
      void worktree.reconcileWorktrees(this);
      const restoredSessionRef = this.selectedSessionRef();
      if (restoredSessionRef && persisted.selectedWorkspaceId && persisted.selectedSessionId) {
        this.restoredSelectedSessionKeysAwaitingSelection.add(sessionKey(restoredSessionRef));
      }
      this.startSelectedSessionHydration(restoredSessionRef, { markViewed: false });
      this.scheduleOrchestrationSupervision();
      this.publishStartupDiagnostics(startupDiagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[app-store] startup recovery failed", error);
      startupDiagnostics.push({
        scope: "application",
        message,
      });
      this.state = {
        ...this.state,
        startupDiagnostics,
        lastError: message,
        revision: this.state.revision + 1,
      };
      this.emit();
    }
  }

  private restorePersistedUiState(persisted: LegacyPersistedUiState): void {
    this.state = {
      ...this.state,
      selectedWorkspaceId: persisted.selectedWorkspaceId ?? this.state.selectedWorkspaceId,
      selectedSessionId: persisted.selectedSessionId ?? this.state.selectedSessionId,
      activeView: persisted.activeView ?? this.state.activeView,
      composerDraft: persisted.composerDraft ?? this.state.composerDraft,
      modelSettingsScopeMode: persisted.modelSettingsScopeMode ?? this.state.modelSettingsScopeMode,
      globalModelSettings: persisted.appGlobalModelSettings ?? this.state.globalModelSettings,
      notificationPreferences: {
        ...this.state.notificationPreferences,
        ...persisted.notificationPreferences,
      },
      integratedTerminalShell: persisted.integratedTerminalShell ?? this.state.integratedTerminalShell,
      lastViewedAtBySession: persisted.lastViewedAtBySession ?? {},
      pinnedAtBySession: persisted.pinnedAtBySession ?? {},
      pinnedSessionOrder: persisted.pinnedSessionOrder ?? [],
      workspaceOrder: persisted.workspaceOrder ?? [],
      themeMode: persisted.themeMode ?? this.state.themeMode,
      themePresetId: persisted.themePresetId ?? this.state.themePresetId,
      sidebarCollapsed: persisted.sidebarCollapsed ?? this.state.sidebarCollapsed,
      enableTransparency: persisted.enableTransparency ?? this.state.enableTransparency,
      orchestrationChildren: persisted.orchestrationChildren ?? [],
    };

    this.sessionState.lastViewedAtBySession.clear();
    for (const [key, viewedAt] of Object.entries(persisted.lastViewedAtBySession ?? {})) {
      if (viewedAt) {
        this.sessionState.lastViewedAtBySession.set(key, viewedAt);
      }
    }
    this.sessionState.pinnedAtBySession.clear();
    for (const [key, pinnedAt] of Object.entries(persisted.pinnedAtBySession ?? {})) {
      if (pinnedAt) {
        this.sessionState.pinnedAtBySession.set(key, pinnedAt);
      }
    }
    this.sessionState.pinnedSessionOrder = reconcilePinnedSessionOrder(
      this.sessionState.pinnedAtBySession,
      persisted.pinnedSessionOrder ?? [],
    ).slice();
    this.sessionState.composerDraftsBySession.clear();
    for (const [key, draft] of Object.entries(persisted.composerDraftsBySession ?? {})) {
      if (draft) {
        this.sessionState.composerDraftsBySession.set(key, draft);
      }
    }
    this.extensionCommandCompatibilityByWorkspace.clear();
    for (const [workspaceId, records] of restoreCompatibilityByWorkspace(
      persisted.extensionCommandCompatibilityByWorkspace,
    )) {
      this.extensionCommandCompatibilityByWorkspace.set(workspaceId, records);
    }
  }

  private async syncStartupWorkspace(
    workspacePath: string,
    displayName: string | undefined,
  ): Promise<StartupDiagnostic | undefined> {
    try {
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error("Path is not a directory.");
      }
      await this.driver.syncWorkspace(workspacePath, displayName);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[app-store] workspace unavailable during startup: ${workspacePath}: ${message}`);
      return {
        scope: "workspace",
        workspacePath,
        message,
      };
    }
  }

  private publishStartupDiagnostics(diagnostics: readonly StartupDiagnostic[]): void {
    if (diagnostics.length === 0) {
      return;
    }
    this.state = {
      ...this.state,
      startupDiagnostics: [...diagnostics],
      revision: this.state.revision + 1,
    };
    this.emit();
  }

  private async migrateLegacyPersistence(persisted: LegacyPersistedUiState): Promise<void> {
    const attachmentEntries = Object.entries(persisted.composerAttachmentsBySession ?? {});
    await Promise.all(
      attachmentEntries.map(async ([key, attachments]) => {
        const cloned = cloneComposerAttachments(attachments as readonly ComposerAttachment[]);
        if (cloned.length > 0) {
          this.sessionState.composerAttachmentsBySession.set(key, cloned);
          await this.attachmentStore.write(key, cloned);
        }
      }),
    );
  }

  async refreshState(options: RefreshStateOptions = {}): Promise<DesktopAppState> {
    const previousRefresh = this.refreshStateQueue;
    const refresh = previousRefresh
      .catch(() => undefined)
      .then(() => this.refreshStateNow(options));
    this.refreshStateQueue = refresh.then(
      () => undefined,
      () => undefined,
    );
    return refresh;
  }

  private async refreshStateNow(options: RefreshStateOptions): Promise<DesktopAppState> {
    this.refreshStateDepth += 1;
    try {
      const previousSelectedKey = this.currentSelectedSessionKey();
      const [workspacesSnapshot, sessionsSnapshot] = await Promise.all([
        this.driver.listWorkspaces(),
        this.driver.listSessions(),
      ]);
      const worktreeEntries = options.refreshWorktrees
        ? await worktree.syncAndListWorktrees(this, workspacesSnapshot.workspaces)
        : (await this.catalogStore.worktrees.listWorktrees()).worktrees;

      await this.pruneStaleSessionSubscriptions(sessionsSnapshot.sessions);
      await this.ensureSubscriptionsForSessions(sessionsSnapshot.sessions);

      const selectedWorkspaceId = resolveSelectedWorkspaceIdFromCatalog(
        options.selectedWorkspaceId ?? this.state.selectedWorkspaceId,
        workspacesSnapshot.workspaces,
      );
      const selectedSessionId = resolveSelectedSessionIdFromCatalog(
        selectedWorkspaceId,
        options.selectedSessionId ?? this.state.selectedSessionId,
        sessionsSnapshot.sessions,
      );

      if (selectedWorkspaceId && selectedSessionId && options.hydrateSelectedSession !== false) {
        const sessionRef = {
          workspaceId: selectedWorkspaceId,
          sessionId: selectedSessionId,
        };
        await this.ensureSessionReady(sessionRef);
        await this.ensureComposerAttachmentsLoaded(sessionRef);
      }

      const workspaces = buildWorkspaceRecords(
        workspacesSnapshot.workspaces,
        worktreeEntries,
        sessionsSnapshot.sessions,
        this.sessionState.transcriptCache,
        this.sessionState.runningSinceBySession,
        this.sessionState.sessionConfigBySession,
        this.sessionState.lastViewedAtBySession,
        this.sessionState.pinnedAtBySession,
      );
      const worktreesByWorkspace = buildWorktreeRecords(workspacesSnapshot.workspaces, worktreeEntries);
      const liveWorkspaceIds = new Set(workspaces.map((w) => w.id));
      for (const wsId of this.runtimeByWorkspace.keys()) {
        if (!liveWorkspaceIds.has(wsId)) {
          this.runtimeByWorkspace.delete(wsId);
        }
      }
      for (const workspaceId of this.extensionCommandCompatibilityByWorkspace.keys()) {
        if (!liveWorkspaceIds.has(workspaceId)) {
          this.extensionCommandCompatibilityByWorkspace.delete(workspaceId);
        }
      }

      if (selectedWorkspaceId && !this.runtimeByWorkspace.has(selectedWorkspaceId)) {
        await this.ensureRuntimeLoaded(selectedWorkspaceId, workspacesSnapshot.workspaces);
      }
      const secondaryWorkspacesToLoad = workspacesSnapshot.workspaces
        .filter((workspace) => workspace.workspaceId !== selectedWorkspaceId)
        .filter((workspace) => !this.runtimeByWorkspace.has(workspace.workspaceId));
      const secondaryRuntimeLoads = await Promise.allSettled(
        secondaryWorkspacesToLoad.map((workspace) => this.ensureRuntimeLoaded(workspace.workspaceId, workspacesSnapshot.workspaces)),
      );
      secondaryRuntimeLoads.forEach((result, index) => {
        if (result.status === "fulfilled") {
          return;
        }
        const failedWorkspace = secondaryWorkspacesToLoad[index];
        console.warn(
          `[pi-gui] Failed to preload runtime for ${failedWorkspace?.path ?? "unknown workspace"}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        );
      });
      for (const runtime of this.runtimeByWorkspace.values()) {
        pruneCompatibilityForRuntimeSnapshot(this.extensionCommandCompatibilityByWorkspace, runtime);
      }
      const liveGlobalModelSettings = await this.loadLiveGlobalModelSettings(
        workspacesSnapshot.workspaces,
        selectedWorkspaceId || workspacesSnapshot.workspaces[0]?.workspaceId,
      );
      const globalModelSettings =
        this.state.modelSettingsScopeMode === "per-repo" && hasStoredModelSettings(this.state.globalModelSettings)
          ? this.state.globalModelSettings
          : liveGlobalModelSettings;
      if (
        this.state.modelSettingsScopeMode === "per-repo" &&
        hasStoredModelSettings(globalModelSettings) &&
        !modelSettingsEqual(globalModelSettings, liveGlobalModelSettings)
      ) {
        await this.restoreGlobalModelSettings(globalModelSettings, workspacesSnapshot.workspaces, selectedWorkspaceId);
      }
      const scopedModelSettingsByWorkspace =
        this.state.modelSettingsScopeMode === "per-repo"
          ? await this.loadScopedModelSettingsByWorkspace(workspaces, workspacesSnapshot.workspaces, globalModelSettings)
          : undefined;
      const runtimeByWorkspace = this.serializeEffectiveRuntimeState(workspaces, scopedModelSettingsByWorkspace);
      const pinnedSessionOrder = reconcilePinnedSessionOrder(
        this.sessionState.pinnedAtBySession,
        this.sessionState.pinnedSessionOrder,
      );
      this.sessionState.pinnedSessionOrder = [...pinnedSessionOrder];

      const activeView = options.activeView ?? this.state.activeView;
      const composerDraftSync = this.resolveComposerDraftSync(selectedWorkspaceId, selectedSessionId, options);
      this.state = {
        ...this.state,
        workspaces,
        worktreesByWorkspace,
        selectedWorkspaceId,
        selectedSessionId,
        activeView,
        runtimeByWorkspace,
        sessionCommandsBySession: mapToRecord(this.sessionState.sessionCommandsBySession),
        sessionExtensionUiBySession: this.serializeSessionExtensionUiState(),
        extensionCommandCompatibilityByWorkspace: serializeCompatibilityByWorkspace(this.extensionCommandCompatibilityByWorkspace),
        orchestrationChildren: this.state.orchestrationChildren,
        lastViewedAtBySession: mapToRecord(this.sessionState.lastViewedAtBySession),
        pinnedAtBySession: mapToRecord(this.sessionState.pinnedAtBySession),
        pinnedSessionOrder,
        workspaceOrder: this.state.workspaceOrder,
        modelSettingsScopeMode: this.state.modelSettingsScopeMode,
        globalModelSettings,
        composerDraft: this.resolveComposerDraft(selectedWorkspaceId, selectedSessionId, options.composerDraft),
        composerDraftSyncSource: composerDraftSync.source,
        composerDraftSyncNonce: composerDraftSync.nonce,
        composerAttachments: this.resolveComposerAttachments(selectedWorkspaceId, selectedSessionId),
        queuedComposerMessages: this.resolveQueuedComposerMessages(selectedWorkspaceId, selectedSessionId),
        editingQueuedMessageId: this.resolveEditingQueuedMessageId(selectedWorkspaceId, selectedSessionId),
        lastError: this.resolveSelectedSessionError(selectedWorkspaceId, selectedSessionId, options.clearLastError),
        revision: this.state.revision + 1,
      };
      await orchestration.hydrateOrchestrationChildren(this);
      this.state = {
        ...this.state,
        orchestrationChildren: orchestration.projectOrchestrationChildren(this),
      };
      this.scheduleOrchestrationSupervision();

      if (options.markSelectedSessionViewed ?? true) {
        this.markSelectedSessionViewedIfVisible();
      }

      if (options.persistState ?? true) {
        await this.persistUiState();
      }
      const snapshot = options.emitState === false ? structuredClone(this.state) : this.emit();
      if ((options.publishSelectedTranscript ?? true) && this.currentSelectedSessionKey() !== previousSelectedKey) {
        this.publishSelectedTranscript();
      }
      return snapshot;
    } finally {
      this.refreshStateDepth = Math.max(0, this.refreshStateDepth - 1);
    }
  }

  private async pruneStaleSessionSubscriptions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    const activeKeys = new Set(sessions.map((session) => sessionKey(session.sessionRef)));
    const persistedUiChanged = this.sessionState.prune(activeKeys);
    for (const key of this.sessionSchemaInfoCache.keys()) {
      if (!activeKeys.has(key)) {
        this.sessionSchemaInfoCache.delete(key);
      }
    }
    this.pruneOrphanedUiState(activeKeys, persistedUiChanged);
    await this.pruneOrphanedAttachmentFiles(activeKeys);
  }

  /** Drop ui-state entries for sessions that no longer exist in the catalog. */
  private pruneOrphanedUiState(activeKeys: Set<string>, alreadyChanged = false): void {
    if (this.sessionState.prunePersistedUiState(activeKeys) || alreadyChanged) {
      this.schedulePersistUiState();
    }
  }

  private async pruneOrphanedAttachmentFiles(activeKeys: Set<string>): Promise<void> {
    const keys = await this.attachmentStore.listKeys();
    await Promise.all(keys.filter((key) => !activeKeys.has(key)).map((key) => this.attachmentStore.remove(key)));
  }

  private async ensureSubscriptionsForSessions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    for (const session of sessions) {
      if (session.status !== "running") {
        continue;
      }
      await this.ensureSessionSubscription(session.sessionRef);
    }
  }

  async ensureSessionReady(sessionRef: SessionRef): Promise<SessionSnapshot | undefined> {
    await this.ensureTranscriptLoaded(sessionRef);
    let snapshot: SessionSnapshot | undefined;
    if (!this.sessionState.sessionSubscriptions.has(sessionKey(sessionRef))) {
      snapshot = await this.driver.openSession(sessionRef);
      this.updateSessionConfig(sessionRef, snapshot.config);
    }
    await this.ensureSessionSubscribed(sessionRef);
    await this.refreshSessionCommands(sessionRef);
    return snapshot;
  }

  async ensureSessionSubscription(sessionRef: SessionRef): Promise<void> {
    if (!this.sessionState.sessionSubscriptions.has(sessionKey(sessionRef))) {
      const snapshot = await this.driver.openSession(sessionRef);
      this.updateSessionConfig(sessionRef, snapshot.config);
      this.updateQueuedComposerMessages(sessionRef, snapshot.queuedMessages);
    }
    await this.ensureSessionSubscribed(sessionRef);
  }

  private async ensureTranscriptLoaded(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionState.loadedTranscriptKeys.has(key)) {
      return;
    }

    const transcript = timelineFromDriverTranscript(await this.driver.getTranscript(sessionRef));
    this.sessionState.loadedTranscriptKeys.add(key);
    this.sessionState.transcriptCache.set(key, transcript);
    await this.recordSelectedTranscriptFileStat(sessionRef);
  }

  /**
   * Post-run reload of the settled transcript from the session file. The file
   * is canonical after a run, but a lagging or partial read (or a driver that
   * doesn't persist transcripts, as in tests) must never wipe a richer live
   * timeline — compare substantive rows (messages + tools; the live timeline
   * also carries activity rows the file never has) and keep the live timeline
   * when the parse comes up short.
   */
  private async reloadTranscriptFromDriverIfComplete(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    let parsed: TranscriptMessage[];
    try {
      parsed = timelineFromDriverTranscript(await this.driver.getTranscript(sessionRef));
    } catch {
      return;
    }
    const substantiveRows = (items: readonly TranscriptMessage[]): number =>
      items.reduce((count, item) => (item.kind === "message" || item.kind === "tool" ? count + 1 : count), 0);
    const current = this.sessionState.transcriptCache.get(key) ?? [];
    if (substantiveRows(parsed) < substantiveRows(current)) {
      return;
    }
    this.sessionState.loadedTranscriptKeys.add(key);
    this.sessionState.transcriptCache.set(key, parsed);
    await this.recordSelectedTranscriptFileStat(sessionRef);
    this.publishSelectedTranscriptFor(sessionRef);
  }

  async reloadTranscriptFromDriver(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    const transcript = timelineFromDriverTranscript(await this.driver.getTranscript(sessionRef));
    this.sessionState.loadedTranscriptKeys.add(key);
    this.sessionState.transcriptCache.set(key, transcript);
    await this.recordSelectedTranscriptFileStat(sessionRef);
    this.publishSelectedTranscriptFor(sessionRef);
  }

  /* ── CLI ↔ GUI reconcile (startup / workspace switch / window focus) ─────── */

  /**
   * Reconcile the active workspace against pi's on-disk state when the window
   * gains focus (the Codex-style sync model — no live filesystem watcher). Runs
   * through a per-workspace serial queue so focus bursts never overlap or race.
   * A rejection is logged and swallowed so it can't wedge the queue.
   */
  private reconcileWorkspaceOnFocus(workspaceId: string): void {
    this.enqueueWorkspaceReconcile(workspaceId, () => this.reconcileWorkspaceFromDisk(workspaceId));
  }

  private enqueueWorkspaceReconcile(workspaceId: string, work: () => Promise<void>): void {
    const previous = this.externalChangeQueues.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((error) => {
        console.error(`[app-store] workspace reconcile failed for ${workspaceId}`, error);
      });
    this.externalChangeQueues.set(workspaceId, next);
    void next.finally(() => {
      if (this.externalChangeQueues.get(workspaceId) === next) {
        this.externalChangeQueues.delete(workspaceId);
      }
    });
  }

  private async reconcileWorkspaceFromDisk(workspaceId: string): Promise<void> {
    // Re-scan the pi session dir into the catalog so a CLI-created session appears.
    // We deliberately do NOT call reloadSessionsForWorkspace here: reloadSession
    // resets a session's live extension UI (dropping pending dialogs, including
    // ones shared across windows). The catalog resync updates the session list,
    // and the selected session's transcript is refreshed non-destructively below.
    await this.driver.reconcileWorkspace(workspaceId);
    // An out-of-band file replacement can change the schema version, so drop
    // cached schema info for this workspace; it is re-read on the next publish.
    this.invalidateSessionSchemaInfoForWorkspace(workspaceId);

    // Pick up external settings edits without a restart, before the refreshState
    // below so a single emit carries the reloaded runtime.
    await this.reloadSettingsIfChangedOnFocus(workspaceId);

    await this.refreshState({ persistState: false });

    await this.reloadSelectedTranscriptIfChangedOnFocus(workspaceId);
  }

  /**
   * Stat the global and per-workspace settings files and reload the runtime only
   * when one changed since the last check. Cheap (a couple of stats per focus)
   * and reload-storm-free: the first check just seeds the baseline, and the app's
   * own settings writes update the baseline (see {@link recordSettingsSelfWrite})
   * so a self-write never triggers a refresh that would clobber the selection.
   */
  private async reloadSettingsIfChangedOnFocus(workspaceId: string): Promise<void> {
    const workspacePath = this.state.workspaces.find((entry) => entry.id === workspaceId)?.path;
    if (!workspacePath) {
      return;
    }
    const files = [resolveGlobalSettingsPath(), join(workspacePath, ".pi", "settings.json")];
    let changed = false;
    for (const file of files) {
      const mtimeMs = await statMtimeMs(file);
      if (mtimeMs === undefined) {
        continue;
      }
      const previous = this.settingsFileMtimes.get(file);
      if (previous !== undefined && previous !== mtimeMs) {
        changed = true;
      }
      this.settingsFileMtimes.set(file, mtimeMs);
    }
    if (!changed) {
      return;
    }
    const ws = this.workspaceRefFromState(workspaceId);
    if (ws) {
      this.runtimeByWorkspace.set(workspaceId, await this.driver.runtimeSupervisor.refreshRuntime(ws));
    }
  }

  /**
   * Republish the viewed transcript only when its on-disk JSONL actually changed
   * (an external CLI append). Comparing mtime/size against the baseline recorded
   * when the transcript was last loaded means an unchanged session never
   * re-triggers scroll restore. A streaming session is skipped: its live events
   * already drive the transcript and the file churns continuously.
   */
  private async reloadSelectedTranscriptIfChangedOnFocus(workspaceId: string): Promise<void> {
    const selected = this.selectedSessionRef();
    if (
      !selected ||
      selected.workspaceId !== workspaceId ||
      this.sessionState.runningSinceBySession.has(sessionKey(selected))
    ) {
      return;
    }
    const previous = this.selectedTranscriptFileStats.get(sessionKey(selected));
    const current = await this.statSelectedTranscriptFile(selected);
    if (!current) {
      return;
    }
    if (previous && previous.mtimeMs === current.mtimeMs && previous.size === current.size) {
      return;
    }
    // reloadTranscriptFromDriver re-records the baseline, so a later unchanged
    // focus is a no-op.
    await this.reloadTranscriptFromDriver(selected);
  }

  private async statSelectedTranscriptFile(
    sessionRef: SessionRef,
  ): Promise<{ readonly mtimeMs: number; readonly size: number } | undefined> {
    let path: string | undefined;
    try {
      path = await this.driver.getSessionFilePath(sessionRef);
    } catch {
      path = undefined;
    }
    if (!path) {
      return undefined;
    }
    try {
      const stats = await stat(path);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return undefined;
    }
  }

  private async recordSelectedTranscriptFileStat(sessionRef: SessionRef): Promise<void> {
    const stats = await this.statSelectedTranscriptFile(sessionRef);
    const key = sessionKey(sessionRef);
    if (stats) {
      this.selectedTranscriptFileStats.set(key, stats);
    } else {
      this.selectedTranscriptFileStats.delete(key);
    }
  }

  /**
   * Record the current mtime of every tracked settings file after the app writes
   * settings itself, so the write is not mistaken for an external edit on the
   * next focus (which would refresh the runtime and resurrect models the user
   * just narrowed away).
   */
  private async recordSettingsSelfWrite(): Promise<void> {
    for (const file of this.settingsFileMtimes.keys()) {
      const mtimeMs = await statMtimeMs(file);
      if (mtimeMs !== undefined) {
        this.settingsFileMtimes.set(file, mtimeMs);
      }
    }
  }

  private invalidateSessionSchemaInfoForWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}:`;
    for (const key of this.sessionSchemaInfoCache.keys()) {
      if (key.startsWith(prefix)) {
        this.sessionSchemaInfoCache.delete(key);
      }
    }
  }

  private async ensureComposerAttachmentsLoaded(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionState.composerAttachmentsBySession.has(key)) {
      return;
    }

    const attachments = await this.attachmentStore.read(key);
    if (attachments?.length) {
      this.sessionState.composerAttachmentsBySession.set(key, cloneComposerAttachments(attachments));
    }
  }

  private async ensureRuntimeLoaded(
    workspaceId: string,
    workspaces?: readonly { workspaceId: string; path: string; displayName: string }[],
  ): Promise<void> {
    if (this.runtimeByWorkspace.has(workspaceId)) {
      return;
    }

    const ws =
      this.workspaceRefFromState(workspaceId) ??
      workspaces?.find((entry) => entry.workspaceId === workspaceId);
    if (!ws) {
      return;
    }

    const snapshot = await this.driver.runtimeSupervisor.getRuntimeSnapshot({
      workspaceId: ws.workspaceId,
      path: ws.path,
      displayName: ws.displayName,
    });
    this.runtimeByWorkspace.set(workspaceId, snapshot);
    // Seed the settings-file baseline so an external edit made before the first
    // focus is still detected as changed rather than swallowed by that first check.
    await this.seedSettingsMtimeBaseline(ws.path);
  }

  private async seedSettingsMtimeBaseline(workspacePath: string): Promise<void> {
    for (const file of [resolveGlobalSettingsPath(), join(workspacePath, ".pi", "settings.json")]) {
      if (this.settingsFileMtimes.has(file)) {
        continue;
      }
      const mtimeMs = await statMtimeMs(file);
      if (mtimeMs !== undefined) {
        this.settingsFileMtimes.set(file, mtimeMs);
      }
    }
  }

  async ensureSessionSubscribed(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionState.sessionSubscriptions.has(key)) {
      return;
    }

    const unsubscribe = this.driver.subscribe(sessionRef, (event) => {
      this.enqueueSessionEvent(event, key);
    });
    this.sessionState.sessionSubscriptions.set(key, unsubscribe);
  }

  /**
   * Serialize event handling per subscription key. The driver delivers events
   * synchronously but `handleSessionEvent` is async (it awaits refreshes,
   * persistence, listeners); firing each one with `void` let them interleave and
   * race the shared session state. A per-key FIFO queue runs them one at a time.
   * The chained promise is error-recovering — mirroring the driver's
   * `chainRecoveringEventQueue` shape — so a rejection is logged and swallowed
   * rather than leaving the tail rejected and freezing the queue for that session.
   */
  private enqueueSessionEvent(event: SessionDriverEvent, subscriptionKey: string): void {
    const previous = this.sessionEventQueues.get(subscriptionKey) ?? Promise.resolve();
    const next = previous
      .then(() => this.handleSessionEvent(event, subscriptionKey))
      .catch((error) => {
        console.error(`[app-store] session event queue error for ${subscriptionKey}`, error);
      });
    this.sessionEventQueues.set(subscriptionKey, next);
    void next.finally(() => {
      if (this.sessionEventQueues.get(subscriptionKey) === next) {
        this.sessionEventQueues.delete(subscriptionKey);
      }
    });
  }

  private migrateSessionSubscriptionKey(sourceKey: string, targetKey: string): void {
    if (sourceKey === targetKey) {
      return;
    }

    const unsubscribe = this.sessionState.sessionSubscriptions.get(sourceKey);
    if (!unsubscribe) {
      return;
    }

    if (this.sessionState.sessionSubscriptions.has(targetKey)) {
      unsubscribe();
      this.sessionState.sessionSubscriptions.delete(sourceKey);
      return;
    }

    this.sessionState.sessionSubscriptions.delete(sourceKey);
    this.sessionState.sessionSubscriptions.set(targetKey, unsubscribe);
  }

  async cancelPendingDialogsForSession(
    sessionRef: SessionRef,
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    if (!options.force && this.shouldKeepSessionDialogs(sessionRef)) {
      return;
    }
    const key = sessionKey(sessionRef);
    const uiState = this.sessionState.extensionUiBySession.get(key);
    if (!uiState || uiState.pendingDialogs.length === 0) {
      return;
    }

    const pendingDialogs = [...uiState.pendingDialogs];
    uiState.pendingDialogs = [];
    for (const dialog of pendingDialogs) {
      this.clearExtensionDialogTimeout(sessionRef, dialog.requestId);
    }
    this.state = this.syncDerivedSessionState(
      {
        ...this.state,
        revision: this.state.revision + 1,
      },
      sessionRef,
    );
    this.emit();
    await Promise.all(
      pendingDialogs.map((dialog) =>
        this.driver.respondToHostUiRequest(sessionRef, {
          requestId: dialog.requestId,
          cancelled: true,
        } satisfies HostUiResponse),
      ),
    );
  }

  async cancelPendingDialogsWithoutVisibleWindow(
    isSessionVisible: (sessionRef: SessionRef) => boolean,
  ): Promise<void> {
    await this.initialize();
    const pendingSessionRefs: SessionRef[] = [];
    for (const workspace of this.state.workspaces) {
      for (const session of workspace.sessions) {
        const sessionRef = { workspaceId: workspace.id, sessionId: session.id };
        const uiState = this.sessionState.extensionUiBySession.get(sessionKey(sessionRef));
        if (uiState && uiState.pendingDialogs.length > 0 && !isSessionVisible(sessionRef)) {
          pendingSessionRefs.push(sessionRef);
        }
      }
    }

    await Promise.all(
      pendingSessionRefs.map((sessionRef) => this.cancelPendingDialogsForSession(sessionRef, { force: true })),
    );
  }

  async respondToHostUiRequest(
    sessionRef: SessionRef,
    response: HostUiResponse,
  ): Promise<DesktopAppState> {
    this.removePendingExtensionDialog(sessionRef, response.requestId);
    this.clearExtensionDialogTimeout(sessionRef, response.requestId);

    return this.withErrorHandling(async () => {
      await this.driver.respondToHostUiRequest(sessionRef, response);
      return this.refreshState({ clearLastError: true });
    });
  }

  private async refreshSessionCommands(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    const commands = await this.driver.getSessionCommands(sessionRef);
    this.sessionState.sessionCommandsBySession.set(key, [...commands]);
  }

  async refreshSessionCommandsFor(sessionRef: SessionRef): Promise<void> {
    await this.refreshSessionCommands(sessionRef);
  }

  /**
   * Coalesce command refreshes for a single session. Status-change bursts
   * (`sessionUpdated`) used to await one `getSessionCommands` round-trip per
   * event on the serialized event queue, amplifying drain latency. Instead we run
   * at most one refresh at a time per session: requests arriving mid-flight mark
   * it dirty so exactly one trailing refresh runs afterward, keeping commands
   * correct for the final event without a redundant call per event. Runs detached
   * from the event queue and publishes the fresh commands itself once settled.
   */
  private refreshSessionCommandsCoalesced(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    const existing = this.sessionCommandRefreshers.get(key);
    if (existing) {
      existing.dirty = true;
      return;
    }

    const entry = { dirty: false };
    this.sessionCommandRefreshers.set(key, entry);
    void (async () => {
      let refreshed = false;
      try {
        do {
          entry.dirty = false;
          if (!this.sessionState.sessionSubscriptions.has(key)) {
            break;
          }
          try {
            await this.refreshSessionCommands(sessionRef);
            refreshed = true;
          } catch (error) {
            // A transient refresh failure must not drop the trailing refresh a
            // later status-change event already requested: keep the dirty bit so
            // the loop re-runs for it instead of aborting the burst.
            console.error(`[app-store] coalesced session command refresh failed for ${key}`, error);
          }
        } while (entry.dirty);
      } finally {
        this.sessionCommandRefreshers.delete(key);
        // The session can close (deleting its commands + unsubscribing) while a
        // refresh is in flight; the resolved refresh would then resurrect a stale
        // commands entry for a gone session, so drop it instead of publishing.
        if (!this.sessionState.sessionSubscriptions.has(key)) {
          this.sessionState.sessionCommandsBySession.delete(key);
        } else if (refreshed) {
          this.state = this.syncDerivedSessionState(this.state, sessionRef);
          this.emit();
        }
      }
    })();
  }

  getLearnedRuntimeCommandCompatibility(
    workspaceId: string,
    command: RuntimeCommandRecord,
  ): ExtensionCommandCompatibilityRecord | undefined {
    return getLearnedCommandCompatibility(this.extensionCommandCompatibilityByWorkspace, workspaceId, command);
  }

  beginRuntimeCommandExecution(sessionRef: SessionRef, command: RuntimeCommandRecord): void {
    this.pendingRuntimeCommandsBySession.set(sessionKey(sessionRef), { command });
  }

  finishRuntimeCommandExecution(
    sessionRef: SessionRef,
    timestamp = new Date().toISOString(),
  ): PendingRuntimeCommandExecution | undefined {
    const key = sessionKey(sessionRef);
    const pending = this.pendingRuntimeCommandsBySession.get(key);
    if (!pending) {
      return undefined;
    }

    this.pendingRuntimeCommandsBySession.delete(key);
    if (!pending.blockedMessage) {
      recordLearnedCommandCompatibility(this.extensionCommandCompatibilityByWorkspace, sessionRef.workspaceId, {
        commandName: pending.command.name,
        extensionPath: pending.command.sourceInfo.path,
        status: "supported",
        message: "Observed working in pi-gui.",
        capability: "gui-safe",
        updatedAt: timestamp,
      });
    }

    return pending;
  }

  clearExtensionUiForSession(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    if (!this.sessionState.extensionUiBySession.has(key)) {
      return;
    }

    this.clearExtensionDialogTimeoutsForSession(sessionRef);
    this.sessionState.extensionUiBySession.delete(key);
    this.state = this.syncDerivedSessionState(this.state, sessionRef);
  }

  private async refreshSessionCommandsForWorkspace(workspaceId: string): Promise<void> {
    const sessionRefs = this.sessionRefsForWorkspace(workspaceId);
    await Promise.all(sessionRefs.map((sessionRef) => this.refreshSessionCommands(sessionRef)));
  }

  private async reloadSessionsForWorkspace(workspaceId: string): Promise<void> {
    const sessionRefs = this.sessionRefsForWorkspace(workspaceId);
    await Promise.all(sessionRefs.map((sessionRef) => this.driver.reloadSession(sessionRef)));
  }

  private clearExtensionUiForWorkspace(workspaceId: string): void {
    for (const sessionRef of this.sessionRefsForWorkspace(workspaceId)) {
      this.clearExtensionUiForSession(sessionRef);
    }
  }

  private reportExtensionCompatibilityIssue(
    sessionRef: SessionRef,
    issue: Extract<SessionDriverEvent, { type: "extensionCompatibilityIssue" }>["issue"],
    timestamp: string,
  ): void {
    const key = sessionKey(sessionRef);
    const pending = this.pendingRuntimeCommandsBySession.get(key);
    if (pending) {
      const message = `/${pending.command.name} requires terminal-only ${formatCapabilityLabel(issue.capability)} and is not supported in pi-gui yet. Use pi in the terminal for this command.`;
      pending.blockedMessage = message;
      recordLearnedCommandCompatibility(this.extensionCommandCompatibilityByWorkspace, sessionRef.workspaceId, {
        commandName: pending.command.name,
        extensionPath: pending.command.sourceInfo.path,
        status: "terminal-only",
        message,
        capability: issue.capability,
        updatedAt: timestamp,
      });
      this.sessionState.sessionErrorsBySession.set(key, message);
      return;
    }

    const fingerprint = `${issue.extensionPath ?? "<unknown>"}:${issue.eventName ?? "<unknown>"}:${issue.capability}`;
    const seen = this.reportedCompatibilityIssuesBySession.get(key) ?? new Set<string>();
    if (seen.has(fingerprint)) {
      return;
    }

    seen.add(fingerprint);
    this.reportedCompatibilityIssuesBySession.set(key, seen);
    this.sessionState.sessionErrorsBySession.set(key, issue.message);
  }

  private sessionRefsForWorkspace(workspaceId: string): SessionRef[] {
    const workspace = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return [];
    }

    return workspace.sessions
      .map((session) => ({
        workspaceId,
        sessionId: session.id,
      }))
      .filter((sessionRef) => {
        const key = sessionKey(sessionRef);
        return (
          (this.state.selectedWorkspaceId === workspaceId && this.state.selectedSessionId === sessionRef.sessionId) ||
          this.sessionState.sessionCommandsBySession.has(key) ||
          this.sessionState.sessionSubscriptions.has(key)
        );
      });
  }

  private getOrCreateExtensionUiState(sessionRef: SessionRef) {
    const key = sessionKey(sessionRef);
    const existing = this.sessionState.extensionUiBySession.get(key);
    if (existing) {
      return existing;
    }

    const created = createEmptyExtensionUiState();
    this.sessionState.extensionUiBySession.set(key, created);
    return created;
  }

  private applyHostUiRequest(event: Extract<SessionDriverEvent, { type: "hostUiRequest" }>): void {
    const key = sessionKey(event.sessionRef);
    if (event.request.kind === "reset") {
      this.clearExtensionDialogTimeoutsForSession(event.sessionRef);
      this.sessionState.extensionUiBySession.delete(key);
      return;
    }

    const uiState = this.getOrCreateExtensionUiState(event.sessionRef);
    applyHostUiRequestToExtensionUiState(uiState, event.request);

    switch (event.request.kind) {
      case "editorText":
        this.sessionState.composerDraftsBySession.set(key, event.request.text);
        this.composerDraftSyncTarget = event.sessionRef;
        const composerDraftSyncNonce = this.allocateComposerDraftSyncNonce();
        if (
          this.state.selectedWorkspaceId === event.sessionRef.workspaceId &&
          this.state.selectedSessionId === event.sessionRef.sessionId
        ) {
          this.state = {
            ...this.state,
            composerDraft: event.request.text,
            composerDraftSyncSource: "extension-editor-text",
            composerDraftSyncNonce,
          };
        } else {
          this.state = {
            ...this.state,
            composerDraftSyncSource: "extension-editor-text",
            composerDraftSyncNonce,
          };
        }
        break;
      default:
        if (isExtensionUiDialogRequest(event.request)) {
          const dialog = event.request;
          this.clearExtensionDialogTimeout(event.sessionRef, dialog.requestId);
          uiState.pendingDialogs = [
            ...uiState.pendingDialogs.filter((entry) => entry.requestId !== dialog.requestId),
            dialog,
          ];
          this.scheduleExtensionDialogTimeout(event.sessionRef, dialog);
        }
        break;
    }
  }

  private extensionDialogTimeoutKey(sessionRef: SessionRef, requestId: string): string {
    return `${sessionKey(sessionRef)}:${requestId}`;
  }

  private clearExtensionDialogTimeout(sessionRef: SessionRef, requestId: string): void {
    const key = this.extensionDialogTimeoutKey(sessionRef, requestId);
    const timer = this.extensionDialogTimeoutTimers.get(key);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.extensionDialogTimeoutTimers.delete(key);
  }

  private clearExtensionDialogTimeoutsForSession(sessionRef: SessionRef): void {
    const prefix = `${sessionKey(sessionRef)}:`;
    for (const [key, timer] of this.extensionDialogTimeoutTimers) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      clearTimeout(timer);
      this.extensionDialogTimeoutTimers.delete(key);
    }
  }

  private removePendingExtensionDialog(sessionRef: SessionRef, requestId: string): boolean {
    const key = sessionKey(sessionRef);
    const uiState = this.sessionState.extensionUiBySession.get(key);
    if (!uiState) {
      return false;
    }

    const nextDialogs = uiState.pendingDialogs.filter((entry) => entry.requestId !== requestId);
    if (nextDialogs.length === uiState.pendingDialogs.length) {
      return false;
    }

    uiState.pendingDialogs = nextDialogs;
    this.state = this.syncDerivedSessionState(
      {
        ...this.state,
        revision: this.state.revision + 1,
      },
      sessionRef,
    );
    this.emit();
    return true;
  }

  private scheduleExtensionDialogTimeout(
    sessionRef: SessionRef,
    dialog: ExtensionUiDialogRequest,
  ): void {
    if (dialog.timeoutMs === undefined) {
      return;
    }

    const timerKey = this.extensionDialogTimeoutKey(sessionRef, dialog.requestId);
    const timer = setTimeout(() => {
      this.extensionDialogTimeoutTimers.delete(timerKey);
      this.removePendingExtensionDialog(sessionRef, dialog.requestId);
    }, dialog.timeoutMs);
    this.extensionDialogTimeoutTimers.set(timerKey, timer);
  }

  private async handleSessionEvent(event: SessionDriverEvent, subscriptionKey = sessionKey(event.sessionRef)): Promise<void> {
    const key = sessionKey(event.sessionRef);
    if (subscriptionKey !== key) {
      this.migrateSessionSubscriptionKey(subscriptionKey, key);
    }
    // Any transient failure while applying the event (a rejected refresh,
    // persistUiState, or listener) must never skip the final emit — otherwise the
    // UI is left stuck showing "running" forever. Apply-then-emit is wrapped so
    // the finally always publishes the latest state we managed to compute.
    try {
      const knownSession = this.sessionFromState(event.sessionRef);
      const shouldFollowSessionMutation = subscriptionKey !== key && this.currentSelectedSessionKey() === subscriptionKey;
      let refreshedFollowedSession = false;
      if (
        !knownSession &&
        (event.type === "sessionOpened" ||
          event.type === "sessionUpdated" ||
          event.type === "runCompleted" ||
          event.type === "hostUiRequest")
      ) {
        if (this.refreshStateDepth === 0) {
          await this.refreshState({
            selectedWorkspaceId:
              this.state.selectedWorkspaceId === event.sessionRef.workspaceId
                ? event.sessionRef.workspaceId
                : this.state.selectedWorkspaceId,
            selectedSessionId: shouldFollowSessionMutation ? event.sessionRef.sessionId : this.state.selectedSessionId,
            clearLastError: true,
          });
          refreshedFollowedSession = shouldFollowSessionMutation;
        } else {
          // The compensating reload that would pull this unknown session into
          // state is skipped while a refresh is already unwinding, and
          // applySessionEventState then silently no-ops for the missing session —
          // so the event (e.g. a rename) is dropped. Make that drop visible.
          console.warn(
            `[app-store] ${event.type} for unknown session ${key} skipped reload ` +
              `(refreshStateDepth=${this.refreshStateDepth}); event state not applied`,
          );
        }
      }

      switch (event.type) {
        case "assistantDelta":
          appendAssistantDelta(this.sessionState.transcriptCache, this.sessionState.activeAssistantMessageBySession, event.sessionRef, event.text);
          break;
        case "sessionOpened":
        case "runCompleted":
          this.updateSessionConfig(event.sessionRef, event.snapshot.config);
          this.updateQueuedComposerMessages(event.sessionRef, event.snapshot.queuedMessages);
          await this.refreshSessionCommands(event.sessionRef);
          if (event.type === "runCompleted") {
            // Live-event assistant messages are built without usage metadata;
            // re-read the settled transcript from the session file so fields
            // only present there (e.g. contextTokens) reach the UI.
            await this.reloadTranscriptFromDriverIfComplete(event.sessionRef);
          }
          break;
        case "sessionUpdated":
          this.updateSessionConfig(event.sessionRef, event.snapshot.config);
          this.updateQueuedComposerMessages(event.sessionRef, event.snapshot.queuedMessages);
          if (event.snapshot.status !== "running") {
            this.refreshSessionCommandsCoalesced(event.sessionRef);
          }
          break;
        case "runFailed":
          this.state = {
            ...this.state,
            lastError: event.error.message,
          };
          await this.refreshSessionCommands(event.sessionRef);
          break;
        case "extensionCompatibilityIssue":
          this.reportExtensionCompatibilityIssue(event.sessionRef, event.issue, event.timestamp);
          break;
        case "sessionClosed":
          this.clearExtensionDialogTimeoutsForSession(event.sessionRef);
          this.sessionState.extensionUiBySession.delete(key);
          this.sessionState.sessionCommandsBySession.delete(key);
          this.sessionState.queuedComposerMessagesBySession.delete(key);
          this.sessionState.queuedComposerEditsBySession.delete(key);
          this.clearPendingAutoTitle(event.sessionRef);
          this.pendingRuntimeCommandsBySession.delete(key);
          this.reportedCompatibilityIssuesBySession.delete(key);
          break;
        case "toolStarted":
        case "toolUpdated":
        case "toolFinished":
          break;
        case "hostUiRequest":
          this.applyHostUiRequest(event);
          break;
        default:
          break;
      }

      if (event.type === "sessionClosed") {
        this.sessionState.sessionSubscriptions.get(key)?.();
        this.sessionState.sessionSubscriptions.delete(key);
      }

      if (event.type === "runFailed") {
        this.sessionState.sessionErrorsBySession.set(key, event.error.message);
      } else if (event.type === "runCompleted" || event.type === "sessionClosed") {
        this.sessionState.sessionErrorsBySession.delete(key);
      }

      applyTimelineEvent(this.sessionState.transcriptCache, event, {
        runMetricsBySession: this.sessionState.runMetricsBySession,
        runningSinceBySession: this.sessionState.runningSinceBySession,
        activeAssistantMessageBySession: this.sessionState.activeAssistantMessageBySession,
        activeWorkingActivityBySession: this.sessionState.activeWorkingActivityBySession,
      });
      this.state = applySessionEventState(
        this.state,
        event,
        this.sessionState.transcriptCache,
        this.sessionState.runningSinceBySession,
        this.sessionState.lastViewedAtBySession,
      );
      if (event.type === "toolFinished") {
        await orchestration.handleOrchestrationThreadToolResult(this, event);
      }
      this.markSessionViewedIfActivelyViewed(event.sessionRef);
      this.state = this.syncDerivedSessionState(this.state, event.sessionRef);
      if (
        orchestration.hasOrchestrationChildSession(this.state.orchestrationChildren, event.sessionRef) ||
        orchestration.hasOrchestrationParentSession(this.state.orchestrationChildren, event.sessionRef)
      ) {
        this.state = {
          ...this.state,
          orchestrationChildren: orchestration.projectOrchestrationChildrenForSession(this, event.sessionRef),
        };
        this.scheduleOrchestrationSupervision();
      }
      if (shouldFollowSessionMutation && event.type !== "sessionClosed") {
        this.applyFastSessionSelection(event.sessionRef);
        if (!refreshedFollowedSession) {
          this.startSelectedSessionHydration(event.sessionRef);
        }
      }
      if (event.type === "runCompleted" || event.type === "runFailed" || event.type === "sessionClosed") {
        await this.persistUiState();
      } else if (event.type !== "hostUiRequest") {
        this.schedulePersistUiState();
      }
    } catch (error) {
      console.error(`[app-store] failed to apply session event ${event.type} for ${key}`, error);
    } finally {
      const snapshot = this.emit();
      this.publishSelectedTranscriptFor(event.sessionRef);
      await this.emitSessionEvent(event, snapshot);
    }
  }

  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined {
    const ws = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!ws) {
      return undefined;
    }

    return {
      workspaceId: ws.id,
      path: ws.path,
      displayName: ws.name,
    };
  }

  private resolveModelSettingsWorkspaceId(workspaceId: string): string {
    if (this.state.modelSettingsScopeMode !== "per-repo") {
      return workspaceId;
    }
    return resolveRepoWorkspaceId(this.state.workspaces, workspaceId) ?? workspaceId;
  }

  private async loadLiveGlobalModelSettings(
    workspaces: readonly { workspaceId: string; path: string; displayName: string }[],
    preferredWorkspaceId?: string,
  ): Promise<ModelSettingsSnapshot> {
    const fallbackWorkspace =
      (preferredWorkspaceId ? workspaces.find((entry) => entry.workspaceId === preferredWorkspaceId) : undefined) ?? workspaces[0];
    if (!fallbackWorkspace) {
      return this.state.globalModelSettings;
    }
    return this.driver.runtimeSupervisor.getGlobalModelSettings({
      workspaceId: fallbackWorkspace.workspaceId,
      path: fallbackWorkspace.path,
      displayName: fallbackWorkspace.displayName,
    });
  }

  async buildCreateSessionOptions(workspaceId: string): Promise<CreateSessionOptions | undefined> {
    if (this.state.modelSettingsScopeMode !== "per-repo") {
      return undefined;
    }
    const effectiveSettings = await this.loadEffectiveModelSettingsForWorkspace(workspaceId);
    if (!effectiveSettings) {
      return undefined;
    }
    return {
      ...(effectiveSettings.defaultProvider && effectiveSettings.defaultModelId
        ? { initialModel: { provider: effectiveSettings.defaultProvider, modelId: effectiveSettings.defaultModelId } }
        : {}),
      ...(effectiveSettings.defaultThinkingLevel ? { initialThinkingLevel: effectiveSettings.defaultThinkingLevel } : {}),
    };
  }

  private serializeRuntimeState(): Record<string, RuntimeSnapshot> {
    return mapToRecord(this.runtimeByWorkspace);
  }

  private async serializeRuntimeStateForCurrentWorkspaces(): Promise<Record<string, RuntimeSnapshot>> {
    const runtimeByWorkspace = this.serializeRuntimeState();
    if (this.state.modelSettingsScopeMode !== "per-repo") {
      return runtimeByWorkspace;
    }

    const workspaceRefs = this.state.workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      path: workspace.path,
      displayName: workspace.name,
    }));
    const scopedModelSettingsByWorkspace = await this.loadScopedModelSettingsByWorkspace(
      this.state.workspaces,
      workspaceRefs,
      this.state.globalModelSettings,
    );
    return this.serializeEffectiveRuntimeState(this.state.workspaces, scopedModelSettingsByWorkspace);
  }

  private async loadScopedModelSettingsByWorkspace(
    workspaces: DesktopAppState["workspaces"],
    workspaceRefs: readonly { workspaceId: string; path: string; displayName: string }[],
    globalModelSettings: ModelSettingsSnapshot,
  ): Promise<Record<string, ModelSettingsSnapshot>> {
    const uniqueOwnerIds = [...new Set(workspaces.map((workspace) => resolveRepoWorkspaceId(workspaces, workspace.id) ?? workspace.id))];
    const refsByWorkspaceId = new Map(workspaceRefs.map((workspace) => [workspace.workspaceId, workspace] as const));
    const ownerSettings = await Promise.all(
      uniqueOwnerIds.map(async (workspaceId) => {
        const workspace = refsByWorkspaceId.get(workspaceId);
        if (!workspace) {
          return undefined;
        }
        return [
          workspaceId,
          mergeModelSettingsSnapshot(globalModelSettings, await readProjectModelSettingsFile(workspace.path)),
        ] as const;
      }),
    );

    return Object.fromEntries(ownerSettings.filter((entry): entry is readonly [string, ModelSettingsSnapshot] => Boolean(entry)));
  }

  private serializeEffectiveRuntimeState(
    workspaces: DesktopAppState["workspaces"],
    scopedModelSettingsByWorkspace?: Record<string, ModelSettingsSnapshot>,
  ): Record<string, RuntimeSnapshot> {
    const runtimeByWorkspace = this.serializeRuntimeState();
    if (this.state.modelSettingsScopeMode !== "per-repo") {
      return runtimeByWorkspace;
    }

    for (const workspace of workspaces) {
      const ownerWorkspaceId = resolveRepoWorkspaceId(workspaces, workspace.id);
      const workspaceRuntime = runtimeByWorkspace[workspace.id];
      const modelSettings = ownerWorkspaceId ? scopedModelSettingsByWorkspace?.[ownerWorkspaceId] : undefined;
      if (!workspaceRuntime || !modelSettings) {
        continue;
      }
      runtimeByWorkspace[workspace.id] = applyModelSettingsSnapshot(workspaceRuntime, modelSettings);
    }

    return runtimeByWorkspace;
  }

  private serializeSessionExtensionUiState() {
    return Object.fromEntries(
      [...this.sessionState.extensionUiBySession.entries()].map(([key, value]) => [key, serializeExtensionUiState(value)] as const),
    );
  }

  private syncDerivedSessionState(state: DesktopAppState, sessionRef: SessionRef): DesktopAppState {
    const key = sessionKey(sessionRef);
    const serializedExtensionUi = this.sessionState.extensionUiBySession.get(key);

    return {
      ...state,
      sessionCommandsBySession: updateRecordValue(
        state.sessionCommandsBySession,
        key,
        this.sessionState.sessionCommandsBySession.get(key),
      ),
      sessionExtensionUiBySession: updateRecordValue(
        state.sessionExtensionUiBySession,
        key,
        serializedExtensionUi ? serializeExtensionUiState(serializedExtensionUi) : undefined,
      ),
      extensionCommandCompatibilityByWorkspace: serializeCompatibilityByWorkspace(this.extensionCommandCompatibilityByWorkspace),
      lastViewedAtBySession: updateRecordValue(
        state.lastViewedAtBySession,
        key,
        this.sessionState.lastViewedAtBySession.get(key),
      ),
      queuedComposerMessages: this.resolveQueuedComposerMessages(state.selectedWorkspaceId, state.selectedSessionId),
      editingQueuedMessageId: this.resolveEditingQueuedMessageId(state.selectedWorkspaceId, state.selectedSessionId),
      lastError: this.resolveSelectedSessionError(state.selectedWorkspaceId, state.selectedSessionId, false),
    };
  }

  selectedSessionRef(): SessionRef | undefined {
    if (!this.state.selectedWorkspaceId || !this.state.selectedSessionId) {
      return undefined;
    }

    return toSessionRef({
      workspaceId: this.state.selectedWorkspaceId,
      sessionId: this.state.selectedSessionId,
    });
  }

  private selectedSessionRefForView(view: DesktopAppViewState): SessionRef | undefined {
    const selectedWorkspaceId = this.resolveViewWorkspaceId(view.selectedWorkspaceId, this.state);
    const selectedSessionId = this.resolveViewSessionId(selectedWorkspaceId, view.selectedSessionId, this.state);
    if (!selectedWorkspaceId || !selectedSessionId) {
      return undefined;
    }

    return toSessionRef({
      workspaceId: selectedWorkspaceId,
      sessionId: selectedSessionId,
    });
  }

  private resolveViewWorkspaceId(
    preferredWorkspaceId: string | undefined,
    state: DesktopAppState,
  ): string {
    if (preferredWorkspaceId && state.workspaces.some((workspace) => workspace.id === preferredWorkspaceId)) {
      return preferredWorkspaceId;
    }
    if (state.selectedWorkspaceId && state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)) {
      return state.selectedWorkspaceId;
    }
    return state.workspaces[0]?.id ?? "";
  }

  private resolveViewSessionId(
    selectedWorkspaceId: string,
    preferredSessionId: string | undefined,
    state: DesktopAppState,
  ): string {
    const workspace = state.workspaces.find((entry) => entry.id === selectedWorkspaceId);
    if (!workspace) {
      return "";
    }
    if (preferredSessionId && workspace.sessions.some((session) => session.id === preferredSessionId)) {
      return preferredSessionId;
    }
    if (state.selectedWorkspaceId === selectedWorkspaceId && workspace.sessions.some((session) => session.id === state.selectedSessionId)) {
      return state.selectedSessionId;
    }
    return workspace.sessions[0]?.id ?? "";
  }

  sessionFromState(sessionRef: SessionRef) {
    return this.state.workspaces
      .find((w) => w.id === sessionRef.workspaceId)
      ?.sessions.find((s) => s.id === sessionRef.sessionId);
  }

  private async loadEffectiveModelSettingsForWorkspace(workspaceId: string): Promise<ModelSettingsSnapshot | undefined> {
    const ownerWorkspaceId = this.resolveModelSettingsWorkspaceId(workspaceId);
    const ownerWorkspace = this.workspaceRefFromState(ownerWorkspaceId);
    if (!ownerWorkspace) {
      return undefined;
    }
    const globalModelSettings =
      this.state.modelSettingsScopeMode === "per-repo" && hasStoredModelSettings(this.state.globalModelSettings)
        ? this.state.globalModelSettings
        : await this.loadLiveGlobalModelSettings(
            this.state.workspaces.map((workspace) => ({
              workspaceId: workspace.id,
              path: workspace.path,
              displayName: workspace.name,
            })),
            ownerWorkspaceId,
          );
    return mergeModelSettingsSnapshot(globalModelSettings, await readProjectModelSettingsFile(ownerWorkspace.path));
  }

  private async restoreGlobalModelSettings(
    settings: ModelSettingsSnapshot,
    workspaces?: readonly { workspaceId: string; path: string; displayName: string }[],
    preferredWorkspaceId?: string,
  ): Promise<void> {
    if (!hasStoredModelSettings(settings)) {
      return;
    }
    const workspaceRefs =
      workspaces ??
      this.state.workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        path: workspace.path,
        displayName: workspace.name,
      }));
    const fallbackWorkspace =
      (preferredWorkspaceId ? workspaceRefs.find((entry) => entry.workspaceId === preferredWorkspaceId) : undefined) ??
      workspaceRefs[0];
    if (!fallbackWorkspace) {
      return;
    }
    const workspaceRef = {
      workspaceId: fallbackWorkspace.workspaceId,
      path: fallbackWorkspace.path,
      displayName: fallbackWorkspace.displayName,
    };
    await this.driver.runtimeSupervisor.setScopedModelPatterns(workspaceRef, settings.enabledModelPatterns);
    if (settings.defaultThinkingLevel) {
      await this.driver.runtimeSupervisor.setDefaultThinkingLevel(workspaceRef, settings.defaultThinkingLevel);
    }
    if (settings.defaultProvider && settings.defaultModelId) {
      await this.driver.runtimeSupervisor.setDefaultModel(workspaceRef, {
        provider: settings.defaultProvider,
        modelId: settings.defaultModelId,
      });
    }
    if (this.runtimeByWorkspace.has(workspaceRef.workspaceId)) {
      this.runtimeByWorkspace.set(workspaceRef.workspaceId, await this.driver.runtimeSupervisor.refreshRuntime(workspaceRef));
    }
  }

  private async readUiState(): Promise<LegacyPersistedUiState> {
    return readPersistedUiState(this.uiStateFilePath);
  }

  async persistUiState(): Promise<void> {
    if (this.persistUiStateTimer) {
      clearTimeout(this.persistUiStateTimer);
      this.persistUiStateTimer = undefined;
    }
    const payload: PersistedUiState = {
      selectedWorkspaceId: this.state.selectedWorkspaceId || undefined,
      selectedSessionId: this.state.selectedSessionId || undefined,
      activeView: this.state.activeView,
      composerDraft: this.state.composerDraft || undefined,
      composerDraftsBySession: mapToRecord(this.sessionState.composerDraftsBySession),
      extensionCommandCompatibilityByWorkspace: serializeCompatibilityByWorkspace(this.extensionCommandCompatibilityByWorkspace),
      notificationPreferences: this.state.notificationPreferences,
      integratedTerminalShell: this.state.integratedTerminalShell || undefined,
      lastViewedAtBySession: mapToRecord(this.sessionState.lastViewedAtBySession),
      pinnedAtBySession: mapToRecord(this.sessionState.pinnedAtBySession),
      pinnedSessionOrder: this.sessionState.pinnedSessionOrder.length > 0 ? this.sessionState.pinnedSessionOrder : undefined,
      workspaceOrder: this.state.workspaceOrder.length > 0 ? this.state.workspaceOrder : undefined,
      modelSettingsScopeMode: this.state.modelSettingsScopeMode,
      appGlobalModelSettings: hasStoredModelSettings(this.state.globalModelSettings) ? this.state.globalModelSettings : undefined,
      themeMode: this.state.themeMode,
      themePresetId: this.state.themePresetId,
      sidebarCollapsed: this.state.sidebarCollapsed || undefined,
      enableTransparency: this.state.enableTransparency,
      orchestrationChildren: orchestration.toPersistedOrchestrationChildren(this.state.orchestrationChildren),
    };

    await writePersistedUiState(this.uiStateFilePath, payload);
  }

  async persistComposerAttachments(
    key: string,
    attachments: readonly ComposerAttachment[],
  ): Promise<void> {
    await this.attachmentStore.write(key, cloneComposerAttachments(attachments));
    await this.persistUiState();
  }

  schedulePersistUiState(): void {
    if (this.persistUiStateTimer) {
      clearTimeout(this.persistUiStateTimer);
    }

    this.persistUiStateTimer = setTimeout(() => {
      this.persistUiStateTimer = undefined;
      void this.persistUiState();
    }, 250);
  }

  private currentSelectedSessionKey(): string {
    return this.state.selectedWorkspaceId && this.state.selectedSessionId
      ? sessionKey({
          workspaceId: this.state.selectedWorkspaceId,
          sessionId: this.state.selectedSessionId,
        })
      : "";
  }

  private isSelectedSession(sessionRef: SessionRef): boolean {
    const selected = this.selectedSessionRef();
    return Boolean(
      selected &&
      selected.workspaceId === sessionRef.workspaceId &&
      selected.sessionId === sessionRef.sessionId,
    );
  }

  private buildSelectedTranscriptRecord(sessionRef: SessionRef): SelectedTranscriptRecord {
    this.ensureSessionSchemaInfo(sessionRef);
    const schemaInfo = this.sessionSchemaInfoCache.get(sessionKey(sessionRef));
    return {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
      transcript: (this.sessionState.transcriptCache.get(sessionKey(sessionRef)) ?? []).map(cloneTranscriptMessage),
      ...(schemaInfo ? { schemaInfo } : {}),
    };
  }

  /**
   * Lazily read a session's schema info (the "written by a newer pi" version-skew
   * flag) and cache it so it is not an extra header read on every transcript
   * publish. On first miss the async read runs fire-and-forget; if the file was
   * written by a newer runtime we re-publish so the banner appears once the read
   * resolves. The cache is invalidated on external reconcile so an out-of-band
   * file replacement refreshes the flag.
   */
  private ensureSessionSchemaInfo(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    if (this.sessionSchemaInfoCache.has(key) || this.sessionSchemaInfoInFlight.has(key)) {
      return;
    }
    this.sessionSchemaInfoInFlight.add(key);
    void this.driver
      .getSessionSchemaInfo(sessionRef)
      .then((info) => {
        this.sessionSchemaInfoCache.set(key, info);
        if (info.writtenByNewerRuntime) {
          this.publishSelectedTranscriptFor(sessionRef);
        }
      })
      .catch((error) => {
        console.error(`[app-store] failed to read session schema info for ${key}`, error);
      })
      .finally(() => {
        this.sessionSchemaInfoInFlight.delete(key);
      });
  }

  emit(): DesktopAppState {
    // Revision must be monotonic across publishes: mutation sites bump it from
    // whatever state they captured, and long async builders (refreshState and
    // friends) can capture before concurrent session events bump it further —
    // assigning a LOWER revision than one already pushed. The renderer drops
    // lower-revision snapshots, so a regression here freezes the UI until main
    // happens to climb back past the renderer's high-water mark. Stamp the
    // revision at the publish point instead of trusting the mutation sites.
    this.publishRevision = Math.max(this.publishRevision, this.state.revision) + 1;
    this.state = { ...this.state, revision: this.publishRevision };
    const snapshot = structuredClone(this.state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  publishSelectedTranscript(): void {
    const sessionRef = this.selectedSessionRef();
    const payload = sessionRef ? this.buildSelectedTranscriptRecord(sessionRef) : null;
    for (const listener of this.selectedTranscriptListeners) {
      listener(payload);
    }
  }

  publishSelectedTranscriptFor(sessionRef: SessionRef): void {
    if (!this.isSelectedSession(sessionRef)) {
      return;
    }
    this.publishSelectedTranscript();
  }

  handleWindowActivation(): void {
    // Reconcile the active workspace on focus so returning to the window always
    // reflects external CLI changes (new sessions, appended turns, edited
    // settings) — the Codex-style sync model, with no live filesystem watcher.
    const activeWorkspaceId = this.state.selectedWorkspaceId;
    if (activeWorkspaceId) {
      this.reconcileWorkspaceOnFocus(activeWorkspaceId);
    }

    if (!this.markSelectedSessionViewedIfVisible()) {
      return;
    }

    this.schedulePersistUiState();
    this.emit();
  }

  private async emitSessionEvent(event: SessionDriverEvent, snapshot: DesktopAppState): Promise<void> {
    for (const listener of this.sessionEventListeners) {
      try {
        await listener(event, snapshot);
      } catch (error) {
        // Isolate listeners: one rejection must not skip the remaining ones.
        console.error("[app-store] session event listener failed", error);
      }
    }
  }

  async withError(error: unknown): Promise<DesktopAppState> {
    const message = describeStoreError(error);
    const sessionRef = this.selectedSessionRef();
    if (sessionRef) {
      this.sessionState.sessionErrorsBySession.set(sessionKey(sessionRef), message);
    }
    this.state = {
      ...this.state,
      lastError: message,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async withSessionError(sessionRef: SessionRef, error: unknown): Promise<DesktopAppState> {
    const message = describeStoreError(error);
    this.sessionState.sessionErrorsBySession.set(sessionKey(sessionRef), message);
    this.state = {
      ...this.state,
      lastError: this.isSelectedSession(sessionRef) ? message : this.state.lastError,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState> {
    try {
      return await fn();
    } catch (error) {
      return this.withError(error);
    }
  }

  private applyFastSessionSelection(sessionRef: SessionRef): DesktopAppState {
    this.restoredSelectedSessionKeysAwaitingSelection.delete(sessionKey(sessionRef));
    this.state = {
      ...this.state,
      selectedWorkspaceId: sessionRef.workspaceId,
      selectedSessionId: sessionRef.sessionId,
      activeView: "threads",
      composerDraft: this.resolveComposerDraft(sessionRef.workspaceId, sessionRef.sessionId),
      composerDraftSyncSource: "selection",
      composerDraftSyncNonce: this.allocateComposerDraftSyncNonce(),
      composerAttachments: this.resolveComposerAttachments(sessionRef.workspaceId, sessionRef.sessionId),
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    this.markSessionViewed(sessionRef);
    this.schedulePersistUiState();
    const snapshot = this.emit();
    if (this.sessionState.loadedTranscriptKeys.has(sessionKey(sessionRef))) {
      this.publishSelectedTranscript();
    }
    return snapshot;
  }

  private async hydrateSelectedSessionAfterSelection(
    sessionRef: SessionRef,
    selectionEpoch: number,
    options: { readonly markViewed?: boolean } = {},
  ): Promise<void> {
    const runtimeMissing = !this.runtimeByWorkspace.has(sessionRef.workspaceId);
    const [snapshot] = await Promise.all([
      this.ensureSessionReady(sessionRef),
      this.ensureComposerAttachmentsLoaded(sessionRef),
      runtimeMissing ? this.ensureRuntimeLoaded(sessionRef.workspaceId) : Promise.resolve(),
    ]);

    if (!this.isCurrentSelectionEpoch(sessionRef, selectionEpoch)) {
      return;
    }

    const runtimeByWorkspace = runtimeMissing ? await this.serializeRuntimeStateForCurrentWorkspaces() : undefined;
    if (!this.isCurrentSelectionEpoch(sessionRef, selectionEpoch)) {
      return;
    }

    this.clearSessionError(sessionRef);
    this.state = this.syncSelectedSessionHydrationState(this.state, sessionRef, snapshot, runtimeByWorkspace);
    if (options.markViewed ?? true) {
      this.markSessionViewed(sessionRef);
    }
    this.schedulePersistUiState();
    this.emit();
    this.publishSelectedTranscriptFor(sessionRef);
  }

  private startSelectedSessionHydration(
    sessionRef: SessionRef | undefined,
    options: { readonly markViewed?: boolean } = {},
  ): void {
    if (!sessionRef) {
      return;
    }

    const selectionEpoch = ++this.selectionEpoch;
    void this.hydrateSelectedSessionAfterSelection(sessionRef, selectionEpoch, options).catch((error: unknown) => {
      void this.handleSelectedSessionHydrationError(sessionRef, selectionEpoch, error);
    });
  }

  private async handleSelectedSessionHydrationError(
    sessionRef: SessionRef,
    selectionEpoch: number,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.sessionState.sessionErrorsBySession.set(sessionKey(sessionRef), message);
    if (this.isCurrentSelectionEpoch(sessionRef, selectionEpoch)) {
      await this.withError(error);
      return;
    }

    this.schedulePersistUiState();
  }

  private isCurrentSelectionEpoch(sessionRef: SessionRef, selectionEpoch: number): boolean {
    return (
      selectionEpoch === this.selectionEpoch &&
      this.state.selectedWorkspaceId === sessionRef.workspaceId &&
      this.state.selectedSessionId === sessionRef.sessionId
    );
  }

  private markSelectedSessionViewedIfVisible(): boolean {
    if (this.state.activeView !== "threads" || !this.state.selectedWorkspaceId || !this.state.selectedSessionId) {
      return false;
    }

    const sessionRef = {
      workspaceId: this.state.selectedWorkspaceId,
      sessionId: this.state.selectedSessionId,
    } satisfies SessionRef;
    if (!isSessionVisibleInWindow(this.state, sessionRef, this.getWindow())) {
      return false;
    }
    if (this.restoredSelectedSessionKeysAwaitingSelection.has(sessionKey(sessionRef))) {
      return false;
    }

    return this.markSessionViewed(sessionRef);
  }

  private markSessionViewedIfActivelyViewed(sessionRef: SessionRef): boolean {
    const active = isSessionActivelyViewed(this.state, sessionRef, this.getWindow());
    if (!active) {
      return false;
    }

    return this.markSessionViewed(sessionRef);
  }

  private markSessionViewed(sessionRef: SessionRef, fallbackViewedAt = new Date().toISOString()): boolean {
    const key = sessionKey(sessionRef);
    const viewedAt = this.resolveViewedAt(sessionRef, fallbackViewedAt);
    const current = this.sessionState.lastViewedAtBySession.get(key);
    if (current && current >= viewedAt) {
      return false;
    }

    this.sessionState.lastViewedAtBySession.set(key, viewedAt);
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map((w) =>
        w.id === sessionRef.workspaceId
          ? {
              ...w,
              sessions: w.sessions.map((s) =>
                s.id === sessionRef.sessionId
                  ? {
                      ...s,
                      lastViewedAt: viewedAt,
                      hasUnseenUpdate: false,
                    }
                  : s,
              ),
            }
          : w,
      ),
      lastViewedAtBySession: mapToRecord(this.sessionState.lastViewedAtBySession),
    };
    return true;
  }

  private resolveViewedAt(sessionRef: SessionRef, fallbackViewedAt: string): string {
    const session = this.findSessionRecord(sessionRef);
    if (!session) {
      return fallbackViewedAt;
    }

    const activityAt = latestSessionActivityAt(
      session.updatedAt,
      this.sessionState.transcriptCache.get(sessionKey(sessionRef)) ?? [],
    );
    return activityAt > fallbackViewedAt ? activityAt : fallbackViewedAt;
  }

  private findSessionRecord(sessionRef: SessionRef) {
    return this.state.workspaces
      .find((workspace) => workspace.id === sessionRef.workspaceId)
      ?.sessions.find((session) => session.id === sessionRef.sessionId);
  }

  private clearSessionError(sessionRef: SessionRef): void {
    this.sessionState.sessionErrorsBySession.delete(sessionKey(sessionRef));
  }

  private resolveComposerDraft(
    selectedWorkspaceId: string,
    selectedSessionId: string,
    explicitDraft?: string,
  ): string {
    if (explicitDraft !== undefined) {
      if (selectedWorkspaceId && selectedSessionId) {
        const key = sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId });
        if (explicitDraft) {
          this.sessionState.composerDraftsBySession.set(key, explicitDraft);
        } else {
          this.sessionState.composerDraftsBySession.delete(key);
        }
      }
      return explicitDraft;
    }

    if (!selectedWorkspaceId || !selectedSessionId) {
      return "";
    }

    return this.sessionState.composerDraftsBySession.get(sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })) ?? "";
  }

  private resolveComposerDraftSync(
    selectedWorkspaceId: string,
    selectedSessionId: string,
    options: RefreshStateOptions,
  ): {
    readonly source: ComposerDraftSyncSource;
    readonly nonce: number;
  } {
    if (options.composerDraftSyncSource) {
      return {
        source: options.composerDraftSyncSource,
        nonce: this.allocateComposerDraftSyncNonce(),
      };
    }

    if (
      selectedWorkspaceId !== this.state.selectedWorkspaceId ||
      selectedSessionId !== this.state.selectedSessionId
    ) {
      return {
        source: "selection",
        nonce: this.allocateComposerDraftSyncNonce(),
      };
    }

    return {
      source: this.state.composerDraftSyncSource,
      nonce: this.state.composerDraftSyncNonce,
    };
  }

  allocateComposerDraftSyncNonce(baseNonce = this.state.composerDraftSyncNonce): number {
    this.composerDraftProjectionNonce = Math.max(this.composerDraftProjectionNonce, baseNonce) + 1;
    return this.composerDraftProjectionNonce;
  }

  private resolveComposerAttachments(
    selectedWorkspaceId: string,
    selectedSessionId: string,
  ): readonly ComposerAttachment[] {
    if (!selectedWorkspaceId || !selectedSessionId) {
      return [];
    }

    return this.sessionState.composerAttachmentsBySession.get(
      sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }),
    )?.map(cloneComposerAttachment) ?? [];
  }

  private resolveQueuedComposerMessages(
    selectedWorkspaceId: string,
    selectedSessionId: string,
  ): readonly QueuedComposerMessage[] {
    if (!selectedWorkspaceId || !selectedSessionId) {
      return [];
    }

    return this.sessionState.queuedComposerMessagesBySession.get(
      sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }),
    )?.filter((message) => message.mode === "followUp")
      .map((message) => ({
        ...message,
        attachments: cloneComposerAttachments(message.attachments),
      })) ?? [];
  }

  private resolveEditingQueuedMessageId(
    selectedWorkspaceId: string,
    selectedSessionId: string,
  ): string | undefined {
    if (!selectedWorkspaceId || !selectedSessionId) {
      return undefined;
    }

    return this.sessionState.queuedComposerEditsBySession.get(
      sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }),
    )?.messageId;
  }

  private resolveSelectedSessionError(
    selectedWorkspaceId: string,
    selectedSessionId: string,
    clearLastError?: boolean,
  ): string | undefined {
    if (!selectedWorkspaceId || !selectedSessionId) {
      return undefined;
    }

    const key = sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId });
    if (clearLastError) {
      this.sessionState.sessionErrorsBySession.delete(key);
      return undefined;
    }

    return this.sessionState.sessionErrorsBySession.get(key);
  }

  updateSessionConfig(sessionRef: SessionRef, config: SessionConfig | undefined): void {
    const key = sessionKey(sessionRef);
    if (config && Object.keys(config).length > 0) {
      this.sessionState.sessionConfigBySession.set(key, config);
    } else {
      this.sessionState.sessionConfigBySession.delete(key);
    }
  }

  updateQueuedComposerMessages(sessionRef: SessionRef, queuedMessages: readonly SessionQueuedMessage[] | undefined): void {
    const key = sessionKey(sessionRef);
    const next = mergeQueuedComposerMessages(this.sessionState.queuedComposerMessagesBySession.get(key), queuedMessages);
    if (next.length > 0) {
      this.sessionState.queuedComposerMessagesBySession.set(key, next);
    } else {
      this.sessionState.queuedComposerMessagesBySession.delete(key);
    }

    const editState = this.sessionState.queuedComposerEditsBySession.get(key);
    if (editState && !next.some((message) => message.id === editState.messageId)) {
      this.sessionState.queuedComposerEditsBySession.delete(key);
    }
  }

  getQueuedComposerMessages(sessionRef: SessionRef): readonly QueuedComposerMessage[] {
    return this.sessionState.queuedComposerMessagesBySession.get(sessionKey(sessionRef)) ?? [];
  }

  setQueuedComposerEditState(sessionRef: SessionRef, editState: QueuedComposerEditState | undefined): void {
    const key = sessionKey(sessionRef);
    if (editState) {
      this.sessionState.queuedComposerEditsBySession.set(key, editState);
    } else {
      this.sessionState.queuedComposerEditsBySession.delete(key);
    }
  }

  getQueuedComposerEditState(sessionRef: SessionRef): QueuedComposerEditState | undefined {
    return this.sessionState.queuedComposerEditsBySession.get(sessionKey(sessionRef));
  }

  private syncSelectedSessionHydrationState(
    state: DesktopAppState,
    sessionRef: SessionRef,
    snapshot?: SessionSnapshot,
    runtimeByWorkspace?: Record<string, RuntimeSnapshot>,
  ): DesktopAppState {
    const key = sessionKey(sessionRef);
    const transcript = (this.sessionState.transcriptCache.get(key) ?? []).map(cloneTranscriptMessage);
    const preview = previewFromTranscript(transcript);
    const lastViewedAt = this.sessionState.lastViewedAtBySession.get(key);
    const nextState = {
      ...state,
      ...(runtimeByWorkspace ? { runtimeByWorkspace } : {}),
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === sessionRef.workspaceId
          ? {
              ...workspace,
              sessions: workspace.sessions.map((session) => {
                if (session.id !== sessionRef.sessionId) {
                  return session;
                }

                return updateSessionRecord(session, {
                  snapshot:
                    snapshot || this.sessionState.sessionConfigBySession.has(key)
                      ? {
                          ...snapshot,
                          config: this.sessionState.sessionConfigBySession.get(key) ?? snapshot?.config,
                        }
                      : undefined,
                  transcript,
                  preview,
                  runningSince: this.sessionState.runningSinceBySession.get(key),
                  lastViewedAt,
                });
              }),
            }
          : workspace,
      ),
      composerAttachments: this.resolveComposerAttachments(state.selectedWorkspaceId, state.selectedSessionId),
      lastError: undefined,
      revision: state.revision + 1,
    };

    return this.syncDerivedSessionState(nextState, sessionRef);
  }
  setPendingAutoTitle(sessionRef: SessionRef, pending: import("./session-state-map").PendingAutoTitle): void {
    this.clearPendingAutoTitle(sessionRef);
    this.sessionState.pendingAutoTitleBySession.set(sessionKey(sessionRef), pending);
  }

  getPendingAutoTitle(sessionRef: SessionRef): import("./session-state-map").PendingAutoTitle | undefined {
    return this.sessionState.pendingAutoTitleBySession.get(sessionKey(sessionRef));
  }

  clearPendingAutoTitle(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    const pendingAutoTitle = this.sessionState.pendingAutoTitleBySession.get(key);
    if (!pendingAutoTitle) {
      return;
    }
    this.sessionState.pendingAutoTitleBySession.delete(key);
    pendingAutoTitle.cancel();
  }
}

/* ── Module-private free functions ───────────────────────── */

function updateRecordValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T | undefined,
): Readonly<Record<string, T>> {
  if (value === undefined) {
    if (!(key in record)) {
      return record;
    }

    const { [key]: _removed, ...rest } = record;
    return rest;
  }

  if (record[key] === value) {
    return record;
  }

  return {
    ...record,
    [key]: value,
  };
}

function applyModelSettingsSnapshot(
  runtime: RuntimeSnapshot,
  settings: ModelSettingsSnapshot,
): RuntimeSnapshot {
  return {
    ...runtime,
    settings: {
      ...runtime.settings,
      ...(settings.defaultProvider ? { defaultProvider: settings.defaultProvider } : { defaultProvider: undefined }),
      ...(settings.defaultModelId ? { defaultModelId: settings.defaultModelId } : { defaultModelId: undefined }),
      ...(settings.defaultThinkingLevel
        ? { defaultThinkingLevel: settings.defaultThinkingLevel }
        : { defaultThinkingLevel: undefined }),
      enabledModelPatterns: [...settings.enabledModelPatterns],
    },
  };
}

/**
 * Convert an error into the message shown in `lastError`. A SessionLeasedError
 * means another live pi surface holds the session file, so binding a runtime is
 * refused to avoid forking the conversation — turn its raw internal string into
 * a user-readable explanation of who holds it and what to do.
 */
function describeStoreError(error: unknown): string {
  if (isSessionLeasedError(error)) {
    const { holder } = error;
    const where = holder.surface === "pi-cli" ? "the pi CLI" : "another pi instance";
    return `This session is currently open in ${where} (pid ${holder.pid} on host ${holder.hostname}). Close it there or wait a few minutes before continuing here.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isSessionLeasedError(error: unknown): error is SessionLeasedError {
  return (
    error instanceof SessionLeasedError ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "SESSION_LEASED")
  );
}

/**
 * Path to pi's global settings file, mirroring the runtime's own resolution
 * (`getAgentDir()/settings.json`). We resolve it locally rather than importing
 * the runtime's helper because `@earendil-works/pi-coding-agent` is ESM-only and
 * cannot be `require`d from the CJS Electron main bundle; the app store passes no
 * custom `agentDir`, so the default resolution here matches the driver's.
 */
/** `mtimeMs` of a file, or undefined if it does not exist / cannot be stat'd. */
async function statMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function resolveGlobalSettingsPath(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  const agentDir = override
    ? override.startsWith("~")
      ? join(homedir(), override.slice(1))
      : override
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

async function readProjectModelSettingsFile(workspacePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(join(workspacePath, ".pi", "settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mergeModelSettingsSnapshot(
  globalSettings: ModelSettingsSnapshot,
  projectSettings: Record<string, unknown>,
): ModelSettingsSnapshot {
  const defaultProvider =
    typeof projectSettings.defaultProvider === "string"
      ? projectSettings.defaultProvider
      : globalSettings.defaultProvider;
  const defaultModelId =
    typeof projectSettings.defaultModel === "string"
      ? projectSettings.defaultModel
      : globalSettings.defaultModelId;
  const defaultThinkingLevel =
    typeof projectSettings.defaultThinkingLevel === "string"
      ? (projectSettings.defaultThinkingLevel as RuntimeSettingsSnapshot["defaultThinkingLevel"])
      : globalSettings.defaultThinkingLevel;

  return {
    enabledModelPatterns: Array.isArray(projectSettings.enabledModels)
      ? projectSettings.enabledModels.filter((value): value is string => typeof value === "string")
      : [...globalSettings.enabledModelPatterns],
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
  };
}

function hasStoredModelSettings(settings: ModelSettingsSnapshot | undefined): settings is ModelSettingsSnapshot {
  return Boolean(
    settings &&
      (settings.enabledModelPatterns.length > 0 ||
        settings.defaultProvider ||
        settings.defaultModelId ||
        settings.defaultThinkingLevel),
  );
}

function modelSettingsEqual(left: ModelSettingsSnapshot, right: ModelSettingsSnapshot): boolean {
  return (
    left.defaultProvider === right.defaultProvider &&
    left.defaultModelId === right.defaultModelId &&
    left.defaultThinkingLevel === right.defaultThinkingLevel &&
    left.enabledModelPatterns.length === right.enabledModelPatterns.length &&
    left.enabledModelPatterns.every((pattern, index) => pattern === right.enabledModelPatterns[index])
  );
}

function mergeEnabledModelPatterns(
  existingPatterns: readonly string[],
  providerPatterns: readonly string[],
): readonly string[] {
  const merged = [...existingPatterns];
  const seen = new Set(existingPatterns);
  for (const pattern of providerPatterns) {
    if (seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    merged.push(pattern);
  }
  return merged;
}

function reconcilePinnedSessionOrder(
  pinnedAtBySession: ReadonlyMap<string, string>,
  preferredOrder: readonly string[],
): readonly string[] {
  const pinnedKeys = new Set(pinnedAtBySession.keys());
  const ordered = [...new Set(preferredOrder)].filter((key) => pinnedKeys.has(key));
  const seen = new Set(ordered);
  const missing = [...pinnedAtBySession.keys()]
    .filter((key) => !seen.has(key))
    .sort((left, right) => {
      const leftPinnedAt = pinnedAtBySession.get(left) ?? "";
      const rightPinnedAt = pinnedAtBySession.get(right) ?? "";
      return rightPinnedAt.localeCompare(leftPinnedAt);
    });
  return [...ordered, ...missing];
}

function formatCapabilityLabel(capability: string): string {
  switch (capability) {
    case "custom":
      return "custom UI";
    case "onTerminalInput":
      return "terminal input";
    case "setEditorComponent":
      return "custom editor UI";
    case "setFooter":
      return "footer UI";
    case "setHeader":
      return "header UI";
    default:
      return capability.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }
}

function resolveSelectedWorkspaceIdFromCatalog(
  preferredWorkspaceId: string,
  workspaces: readonly { workspaceId: string }[],
): string {
  if (preferredWorkspaceId && workspaces.some((w) => w.workspaceId === preferredWorkspaceId)) {
    return preferredWorkspaceId;
  }
  return workspaces[0]?.workspaceId ?? "";
}

function resolveSelectedSessionIdFromCatalog(
  workspaceId: string,
  preferredSessionId: string,
  sessions: readonly SessionCatalogEntry[],
): string {
  const workspaceSessions = sessions.filter((session) => session.workspaceId === workspaceId);
  if (!workspaceSessions.length) {
    return "";
  }
  if (
    preferredSessionId &&
    workspaceSessions.some((session) => session.sessionRef.sessionId === preferredSessionId)
  ) {
    return preferredSessionId;
  }
  return workspaceSessions[0]?.sessionRef.sessionId ?? "";
}
