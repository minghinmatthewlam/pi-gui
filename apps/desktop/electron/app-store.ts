import { join } from "node:path";
import {
  applyHostUiRequestToExtensionUiState,
  isExtensionUiDialogRequest,
  JsonCatalogStore,
  PiSdkDriver,
  type PiSdkDriverConfig,
  sessionKey,
} from "@pi-gui/pi-sdk-driver";
import type { SessionCatalogEntry } from "@pi-gui/catalogs";
import type { HostUiResponse, SessionConfig, SessionDriverEvent, SessionRef, WorkspaceRef } from "@pi-gui/session-driver";
import type { RuntimeCommandRecord, RuntimeLoginCallbacks, RuntimeSettingsSnapshot, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  type AppView,
  createEmptyDesktopAppState,
  type ComposerImageAttachment,
  type CreateSessionInput,
  type CreateWorktreeInput,
  type DesktopAppState,
  type NotificationPreferences,
  type RemoveWorktreeInput,
  type StartThreadInput,
  type TranscriptMessage,
  type WorkspaceSessionTarget,
} from "../src/desktop-state";
import {
  applyTimelineEvent,
  appendAssistantDelta,
  clearActiveAssistantMessage,
} from "./app-store-timeline";
import { applySessionEventState } from "./app-store-session-state";
import type { AppStoreInternals, RefreshStateOptions } from "./app-store-internals";
import {
  readPersistedUiState,
  type LegacyPersistedUiState,
  type PersistedUiState,
  writePersistedUiState,
} from "./app-store-persistence";
import { JsonFileStore } from "./json-file-store";
import {
  buildWorktreeRecords,
  buildWorkspaceRecords,
  cloneComposerImageAttachment,
  cloneComposerImageAttachments,
  cloneTranscriptMessage,
  mapToRecord,
  toSessionRef,
} from "./app-store-utils";
import { SessionStateMap } from "./session-state-map";
import { createEmptyExtensionUiState, serializeExtensionUiState } from "./session-state-map";
import { GitWorktreeManager } from "./worktree-manager";
import * as workspace from "./app-store-workspace";
import * as worktree from "./app-store-worktree";
import * as composer from "./app-store-composer";

type StateListener = (state: DesktopAppState) => void;
type SessionEventListener = (event: SessionDriverEvent, state: DesktopAppState) => void | Promise<void>;

export interface DesktopAppStoreOptions {
  readonly userDataDir: string;
  readonly initialWorkspacePaths: readonly string[];
}

export class DesktopAppStore implements AppStoreInternals {
  state = createEmptyDesktopAppState();
  private readonly listeners = new Set<StateListener>();
  private readonly sessionEventListeners = new Set<SessionEventListener>();
  readonly driver: PiSdkDriver;
  readonly catalogStore: JsonCatalogStore;
  readonly worktreeManager: GitWorktreeManager;
  private readonly uiStateFilePath: string;
  private readonly transcriptStore: JsonFileStore<TranscriptMessage[]>;
  readonly attachmentStore: JsonFileStore<ComposerImageAttachment[]>;
  readonly sessionState = new SessionStateMap();
  readonly runtimeByWorkspace = new Map<string, RuntimeSnapshot>();
  private readonly initialWorkspacePaths: readonly string[];
  private persistUiStateTimer: NodeJS.Timeout | undefined;
  private readonly transcriptPersistTimers = new Map<string, NodeJS.Timeout>();
  private initPromise: Promise<void> | undefined;

  constructor(options: DesktopAppStoreOptions) {
    const catalogFilePath = join(options.userDataDir, "catalogs.json");
    const driverOptions: PiSdkDriverConfig = {
      catalogFilePath,
    };

    this.driver = new PiSdkDriver(driverOptions);
    this.catalogStore = new JsonCatalogStore({ catalogFilePath });
    this.worktreeManager = new GitWorktreeManager({ catalogStorage: this.catalogStore });
    this.uiStateFilePath = join(options.userDataDir, "ui-state.json");
    this.transcriptStore = new JsonFileStore<TranscriptMessage[]>(options.userDataDir, "transcripts");
    this.attachmentStore = new JsonFileStore<ComposerImageAttachment[]>(options.userDataDir, "attachments");
    this.initialWorkspacePaths = options.initialWorkspacePaths;
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

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    void this.getState().then(listener).catch(() => undefined);
    return () => {
      this.listeners.delete(listener);
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

  async selectWorkspace(workspaceId: string): Promise<DesktopAppState> {
    return workspace.selectWorkspace(this, workspaceId);
  }

  async selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.selectSession(this, target);
  }

  async archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.archiveSession(this, target);
  }

  async unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.unarchiveSession(this, target);
  }

  async syncCurrentWorkspace(): Promise<DesktopAppState> {
    return workspace.syncCurrentWorkspace(this);
  }

  /* ── Worktree methods (delegated) ──────────────────────── */

  async createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState> {
    return worktree.createWorktree(this, input);
  }

  async removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState> {
    return worktree.removeWorktree(this, input);
  }

  /* ── Composer methods (delegated) ──────────────────────── */

  async updateComposerDraft(composerDraft: string): Promise<DesktopAppState> {
    return composer.updateComposerDraft(this, composerDraft);
  }

  async addComposerImages(attachments: readonly ComposerImageAttachment[]): Promise<DesktopAppState> {
    return composer.addComposerImages(this, attachments);
  }

  async removeComposerImage(attachmentId: string): Promise<DesktopAppState> {
    return composer.removeComposerImage(this, attachmentId);
  }

  async submitComposer(textInput: string): Promise<DesktopAppState> {
    return composer.submitComposer(this, textInput);
  }

  async cancelCurrentRun(): Promise<DesktopAppState> {
    return composer.cancelCurrentRun(this);
  }

  /* ── Session / thread methods (delegated) ───────────────── */

  async startThread(input: StartThreadInput): Promise<DesktopAppState> {
    return worktree.startThread(this, input);
  }

  async createSession(input: CreateSessionInput): Promise<DesktopAppState> {
    return workspace.createSession(this, input);
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
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setDefaultModel(ws, { provider, modelId }),
    );
  }

  async setDefaultThinkingLevel(
    workspaceId: string,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setDefaultThinkingLevel(ws, thinkingLevel),
    );
  }

  async setSessionThinkingLevel(
    sessionRef: SessionRef,
    thinkingLevel: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  ): Promise<DesktopAppState> {
    return composer.setSessionThinkingLevel(this, sessionRef, thinkingLevel);
  }

  async loginProvider(workspaceId: string, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.login(ws, providerId, callbacks),
    );
  }

  async logoutProvider(workspaceId: string, providerId: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.logout(ws, providerId),
    );
  }

  async setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setEnableSkillCommands(ws, enabled),
      { reloadSessions: true },
    );
  }

  async setScopedModelPatterns(workspaceId: string, patterns: readonly string[]): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setScopedModelPatterns(ws, patterns),
    );
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
    },
  ): Promise<DesktopAppState> {
    await this.initialize();
    const ws = this.workspaceRefFromState(workspaceId);
    if (!ws) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    return this.withErrorHandling(async () => {
      const snapshot = await action(ws);
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      if (options?.reloadSessions) {
        this.clearExtensionUiForWorkspace(workspaceId);
        await this.reloadSessionsForWorkspace(workspaceId);
      }
      await this.refreshSessionCommandsForWorkspace(workspaceId);
      return this.refreshState({ clearLastError: true });
    });
  }

  /* ── Internal infrastructure (AppStoreInternals) ───────── */

  private async initializeInternal(): Promise<void> {
    try {
      const persisted = await this.readUiState();
      this.state = {
        ...this.state,
        activeView: persisted.activeView ?? this.state.activeView,
        notificationPreferences: {
          ...this.state.notificationPreferences,
          ...persisted.notificationPreferences,
        },
        lastViewedAtBySession: persisted.lastViewedAtBySession ?? {},
        workspaceOrder: persisted.workspaceOrder ?? [],
      };
      await this.migrateLegacyPersistence(persisted);
      this.sessionState.lastViewedAtBySession.clear();
      for (const [key, viewedAt] of Object.entries(persisted.lastViewedAtBySession ?? {})) {
        if (viewedAt) {
          this.sessionState.lastViewedAtBySession.set(key, viewedAt);
        }
      }
      this.sessionState.composerDraftsBySession.clear();
      for (const [key, draft] of Object.entries(persisted.composerDraftsBySession ?? {})) {
        if (draft) {
          this.sessionState.composerDraftsBySession.set(key, draft);
        }
      }
      const initialWorkspacePaths = this.initialWorkspacePaths.map((path) => path.trim()).filter(Boolean);
      const knownWorkspaces = await this.driver.listWorkspaces();
      const workspacesToSync = new Map<string, string | undefined>();

      for (const workspacePath of initialWorkspacePaths) {
        workspacesToSync.set(workspacePath, undefined);
      }

      for (const ws of knownWorkspaces.workspaces) {
        workspacesToSync.set(ws.path, ws.displayName);
      }

      await Promise.all(
        [...workspacesToSync.entries()].map(([workspacePath, displayName]) =>
          this.driver.syncWorkspace(workspacePath, displayName),
        ),
      );

      await this.refreshState({
        selectedWorkspaceId: persisted.selectedWorkspaceId,
        selectedSessionId: persisted.selectedSessionId,
        composerDraft: persisted.composerDraft,
        clearLastError: true,
        refreshWorktrees: true,
      });
    } catch (error) {
      this.state = {
        ...createEmptyDesktopAppState(),
        lastError: error instanceof Error ? error.message : String(error),
        revision: 1,
      };
      await this.persistUiState();
      this.emit();
    }
  }

  private async migrateLegacyPersistence(persisted: LegacyPersistedUiState): Promise<void> {
    const transcriptEntries = Object.entries(persisted.transcripts ?? {});
    await Promise.all(
      transcriptEntries.map(async ([key, transcript]) => {
        const clonedTranscript = transcript.map((item) => cloneTranscriptMessage(item as TranscriptMessage));
        this.sessionState.transcriptCache.set(key, clonedTranscript);
        if (clonedTranscript.length > 0) {
          this.sessionState.loadedTranscriptKeys.add(key);
          await this.transcriptStore.write(key, clonedTranscript);
        }
      }),
    );

    const attachmentEntries = Object.entries(persisted.composerAttachmentsBySession ?? {});
    await Promise.all(
      attachmentEntries.map(async ([key, attachments]) => {
        const cloned = cloneComposerImageAttachments(attachments as readonly ComposerImageAttachment[]);
        if (cloned.length > 0) {
          this.sessionState.composerAttachmentsBySession.set(key, cloned);
          await this.attachmentStore.write(key, cloned);
        }
      }),
    );
  }

  async refreshState(options: RefreshStateOptions = {}): Promise<DesktopAppState> {
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

    if (selectedWorkspaceId && selectedSessionId) {
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
    );
    const worktreesByWorkspace = buildWorktreeRecords(workspacesSnapshot.workspaces, worktreeEntries);
    const liveWorkspaceIds = new Set(workspaces.map((w) => w.id));
    for (const wsId of this.runtimeByWorkspace.keys()) {
      if (!liveWorkspaceIds.has(wsId)) {
        this.runtimeByWorkspace.delete(wsId);
      }
    }

    if (selectedWorkspaceId) {
      await this.ensureRuntimeLoaded(selectedWorkspaceId);
    }

    const activeView = options.activeView ?? this.state.activeView;
    this.state = {
      ...this.state,
      workspaces,
      worktreesByWorkspace,
      selectedWorkspaceId,
      selectedSessionId,
      activeView,
      runtimeByWorkspace: this.serializeRuntimeState(),
      sessionCommandsBySession: mapToRecord(this.sessionState.sessionCommandsBySession),
      sessionExtensionUiBySession: this.serializeSessionExtensionUiState(),
      lastViewedAtBySession: mapToRecord(this.sessionState.lastViewedAtBySession),
      workspaceOrder: this.state.workspaceOrder,
      composerDraft: this.resolveComposerDraft(selectedWorkspaceId, selectedSessionId, options.composerDraft),
      composerAttachments: this.resolveComposerAttachments(selectedWorkspaceId, selectedSessionId),
      lastError: this.resolveSelectedSessionError(selectedWorkspaceId, selectedSessionId, options.clearLastError),
      revision: this.state.revision + 1,
    };

    this.markSelectedSessionViewedIfVisible();

    await this.persistUiState();
    return this.emit();
  }

  private async pruneStaleSessionSubscriptions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    const activeKeys = new Set(sessions.map((session) => sessionKey(session.sessionRef)));
    this.sessionState.prune(activeKeys);
  }

  private async ensureSubscriptionsForSessions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    for (const session of sessions) {
      if (session.status !== "running") {
        continue;
      }
      await this.ensureSessionReady(session.sessionRef);
    }
  }

  async ensureSessionReady(sessionRef: SessionRef): Promise<void> {
    await this.ensureTranscriptLoaded(sessionRef);
    if (!this.sessionState.sessionSubscriptions.has(sessionKey(sessionRef))) {
      const snapshot = await this.driver.openSession(sessionRef);
      this.updateSessionConfig(sessionRef, snapshot.config);
    }
    await this.ensureSessionSubscribed(sessionRef);
    await this.refreshSessionCommands(sessionRef);
  }

  private async ensureTranscriptLoaded(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionState.loadedTranscriptKeys.has(key)) {
      return;
    }

    const cachedTranscript = await this.transcriptStore.read(key);
    const transcript = cachedTranscript ?? (await this.driver.getTranscript(sessionRef));
    this.sessionState.loadedTranscriptKeys.add(key);
    this.sessionState.transcriptCache.set(key, transcript);
  }

  async reloadTranscriptFromDriver(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    const transcript = await this.driver.getTranscript(sessionRef);
    this.sessionState.loadedTranscriptKeys.add(key);
    this.sessionState.transcriptCache.set(key, transcript);
    this.persistTranscriptCacheForSession(sessionRef);
  }

  private async ensureComposerAttachmentsLoaded(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionState.composerAttachmentsBySession.has(key)) {
      return;
    }

    const attachments = await this.attachmentStore.read(key);
    if (attachments?.length) {
      this.sessionState.composerAttachmentsBySession.set(key, cloneComposerImageAttachments(attachments));
    }
  }

  private async ensureRuntimeLoaded(workspaceId: string): Promise<void> {
    if (this.runtimeByWorkspace.has(workspaceId)) {
      return;
    }

    const ws = this.workspaceRefFromState(workspaceId);
    if (!ws) {
      return;
    }

    const snapshot = await this.driver.runtimeSupervisor.getRuntimeSnapshot(ws);
    this.runtimeByWorkspace.set(workspaceId, snapshot);
  }

  async ensureSessionSubscribed(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionState.sessionSubscriptions.has(key)) {
      return;
    }

    const unsubscribe = this.driver.subscribe(sessionRef, (event) => {
      void this.handleSessionEvent(event);
    });
    this.sessionState.sessionSubscriptions.set(key, unsubscribe);
  }

  async cancelPendingDialogsForSession(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    const uiState = this.sessionState.extensionUiBySession.get(key);
    if (!uiState || uiState.pendingDialogs.length === 0) {
      return;
    }

    const pendingDialogs = [...uiState.pendingDialogs];
    uiState.pendingDialogs = [];
    await Promise.all(
      pendingDialogs.map((dialog) =>
        this.driver.respondToHostUiRequest(sessionRef, {
          requestId: dialog.requestId,
          cancelled: true,
        } satisfies HostUiResponse),
      ),
    );
  }

  async respondToHostUiRequest(
    sessionRef: SessionRef,
    response: HostUiResponse,
  ): Promise<DesktopAppState> {
    const key = sessionKey(sessionRef);
    const uiState = this.sessionState.extensionUiBySession.get(key);
    if (uiState) {
      uiState.pendingDialogs = uiState.pendingDialogs.filter((dialog) => dialog.requestId !== response.requestId);
    }

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

  clearExtensionUiForSession(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    if (!this.sessionState.extensionUiBySession.has(key)) {
      return;
    }

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
      this.sessionState.extensionUiBySession.delete(key);
      return;
    }

    const uiState = this.getOrCreateExtensionUiState(event.sessionRef);
    applyHostUiRequestToExtensionUiState(uiState, event.request);

    switch (event.request.kind) {
      case "editorText":
        this.sessionState.composerDraftsBySession.set(key, event.request.text);
        if (
          this.state.selectedWorkspaceId === event.sessionRef.workspaceId &&
          this.state.selectedSessionId === event.sessionRef.sessionId
        ) {
          this.state = {
            ...this.state,
            composerDraft: event.request.text,
          };
        }
        break;
      default:
        if (isExtensionUiDialogRequest(event.request)) {
          const dialog = event.request;
          uiState.pendingDialogs = [
            ...uiState.pendingDialogs.filter((entry) => entry.requestId !== dialog.requestId),
            dialog,
          ];
        }
        break;
    }
  }

  private async handleSessionEvent(event: SessionDriverEvent): Promise<void> {
    const key = sessionKey(event.sessionRef);
    const knownSession = this.sessionFromState(event.sessionRef);
    if (
      !knownSession &&
      (event.type === "sessionOpened" ||
        event.type === "sessionUpdated" ||
        event.type === "runCompleted" ||
        event.type === "hostUiRequest")
    ) {
      await this.refreshState({
        selectedWorkspaceId:
          this.state.selectedWorkspaceId === event.sessionRef.workspaceId
            ? event.sessionRef.workspaceId
            : this.state.selectedWorkspaceId,
        selectedSessionId:
          this.state.selectedWorkspaceId === event.sessionRef.workspaceId
            ? event.sessionRef.sessionId
            : this.state.selectedSessionId,
        clearLastError: true,
      });
    }

    switch (event.type) {
      case "assistantDelta":
        appendAssistantDelta(this.sessionState.transcriptCache, this.sessionState.activeAssistantMessageBySession, event.sessionRef, event.text);
        break;
      case "sessionOpened":
      case "runCompleted":
        this.updateSessionConfig(event.sessionRef, event.snapshot.config);
        await this.refreshSessionCommands(event.sessionRef);
        break;
      case "sessionUpdated":
        this.updateSessionConfig(event.sessionRef, event.snapshot.config);
        if (event.snapshot.status !== "running") {
          await this.refreshSessionCommands(event.sessionRef);
        }
        break;
      case "runFailed":
        this.state = {
          ...this.state,
          lastError: event.error.message,
        };
        await this.refreshSessionCommands(event.sessionRef);
        break;
      case "sessionClosed":
        this.sessionState.extensionUiBySession.delete(key);
        this.sessionState.sessionCommandsBySession.delete(key);
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
    this.markSessionViewedIfVisible(event.sessionRef);
    this.state = this.syncDerivedSessionState(this.state, event.sessionRef);
    if (event.type !== "hostUiRequest") {
      this.persistTranscriptCacheForSession(event.sessionRef);
    }
    if (event.type === "runCompleted" || event.type === "runFailed" || event.type === "sessionClosed") {
      await this.persistUiState();
    } else if (event.type !== "hostUiRequest") {
      this.schedulePersistUiState();
    }
    const snapshot = this.emit();
    await this.emitSessionEvent(event, snapshot);
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

  private serializeRuntimeState(): Record<string, RuntimeSnapshot> {
    return mapToRecord(this.runtimeByWorkspace);
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
      lastViewedAtBySession: updateRecordValue(
        state.lastViewedAtBySession,
        key,
        this.sessionState.lastViewedAtBySession.get(key),
      ),
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

  sessionFromState(sessionRef: SessionRef) {
    return this.state.workspaces
      .find((w) => w.id === sessionRef.workspaceId)
      ?.sessions.find((s) => s.id === sessionRef.sessionId);
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
      notificationPreferences: this.state.notificationPreferences,
      lastViewedAtBySession: mapToRecord(this.sessionState.lastViewedAtBySession),
      workspaceOrder: this.state.workspaceOrder.length > 0 ? this.state.workspaceOrder : undefined,
    };

    await writePersistedUiState(this.uiStateFilePath, payload);
  }

  async persistComposerAttachments(
    key: string,
    attachments: readonly ComposerImageAttachment[],
  ): Promise<void> {
    await this.attachmentStore.write(key, cloneComposerImageAttachments(attachments));
    await this.persistUiState();
  }

  persistTranscriptCacheForSession(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    const existing = this.transcriptPersistTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.transcriptPersistTimers.delete(key);
      const transcript = (this.sessionState.transcriptCache.get(key) ?? []).map(cloneTranscriptMessage);
      void this.transcriptStore.write(key, transcript);
    }, 250);

    this.transcriptPersistTimers.set(key, timer);
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

  emit(): DesktopAppState {
    const snapshot = structuredClone(this.state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async emitSessionEvent(event: SessionDriverEvent, snapshot: DesktopAppState): Promise<void> {
    for (const listener of this.sessionEventListeners) {
      await listener(event, snapshot);
    }
  }

  async withError(error: unknown): Promise<DesktopAppState> {
    const message = error instanceof Error ? error.message : String(error);
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

  async withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState> {
    try {
      return await fn();
    } catch (error) {
      return this.withError(error);
    }
  }

  private markSelectedSessionViewedIfVisible(): void {
    if (this.state.activeView !== "threads" || !this.state.selectedWorkspaceId || !this.state.selectedSessionId) {
      return;
    }

    this.markSessionViewedIfVisible({
      workspaceId: this.state.selectedWorkspaceId,
      sessionId: this.state.selectedSessionId,
    });
  }

  private markSessionViewedIfVisible(sessionRef: SessionRef): void {
    if (
      this.state.activeView !== "threads" ||
      this.state.selectedWorkspaceId !== sessionRef.workspaceId ||
      this.state.selectedSessionId !== sessionRef.sessionId
    ) {
      return;
    }

    const viewedAt = this.sessionFromState(sessionRef)?.updatedAt ?? new Date().toISOString();
    this.markSessionViewed(sessionRef, viewedAt);
  }

  private markSessionViewed(sessionRef: SessionRef, viewedAt: string): void {
    const key = sessionKey(sessionRef);
    const current = this.sessionState.lastViewedAtBySession.get(key);
    if (current && current >= viewedAt) {
      return;
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

  private resolveComposerAttachments(
    selectedWorkspaceId: string,
    selectedSessionId: string,
  ): readonly ComposerImageAttachment[] {
    if (!selectedWorkspaceId || !selectedSessionId) {
      return [];
    }

    return this.sessionState.composerAttachmentsBySession.get(
      sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }),
    )?.map(cloneComposerImageAttachment) ?? [];
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
