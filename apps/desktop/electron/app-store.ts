import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { JsonCatalogStore, PiSdkDriver, type PiSdkDriverConfig } from "@pi-gui/pi-sdk-driver";
import type { SessionCatalogEntry, WorktreeCatalogEntry } from "@pi-gui/catalogs";
import type { SessionConfig, SessionDriverEvent, SessionRef, WorkspaceRef } from "@pi-gui/session-driver";
import type { RuntimeLoginCallbacks, RuntimeSettingsSnapshot, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
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
  formatSessionConfigStatus,
  incompleteComposerCommandMessage,
  parseComposerCommand,
} from "../src/composer-commands";
import {
  applyTimelineEvent,
  appendAssistantDelta,
  appendUserMessage,
  clearActiveAssistantMessage,
  type RunMetrics,
} from "./app-store-timeline";
import { applySessionEventState } from "./app-store-session-state";
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
  makeActivityItem,
  previewFromTranscript,
  resolveSelectedSessionId,
  resolveSelectedWorkspaceId,
  sessionKey,
  toSessionAttachments,
  toTranscriptAttachments,
  toSessionRef,
} from "./app-store-utils";
import { type CreateWorktreeOptions, GitWorktreeManager } from "./worktree-manager";

type StateListener = (state: DesktopAppState) => void;
type SessionEventListener = (event: SessionDriverEvent, state: DesktopAppState) => void | Promise<void>;

interface RefreshStateOptions {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly clearLastError?: boolean;
  readonly refreshWorktrees?: boolean;
  readonly activeView?: AppView;
}

export interface DesktopAppStoreOptions {
  readonly userDataDir: string;
  readonly initialWorkspacePaths: readonly string[];
}

function fallbackSelectionAfterWorkspaceRemoval(state: DesktopAppState, removedWorkspaceId: string): RefreshStateOptions {
  const remaining = state.workspaces.filter((workspace) => workspace.id !== removedWorkspaceId);
  const nextWorkspace = remaining[0];
  return {
    selectedWorkspaceId: nextWorkspace?.id,
    selectedSessionId: nextWorkspace?.sessions[0]?.id,
    composerDraft: "",
    clearLastError: true,
  };
}

export class DesktopAppStore {
  private state = createEmptyDesktopAppState();
  private readonly listeners = new Set<StateListener>();
  private readonly sessionEventListeners = new Set<SessionEventListener>();
  private readonly driver: PiSdkDriver;
  private readonly catalogStore: JsonCatalogStore;
  private readonly worktreeManager: GitWorktreeManager;
  private readonly uiStateFilePath: string;
  private readonly transcriptStore: JsonFileStore<TranscriptMessage[]>;
  private readonly attachmentStore: JsonFileStore<ComposerImageAttachment[]>;
  private readonly transcriptCache = new Map<string, TranscriptMessage[]>();
  private readonly composerDraftsBySession = new Map<string, string>();
  private readonly composerAttachmentsBySession = new Map<string, ComposerImageAttachment[]>();
  private readonly sessionConfigBySession = new Map<string, SessionConfig>();
  private readonly lastViewedAtBySession = new Map<string, string>();
  private readonly runtimeByWorkspace = new Map<string, RuntimeSnapshot>();
  private readonly sessionErrorsBySession = new Map<string, string>();
  private readonly sessionSubscriptions = new Map<string, () => void>();
  private readonly activeAssistantMessageBySession = new Map<string, string>();
  private readonly runningSinceBySession = new Map<string, string>();
  private readonly runMetricsBySession = new Map<string, RunMetrics>();
  private readonly activeWorkingActivityBySession = new Map<string, string>();
  private readonly loadedTranscriptKeys = new Set<string>();
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

  async addWorkspace(path: string): Promise<DesktopAppState> {
    await this.initialize();
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return this.emit();
    }

    const existing = this.state.workspaces.find((workspace) => workspace.path === normalizedPath);
    if (existing) {
      return this.syncWorkspace(existing.id, {
        selectedWorkspaceId: existing.id,
        selectedSessionId: this.state.selectedSessionId,
        clearLastError: true,
        refreshWorktrees: true,
      });
    }

    try {
      const synced = await this.driver.syncWorkspace(normalizedPath);
      const firstSession = synced.sessions[0];
      if (firstSession) {
        await this.ensureSessionReady(firstSession.sessionRef);
      }

      return this.refreshState({
        selectedWorkspaceId: synced.workspace.workspaceId,
        selectedSessionId: firstSession?.sessionRef.sessionId ?? "",
        composerDraft: "",
        clearLastError: true,
        refreshWorktrees: true,
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  getWorkspacePath(workspaceId: string): string | undefined {
    return this.state.workspaces.find((workspace) => workspace.id === workspaceId)?.path;
  }

  getSkillFilePath(workspaceId: string, filePath: string): string | undefined {
    return this.runtimeByWorkspace.get(workspaceId)?.skills.find((skill) => skill.filePath === filePath)?.filePath;
  }

  async renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState> {
    await this.initialize();
    const nextName = displayName.trim();
    if (!nextName) {
      return this.withError("Workspace name cannot be empty.");
    }

    try {
      await this.driver.renameWorkspace(workspaceId, nextName);
      return this.refreshState({
        selectedWorkspaceId: this.state.selectedWorkspaceId,
        selectedSessionId: this.state.selectedSessionId,
        clearLastError: true,
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async removeWorkspace(workspaceId: string): Promise<DesktopAppState> {
    await this.initialize();

    try {
      await this.driver.removeWorkspace(workspaceId);
      return this.refreshState(fallbackSelectionAfterWorkspaceRemoval(this.state, workspaceId));
    } catch (error) {
      return this.withError(error);
    }
  }

  async createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState> {
    await this.initialize();
    const rootWorkspace = this.workspaceRefFromState(input.workspaceId);
    if (!rootWorkspace) {
      return this.withError(`Unknown workspace: ${input.workspaceId}`);
    }

    try {
      const createOptions = this.defaultWorktreeOptions(
        rootWorkspace,
        input.fromSessionWorkspaceId,
        input.fromSessionId,
      );
      const created = await this.worktreeManager.createWorktree(rootWorkspace, createOptions);
      const synced = await this.driver.syncWorkspace(created.path, created.displayName);
      if (input.fromSessionId) {
        await this.driver.createSession(
          synced.workspace,
          { title: this.sessionTitleForWorktree(input.fromSessionWorkspaceId ?? input.workspaceId, input.fromSessionId) },
        );
      }

      return this.refreshState({
        selectedWorkspaceId: created.path,
        selectedSessionId: "",
        composerDraft: "",
        clearLastError: true,
        refreshWorktrees: false,
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState> {
    await this.initialize();
    const rootWorkspace = this.workspaceRefFromState(input.workspaceId);
    if (!rootWorkspace) {
      return this.withError(`Unknown workspace: ${input.workspaceId}`);
    }

    try {
      const worktree = await this.catalogStore.worktrees.getWorktree(input.worktreeId);
      await this.worktreeManager.removeWorktree(rootWorkspace, input.worktreeId);
      if (worktree?.path) {
        await this.driver.removeWorkspace(worktree.path).catch(() => undefined);
      }

      const selectedWorkspaceId =
        this.state.selectedWorkspaceId === input.worktreeId ? input.workspaceId : this.state.selectedWorkspaceId;
      const selectedSessionId =
        this.state.selectedWorkspaceId === input.worktreeId ? "" : this.state.selectedSessionId;
      return this.refreshState({
        selectedWorkspaceId,
        selectedSessionId,
        composerDraft: "",
        clearLastError: true,
        refreshWorktrees: false,
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async selectWorkspace(workspaceId: string): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return this.emit();
    }

    return this.syncWorkspace(workspaceId, {
      selectedWorkspaceId: workspaceId,
      selectedSessionId: this.state.selectedWorkspaceId === workspaceId ? this.state.selectedSessionId : "",
      clearLastError: true,
      refreshWorktrees: true,
      activeView: "threads",
    });
  }

  async selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();

    try {
      return this.refreshState({
        selectedWorkspaceId: target.workspaceId,
        selectedSessionId: target.sessionId,
        clearLastError: true,
        activeView: "threads",
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();

    try {
      await this.driver.archiveSession(toSessionRef(target));
      return this.refreshState(this.selectionAfterArchiving(target));
    } catch (error) {
      return this.withError(error);
    }
  }

  async unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();

    try {
      await this.driver.unarchiveSession(toSessionRef(target));
      return this.refreshState({
        selectedWorkspaceId: this.state.selectedWorkspaceId,
        selectedSessionId:
          this.state.selectedWorkspaceId === target.workspaceId && !this.state.selectedSessionId
            ? target.sessionId
            : this.state.selectedSessionId,
        clearLastError: true,
        activeView: "threads",
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async startThread(input: StartThreadInput): Promise<DesktopAppState> {
    await this.initialize();
    const rootWorkspace = this.workspaceRefFromState(input.rootWorkspaceId);
    if (!rootWorkspace) {
      return this.withError(`Unknown workspace: ${input.rootWorkspaceId}`);
    }

    try {
      let targetWorkspace = rootWorkspace;
      if (input.environment === "new-worktree") {
        const worktreeOptions = this.defaultWorktreeOptions(rootWorkspace, undefined, undefined, input.prompt);
        const created = await this.worktreeManager.createWorktree(rootWorkspace, worktreeOptions);
        const synced = await this.driver.syncWorkspace(created.path, created.displayName);
        targetWorkspace = synced.workspace;
      }

      const prompt = input.prompt?.trim() ?? "";
      const session = await this.driver.createSession(targetWorkspace, {
        title: initialThreadTitle(prompt),
      });
      const key = sessionKey(session.ref);
      this.transcriptCache.set(key, []);
      this.loadedTranscriptKeys.add(key);
      this.updateSessionConfig(session.ref, session.config);
      await this.ensureSessionSubscribed(session.ref);
      if (prompt) {
        await this.sendMessageToSession(session.ref, prompt, []);
      }

      return this.refreshState({
        selectedWorkspaceId: session.ref.workspaceId,
        selectedSessionId: session.ref.sessionId,
        composerDraft: "",
        clearLastError: true,
        refreshWorktrees: input.environment === "new-worktree",
        activeView: "threads",
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async setActiveView(activeView: AppView): Promise<DesktopAppState> {
    await this.initialize();
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

  async refreshRuntime(workspaceId?: string): Promise<DesktopAppState> {
    await this.initialize();
    const resolvedWorkspaceId = workspaceId || this.state.selectedWorkspaceId;
    const workspace = this.workspaceRefFromState(resolvedWorkspaceId);
    if (!workspace) {
      return this.emit();
    }

    try {
      const snapshot = await this.driver.refreshRuntime(workspace);
      this.runtimeByWorkspace.set(workspace.workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    } catch (error) {
      return this.withError(error);
    }
  }

  async setSessionModel(target: WorkspaceSessionTarget, provider: string, modelId: string): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    const key = sessionKey(sessionRef);

    try {
      await this.driver.setSessionModel(sessionRef, { provider, modelId });
      return this.finishComposerCommand(sessionRef, key, `Model set to ${provider}:${modelId}`);
    } catch (error) {
      return this.withError(error);
    }
  }

  async setDefaultModel(workspaceId: string, provider: string, modelId: string): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    try {
      const snapshot = await this.driver.setDefaultModel(workspace, { provider, modelId });
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    } catch (error) {
      return this.withError(error);
    }
  }

  async setDefaultThinkingLevel(
    workspaceId: string,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    try {
      const snapshot = await this.driver.setDefaultThinkingLevel(workspace, thinkingLevel);
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    } catch (error) {
      return this.withError(error);
    }
  }

  async setSessionThinkingLevel(
    sessionRef: SessionRef,
    thinkingLevel: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  ): Promise<DesktopAppState> {
    await this.initialize();
    const key = sessionKey(sessionRef);
    try {
      await this.driver.setSessionThinkingLevel(sessionRef, thinkingLevel);
      return this.finishComposerCommand(sessionRef, key, `Thinking set to ${thinkingLevel}`);
    } catch (error) {
      return this.withError(error);
    }
  }

  async loginProvider(
    workspaceId: string,
    providerId: string,
    callbacks: RuntimeLoginCallbacks,
  ): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    try {
      const snapshot = await this.driver.login(workspace, providerId, callbacks);
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    } catch (error) {
      return this.withError(error);
    }
  }

  async logoutProvider(workspaceId: string, providerId: string): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    try {
      const snapshot = await this.driver.logout(workspace, providerId);
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    } catch (error) {
      return this.withError(error);
    }
  }

  async setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    try {
      const snapshot = await this.driver.setEnableSkillCommands(workspace, enabled);
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    } catch (error) {
      return this.withError(error);
    }
  }

  async setScopedModelPatterns(workspaceId: string, patterns: readonly string[]): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    try {
      const snapshot = await this.driver.setScopedModelPatterns(workspace, patterns);
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    } catch (error) {
      return this.withError(error);
    }
  }

  async setSkillEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${workspaceId}`);
    }

    try {
      const snapshot = await this.driver.setSkillEnabled(workspace, filePath, enabled);
      this.runtimeByWorkspace.set(workspaceId, snapshot);
      return this.refreshState({ clearLastError: true });
    } catch (error) {
      return this.withError(error);
    }
  }

  async setNotificationPreferences(
    preferences: Partial<NotificationPreferences>,
  ): Promise<DesktopAppState> {
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

  async createSession(input: CreateSessionInput): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(input.workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${input.workspaceId}`);
    }

    try {
      const snapshot = await this.driver.createSession(workspace, {
        title: input.title?.trim() || "New thread",
      });
      const key = sessionKey(snapshot.ref);
      this.transcriptCache.set(key, []);
      this.loadedTranscriptKeys.add(key);
      this.updateSessionConfig(snapshot.ref, snapshot.config);
      await this.ensureSessionSubscribed(snapshot.ref);
      return this.refreshState({
        selectedWorkspaceId: snapshot.ref.workspaceId,
        selectedSessionId: snapshot.ref.sessionId,
        composerDraft: "",
        clearLastError: true,
        activeView: "threads",
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async updateComposerDraft(composerDraft: string): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = this.selectedSessionRef();
    if (sessionRef) {
      const key = sessionKey(sessionRef);
      if (composerDraft) {
        this.composerDraftsBySession.set(key, composerDraft);
      } else {
        this.composerDraftsBySession.delete(key);
      }
    }
    this.state = {
      ...this.state,
      composerDraft,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async addComposerImages(attachments: readonly ComposerImageAttachment[]): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = this.selectedSessionRef();
    if (!sessionRef || attachments.length === 0) {
      return this.emit();
    }

    const key = sessionKey(sessionRef);
    const existing = this.composerAttachmentsBySession.get(key) ?? [];
    const next = [...existing, ...attachments];
    this.composerAttachmentsBySession.set(key, next);
    this.state = {
      ...this.state,
      composerAttachments: next,
      revision: this.state.revision + 1,
    };
    await this.persistComposerAttachments(key, next);
    return this.emit();
  }

  async removeComposerImage(attachmentId: string): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = this.selectedSessionRef();
    if (!sessionRef) {
      return this.emit();
    }

    const key = sessionKey(sessionRef);
    const existing = this.composerAttachmentsBySession.get(key) ?? [];
    const next = existing.filter((attachment) => attachment.id !== attachmentId);
    if (next.length > 0) {
      this.composerAttachmentsBySession.set(key, next);
    } else {
      this.composerAttachmentsBySession.delete(key);
    }
    this.state = {
      ...this.state,
      composerAttachments: next,
      revision: this.state.revision + 1,
    };
    await this.persistComposerAttachments(key, next);
    return this.emit();
  }

  async submitComposer(textInput: string): Promise<DesktopAppState> {
    await this.initialize();
    const text = textInput.trim();
    const sessionRef = this.selectedSessionRef();
    const attachments = sessionRef
      ? this.composerAttachmentsBySession.get(sessionKey(sessionRef)) ?? []
      : [];
    if (!text && attachments.length === 0) {
      return this.emit();
    }
    if (!sessionRef) {
      return this.withError("Create or select a session before sending a message.");
    }

    if (text.startsWith("/")) {
      const handled = await this.runComposerCommand(sessionRef, text);
      if (handled) {
        return handled;
      }
    }

    const key = sessionKey(sessionRef);
    try {
      await this.sendMessageToSession(sessionRef, text, attachments);
      return this.refreshState({
        clearLastError: true,
      });
    } catch (error) {
      if (textInput) {
        this.composerDraftsBySession.set(key, textInput);
      }
      if (attachments.length > 0) {
        this.composerAttachmentsBySession.set(key, cloneComposerImageAttachments(attachments));
        await this.persistComposerAttachments(key, attachments);
      }
      return this.withError(error);
    }
  }

  async cancelCurrentRun(): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = this.selectedSessionRef();
    if (!sessionRef) {
      return this.emit();
    }

    try {
      await this.driver.cancelCurrentRun(sessionRef);
      clearActiveAssistantMessage(this.activeAssistantMessageBySession, sessionRef);
      this.sessionErrorsBySession.delete(sessionKey(sessionRef));
      this.state = {
        ...this.state,
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      this.schedulePersistUiState();
      return this.emit();
    } catch (error) {
      return this.withError(error);
    }
  }

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
      };
      await this.migrateLegacyPersistence(persisted);
      this.lastViewedAtBySession.clear();
      for (const [key, viewedAt] of Object.entries(persisted.lastViewedAtBySession ?? {})) {
        if (viewedAt) {
          this.lastViewedAtBySession.set(key, viewedAt);
        }
      }
      this.composerDraftsBySession.clear();
      for (const [key, draft] of Object.entries(persisted.composerDraftsBySession ?? {})) {
        if (draft) {
          this.composerDraftsBySession.set(key, draft);
        }
      }
      const initialWorkspacePaths = this.initialWorkspacePaths.map((path) => path.trim()).filter(Boolean);
      const knownWorkspaces = await this.driver.listWorkspaces();
      const workspacesToSync = new Map<string, string | undefined>();

      for (const workspacePath of initialWorkspacePaths) {
        workspacesToSync.set(workspacePath, undefined);
      }

      for (const workspace of knownWorkspaces.workspaces) {
        workspacesToSync.set(workspace.path, workspace.displayName);
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
        this.transcriptCache.set(key, clonedTranscript);
        if (clonedTranscript.length > 0) {
          this.loadedTranscriptKeys.add(key);
          await this.transcriptStore.write(key, clonedTranscript);
        }
      }),
    );

    const attachmentEntries = Object.entries(persisted.composerAttachmentsBySession ?? {});
    await Promise.all(
      attachmentEntries.map(async ([key, attachments]) => {
        const cloned = cloneComposerImageAttachments(attachments as readonly ComposerImageAttachment[]);
        if (cloned.length > 0) {
          this.composerAttachmentsBySession.set(key, cloned);
          await this.attachmentStore.write(key, cloned);
        }
      }),
    );
  }

  private async refreshState(options: RefreshStateOptions = {}): Promise<DesktopAppState> {
    const [workspacesSnapshot, sessionsSnapshot] = await Promise.all([
      this.driver.listWorkspaces(),
      this.driver.listSessions(),
    ]);
    const worktreeEntries = options.refreshWorktrees
      ? await this.syncAndListWorktrees(workspacesSnapshot.workspaces)
      : (await this.catalogStore.worktrees.listWorktrees()).worktrees;

    await this.pruneStaleSessionSubscriptions(sessionsSnapshot.sessions);
    await this.ensureSubscriptionsForSessions(sessionsSnapshot.sessions);

    let workspaces = buildWorkspaceRecords(
      workspacesSnapshot.workspaces,
      worktreeEntries,
      sessionsSnapshot.sessions,
      this.transcriptCache,
      this.runningSinceBySession,
      this.sessionConfigBySession,
      this.lastViewedAtBySession,
    );
    const worktreesByWorkspace = buildWorktreeRecords(workspacesSnapshot.workspaces, worktreeEntries);
    const liveWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const workspaceId of this.runtimeByWorkspace.keys()) {
      if (!liveWorkspaceIds.has(workspaceId)) {
        this.runtimeByWorkspace.delete(workspaceId);
      }
    }
    const selectedWorkspaceId = resolveSelectedWorkspaceId(
      options.selectedWorkspaceId ?? this.state.selectedWorkspaceId,
      workspaces,
    );
    const selectedSessionId = resolveSelectedSessionId(
      selectedWorkspaceId,
      options.selectedSessionId ?? this.state.selectedSessionId,
      workspaces,
    );

    if (selectedWorkspaceId && selectedSessionId) {
      const sessionRef = {
        workspaceId: selectedWorkspaceId,
        sessionId: selectedSessionId,
      };
      await this.ensureSessionReady(sessionRef);
      await this.ensureComposerAttachmentsLoaded(sessionRef);
      workspaces = buildWorkspaceRecords(
        workspacesSnapshot.workspaces,
        worktreeEntries,
        sessionsSnapshot.sessions,
        this.transcriptCache,
        this.runningSinceBySession,
        this.sessionConfigBySession,
        this.lastViewedAtBySession,
      );
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
      lastViewedAtBySession: Object.fromEntries(this.lastViewedAtBySession.entries()),
      composerDraft: this.resolveComposerDraft(selectedWorkspaceId, selectedSessionId, options.composerDraft),
      composerAttachments: this.resolveComposerAttachments(selectedWorkspaceId, selectedSessionId),
      lastError: this.resolveSelectedSessionError(selectedWorkspaceId, selectedSessionId, options.clearLastError),
      revision: this.state.revision + 1,
    };

    this.markSelectedSessionViewedIfVisible();

    await this.persistUiState();
    return this.emit();
  }

  async syncCurrentWorkspace(): Promise<DesktopAppState> {
    await this.initialize();
    if (!this.state.selectedWorkspaceId) {
      return this.refreshState({ clearLastError: true, refreshWorktrees: true });
    }

    return this.syncWorkspace(this.state.selectedWorkspaceId, {
      selectedWorkspaceId: this.state.selectedWorkspaceId,
      selectedSessionId: this.state.selectedSessionId,
      clearLastError: true,
      refreshWorktrees: true,
    });
  }

  private async pruneStaleSessionSubscriptions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    const activeKeys = new Set(sessions.map((session) => sessionKey(session.sessionRef)));
    for (const [key, unsubscribe] of this.sessionSubscriptions) {
      if (!activeKeys.has(key)) {
        unsubscribe();
        this.sessionSubscriptions.delete(key);
        this.activeAssistantMessageBySession.delete(key);
        this.runningSinceBySession.delete(key);
        this.runMetricsBySession.delete(key);
        this.activeWorkingActivityBySession.delete(key);
        this.composerDraftsBySession.delete(key);
        this.composerAttachmentsBySession.delete(key);
        this.sessionConfigBySession.delete(key);
        this.lastViewedAtBySession.delete(key);
        this.sessionErrorsBySession.delete(key);
        this.loadedTranscriptKeys.delete(key);
        this.transcriptCache.delete(key);
      }
    }
  }

  private async ensureSubscriptionsForSessions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    for (const session of sessions) {
      if (session.status !== "running") {
        continue;
      }
      await this.ensureSessionReady(session.sessionRef);
    }
  }

  private async syncWorkspace(workspaceId: string, refreshOptions: RefreshStateOptions): Promise<DesktopAppState> {
    const workspace = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return this.emit();
    }

    try {
      await this.driver.syncWorkspace(workspace.path, workspace.name);
      return this.refreshState(refreshOptions);
    } catch (error) {
      return this.withError(error);
    }
  }

  private async ensureSessionReady(sessionRef: SessionRef): Promise<void> {
    await this.ensureTranscriptLoaded(sessionRef);
    if (!this.sessionSubscriptions.has(sessionKey(sessionRef))) {
      const snapshot = await this.driver.openSession(sessionRef);
      this.updateSessionConfig(sessionRef, snapshot.config);
    }
    await this.ensureSessionSubscribed(sessionRef);
  }

  private async ensureTranscriptLoaded(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.loadedTranscriptKeys.has(key)) {
      return;
    }

    const cachedTranscript = await this.transcriptStore.read(key);
    const transcript = cachedTranscript ?? (await this.driver.getTranscript(sessionRef));
    this.loadedTranscriptKeys.add(key);
    this.transcriptCache.set(key, transcript.map(cloneTranscriptMessage));
  }

  private async reloadTranscriptFromDriver(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    const transcript = await this.driver.getTranscript(sessionRef);
    this.loadedTranscriptKeys.add(key);
    this.transcriptCache.set(key, transcript.map(cloneTranscriptMessage));
    this.persistTranscriptCacheForSession(sessionRef);
  }

  private async ensureComposerAttachmentsLoaded(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.composerAttachmentsBySession.has(key)) {
      return;
    }

    const attachments = await this.attachmentStore.read(key);
    if (attachments?.length) {
      this.composerAttachmentsBySession.set(key, cloneComposerImageAttachments(attachments));
    }
  }

  private async ensureRuntimeLoaded(workspaceId: string): Promise<void> {
    if (this.runtimeByWorkspace.has(workspaceId)) {
      return;
    }

    const workspace = this.workspaceRefFromState(workspaceId);
    if (!workspace) {
      return;
    }

    const snapshot = await this.driver.getRuntimeSnapshot(workspace);
    this.runtimeByWorkspace.set(workspaceId, snapshot);
  }

  private async ensureSessionSubscribed(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionSubscriptions.has(key)) {
      return;
    }

    const unsubscribe = this.driver.subscribe(sessionRef, (event) => {
      void this.handleSessionEvent(event);
    });
    this.sessionSubscriptions.set(key, unsubscribe);
  }

  private async handleSessionEvent(event: SessionDriverEvent): Promise<void> {
    const key = sessionKey(event.sessionRef);

    switch (event.type) {
      case "assistantDelta":
        appendAssistantDelta(this.transcriptCache, this.activeAssistantMessageBySession, event.sessionRef, event.text);
        break;
      case "sessionOpened":
      case "sessionUpdated":
      case "runCompleted":
        this.updateSessionConfig(event.sessionRef, event.snapshot.config);
        break;
      case "runFailed":
        this.state = {
          ...this.state,
          lastError: event.error.message,
        };
        break;
      case "sessionClosed":
      case "toolStarted":
      case "toolUpdated":
      case "toolFinished":
      case "hostUiRequest":
        break;
      default:
        break;
    }

    if (event.type === "sessionClosed") {
      this.sessionSubscriptions.get(key)?.();
      this.sessionSubscriptions.delete(key);
    }

    if (event.type === "runFailed") {
      this.sessionErrorsBySession.set(key, event.error.message);
    } else if (event.type === "runCompleted" || event.type === "sessionClosed") {
      this.sessionErrorsBySession.delete(key);
    }

    applyTimelineEvent(this.transcriptCache, event, {
      runMetricsBySession: this.runMetricsBySession,
      runningSinceBySession: this.runningSinceBySession,
      activeAssistantMessageBySession: this.activeAssistantMessageBySession,
      activeWorkingActivityBySession: this.activeWorkingActivityBySession,
    });
    this.state = applySessionEventState(
      this.state,
      event,
      this.transcriptCache,
      this.runningSinceBySession,
      this.lastViewedAtBySession,
    );
    this.markSessionViewedIfVisible(event.sessionRef);
    this.state = {
      ...this.state,
      lastViewedAtBySession: Object.fromEntries(this.lastViewedAtBySession.entries()),
      lastError: this.resolveSelectedSessionError(this.state.selectedWorkspaceId, this.state.selectedSessionId, false),
    };
    this.persistTranscriptCacheForSession(event.sessionRef);
    if (event.type === "runCompleted" || event.type === "runFailed" || event.type === "sessionClosed") {
      await this.persistUiState();
    } else {
      this.schedulePersistUiState();
    }
    const snapshot = this.emit();
    await this.emitSessionEvent(event, snapshot);
  }

  private async syncAndListWorktrees(
    workspaces: readonly { workspaceId: string; path: string; displayName: string }[],
  ): Promise<readonly WorktreeCatalogEntry[]> {
    const existing = await this.catalogStore.worktrees.listWorktrees();
    const existingPrimaryByWorkspaceId = new Set(
      existing.worktrees.filter((worktree) => worktree.kind === "primary").map((worktree) => worktree.workspaceId),
    );
    const inspected = await Promise.all(
      workspaces.map(async (workspace) => {
        try {
          const inspection = await this.worktreeManager.inspectWorkspace(workspace);
          return {
            workspace,
            ...inspection,
          };
        } catch {
          return {
            workspace,
            canonicalPath: workspace.path,
            commonDir: `workspace:${workspace.workspaceId}`,
          };
        }
      }),
    );
    const groups = new Map<string, typeof inspected>();

    for (const entry of inspected) {
      const group = groups.get(entry.commonDir);
      if (group) {
        group.push(entry);
      } else {
        groups.set(entry.commonDir, [entry]);
      }
    }

    const syncRoots = [...groups.values()]
      .map((group) =>
        [...group].sort((left, right) => {
          if (left.canonicalPath.length !== right.canonicalPath.length) {
            return left.canonicalPath.length - right.canonicalPath.length;
          }
          const leftIsExistingPrimary = existingPrimaryByWorkspaceId.has(left.workspace.workspaceId);
          const rightIsExistingPrimary = existingPrimaryByWorkspaceId.has(right.workspace.workspaceId);
          if (leftIsExistingPrimary !== rightIsExistingPrimary) {
            return leftIsExistingPrimary ? -1 : 1;
          }
          return left.workspace.displayName.localeCompare(right.workspace.displayName);
        })[0],
      )
      .filter((entry): entry is (typeof inspected)[number] => Boolean(entry));

    await Promise.all(
      syncRoots.map((entry) =>
        this.worktreeManager
          .refreshWorktrees({
            workspaceId: entry.workspace.workspaceId,
            path: entry.workspace.path,
            displayName: entry.workspace.displayName,
          })
          .catch(() => undefined),
      ),
    );

    return (await this.catalogStore.worktrees.listWorktrees()).worktrees;
  }

  private workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined {
    const workspace = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return undefined;
    }

    return {
      workspaceId: workspace.id,
      path: workspace.path,
      displayName: workspace.name,
    };
  }

  private defaultWorktreeOptions(
    workspace: WorkspaceRef,
    fromSessionWorkspaceId?: string,
    fromSessionId?: string,
    titleHint?: string,
  ): CreateWorktreeOptions {
    const sessionTitle =
      fromSessionId && fromSessionWorkspaceId
        ? this.sessionTitleForWorktree(fromSessionWorkspaceId, fromSessionId)
        : undefined;
    const preferredTitle = shortDisplayTitle(titleHint?.trim() || sessionTitle);
    const suffix = shortUniqueSuffix();
    const baseLabel = preferredTitle
      ? clampSlug(slugify(preferredTitle), 18)
      : "wt";
    const folderName = `${baseLabel}-${suffix}`;
    const repoName = clampSlug(slugify(basename(workspace.path) || "repo"), 20);
    const displayName = preferredTitle || `Worktree ${suffix}`;
    return {
      path: join(homedir(), ".pi", "worktrees", repoName, folderName),
      displayName,
      branchName: `pi/${folderName}`,
      startPoint: "HEAD",
    };
  }

  private sessionTitleForWorktree(workspaceId: string, sessionId: string): string | undefined {
    return this.state.workspaces
      .find((workspace) => workspace.id === workspaceId)
      ?.sessions.find((session) => session.id === sessionId)
      ?.title.trim();
  }

  private serializeRuntimeState(): Record<string, RuntimeSnapshot> {
    return Object.fromEntries(this.runtimeByWorkspace.entries());
  }

  private selectedSessionRef(): SessionRef | undefined {
    if (!this.state.selectedWorkspaceId || !this.state.selectedSessionId) {
      return undefined;
    }

    return toSessionRef({
      workspaceId: this.state.selectedWorkspaceId,
      sessionId: this.state.selectedSessionId,
    });
  }

  private sessionFromState(sessionRef: SessionRef) {
    return this.state.workspaces
      .find((workspace) => workspace.id === sessionRef.workspaceId)
      ?.sessions.find((session) => session.id === sessionRef.sessionId);
  }

  private selectionAfterArchiving(target: WorkspaceSessionTarget): RefreshStateOptions {
    if (
      this.state.selectedWorkspaceId !== target.workspaceId ||
      this.state.selectedSessionId !== target.sessionId
    ) {
      return {
        selectedWorkspaceId: this.state.selectedWorkspaceId,
        selectedSessionId: this.state.selectedSessionId,
        clearLastError: true,
        activeView: "threads",
      };
    }

    const targetWorkspace = this.state.workspaces.find((workspace) => workspace.id === target.workspaceId);
    if (!targetWorkspace) {
      return {
        selectedWorkspaceId: this.state.selectedWorkspaceId,
        selectedSessionId: this.state.selectedSessionId,
        clearLastError: true,
        activeView: "threads",
      };
    }

    const rootWorkspaceId =
      targetWorkspace.kind === "worktree" ? (targetWorkspace.rootWorkspaceId ?? targetWorkspace.id) : targetWorkspace.id;
    const rankedCandidates = this.state.workspaces
      .filter(
        (workspace) =>
          workspace.id === rootWorkspaceId || workspace.rootWorkspaceId === rootWorkspaceId,
      )
      .flatMap((workspace) =>
        workspace.sessions
          .filter((session) => session.id !== target.sessionId || workspace.id !== target.workspaceId)
          .filter((session) => !session.archivedAt)
          .map((session) => ({ workspaceId: workspace.id, session })),
      )
      .sort((left, right) => {
        if (left.workspaceId === target.workspaceId && right.workspaceId !== target.workspaceId) {
          return -1;
        }
        if (left.workspaceId !== target.workspaceId && right.workspaceId === target.workspaceId) {
          return 1;
        }
        if (left.session.updatedAt !== right.session.updatedAt) {
          return right.session.updatedAt.localeCompare(left.session.updatedAt);
        }
        return left.session.title.localeCompare(right.session.title);
      });

    const next = rankedCandidates[0];
    return {
      selectedWorkspaceId: next?.workspaceId ?? target.workspaceId,
      selectedSessionId: next?.session.id ?? "",
      clearLastError: true,
      activeView: "threads",
    };
  }

  private async readUiState(): Promise<LegacyPersistedUiState> {
    return readPersistedUiState(this.uiStateFilePath);
  }

  private async persistUiState(): Promise<void> {
    if (this.persistUiStateTimer) {
      clearTimeout(this.persistUiStateTimer);
      this.persistUiStateTimer = undefined;
    }
    const payload: PersistedUiState = {
      selectedWorkspaceId: this.state.selectedWorkspaceId || undefined,
      selectedSessionId: this.state.selectedSessionId || undefined,
      activeView: this.state.activeView,
      composerDraft: this.state.composerDraft || undefined,
      composerDraftsBySession: Object.fromEntries(this.composerDraftsBySession.entries()),
      notificationPreferences: this.state.notificationPreferences,
      lastViewedAtBySession: Object.fromEntries(this.lastViewedAtBySession.entries()),
    };

    await writePersistedUiState(this.uiStateFilePath, payload);
  }

  private async persistComposerAttachments(
    key: string,
    attachments: readonly ComposerImageAttachment[],
  ): Promise<void> {
    await this.attachmentStore.write(key, cloneComposerImageAttachments(attachments));
    await this.persistUiState();
  }

  private persistTranscriptCacheForSession(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    const existing = this.transcriptPersistTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.transcriptPersistTimers.delete(key);
      const transcript = (this.transcriptCache.get(key) ?? []).map(cloneTranscriptMessage);
      void this.transcriptStore.write(key, transcript);
    }, 250);

    this.transcriptPersistTimers.set(key, timer);
  }

  private schedulePersistUiState(): void {
    if (this.persistUiStateTimer) {
      clearTimeout(this.persistUiStateTimer);
    }

    this.persistUiStateTimer = setTimeout(() => {
      this.persistUiStateTimer = undefined;
      void this.persistUiState();
    }, 250);
  }

  private emit(): DesktopAppState {
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

  private async withError(error: unknown): Promise<DesktopAppState> {
    const message = error instanceof Error ? error.message : String(error);
    const sessionRef = this.selectedSessionRef();
    if (sessionRef) {
      this.sessionErrorsBySession.set(sessionKey(sessionRef), message);
    }
    this.state = {
      ...this.state,
      lastError: message,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
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
    const current = this.lastViewedAtBySession.get(key);
    if (current && current >= viewedAt) {
      return;
    }

    this.lastViewedAtBySession.set(key, viewedAt);
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map((workspace) =>
        workspace.id === sessionRef.workspaceId
          ? {
              ...workspace,
              sessions: workspace.sessions.map((session) =>
                session.id === sessionRef.sessionId
                  ? {
                      ...session,
                      lastViewedAt: viewedAt,
                      hasUnseenUpdate: false,
                    }
                  : session,
              ),
            }
          : workspace,
      ),
      lastViewedAtBySession: Object.fromEntries(this.lastViewedAtBySession.entries()),
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
          this.composerDraftsBySession.set(key, explicitDraft);
        } else {
          this.composerDraftsBySession.delete(key);
        }
      }
      return explicitDraft;
    }

    if (!selectedWorkspaceId || !selectedSessionId) {
      return "";
    }

    return this.composerDraftsBySession.get(sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })) ?? "";
  }

  private resolveComposerAttachments(
    selectedWorkspaceId: string,
    selectedSessionId: string,
  ): readonly ComposerImageAttachment[] {
    if (!selectedWorkspaceId || !selectedSessionId) {
      return [];
    }

    return this.composerAttachmentsBySession.get(
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
      this.sessionErrorsBySession.delete(key);
      return undefined;
    }

    return this.sessionErrorsBySession.get(key);
  }

  private async sendMessageToSession(
    sessionRef: SessionRef,
    text: string,
    attachments: readonly ComposerImageAttachment[],
  ): Promise<void> {
    const key = sessionKey(sessionRef);
    if (!this.loadedTranscriptKeys.has(key)) {
      await this.ensureSessionReady(sessionRef);
    }
    if (this.sessionFromState(sessionRef)?.archivedAt) {
      await this.driver.unarchiveSession(sessionRef);
    }
    appendUserMessage(
      this.transcriptCache,
      sessionRef,
      text,
      toTranscriptAttachments(attachments),
    );
    this.persistTranscriptCacheForSession(sessionRef);
    clearActiveAssistantMessage(this.activeAssistantMessageBySession, sessionRef);
    this.sessionErrorsBySession.delete(key);
    this.composerDraftsBySession.delete(key);
    this.composerAttachmentsBySession.delete(key);
    await this.persistComposerAttachments(key, []);
    try {
      await this.driver.sendUserMessage(sessionRef, {
        text,
        attachments: toSessionAttachments(attachments),
      });
    } catch (error) {
      const transcript = this.transcriptCache.get(key) ?? [];
      this.transcriptCache.set(key, transcript.slice(0, -1));
      this.persistTranscriptCacheForSession(sessionRef);
      throw error;
    }
  }

  private async runComposerCommand(sessionRef: SessionRef, commandText: string): Promise<DesktopAppState | undefined> {
    const parsed = parseComposerCommand(commandText);
    if (!parsed) {
      const message = incompleteComposerCommandMessage(commandText);
      if (message) {
        return this.withError(message);
      }
      return undefined;
    }

    const key = sessionKey(sessionRef);

    if (parsed.type === "model") {
      await this.driver.setSessionModel(sessionRef, {
        provider: parsed.provider,
        modelId: parsed.modelId,
      });
      return this.finishComposerCommand(sessionRef, key, `Model set to ${parsed.provider}:${parsed.modelId}`);
    }

    if (parsed.type === "thinking") {
      await this.driver.setSessionThinkingLevel(sessionRef, parsed.thinkingLevel);
      return this.finishComposerCommand(sessionRef, key, `Thinking set to ${parsed.thinkingLevel}`);
    }

    if (parsed.type === "status") {
      return this.finishComposerCommand(sessionRef, key, formatSessionConfigStatus(this.sessionConfigBySession.get(key)));
    }

    if (parsed.type === "session") {
      const workspace = this.state.workspaces.find((entry) => entry.id === sessionRef.workspaceId);
      const session = workspace?.sessions.find((entry) => entry.id === sessionRef.sessionId);
      const parts = [
        `Session ${session?.title ?? sessionRef.sessionId}`,
        `ID ${sessionRef.sessionId}`,
        workspace ? `Workspace ${workspace.name}` : undefined,
        session ? `Status ${session.status}` : undefined,
      ].filter(Boolean);
      return this.finishComposerCommand(sessionRef, key, parts.join(" · "));
    }

    if (parsed.type === "name") {
      await this.driver.renameSession(sessionRef, parsed.title);
      return this.finishComposerCommand(sessionRef, key, `Session renamed to ${parsed.title}`);
    }

    if (parsed.type === "compact") {
      await this.driver.compactSession(sessionRef, parsed.customInstructions);
      await this.reloadTranscriptFromDriver(sessionRef);
      return this.finishComposerCommand(sessionRef, key, "Compacted session context");
    }

    if (parsed.type === "reload") {
      await this.driver.reloadSession(sessionRef);
      return this.finishComposerCommand(sessionRef, key, "Reloaded session resources");
    }

    return this.withError(`Unsupported slash command: ${commandText}`);
  }

  private appendLocalActivity(sessionRef: SessionRef, label: string): void {
    const key = sessionKey(sessionRef);
    const transcript = [...(this.transcriptCache.get(key) ?? [])];
    transcript.push(makeActivityItem(label));
    this.transcriptCache.set(key, transcript);
    this.persistTranscriptCacheForSession(sessionRef);
  }

  private finishComposerCommand(sessionRef: SessionRef, key: string, label: string): DesktopAppState {
    this.composerDraftsBySession.delete(key);
    this.composerAttachmentsBySession.delete(key);
    this.appendLocalActivity(sessionRef, label);
    const transcript = (this.transcriptCache.get(key) ?? []).map(cloneTranscriptMessage);
    const preview = previewFromTranscript(transcript);
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map((workspace) =>
        workspace.id === sessionRef.workspaceId
          ? {
              ...workspace,
              sessions: workspace.sessions.map((session) =>
                session.id === sessionRef.sessionId
                  ? {
                      ...session,
                      preview: preview ?? session.preview,
                      config: this.sessionConfigBySession.get(key),
                      transcript,
                    }
                  : session,
              ),
            }
          : workspace,
      ),
      composerDraft: "",
      composerAttachments: [],
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    this.schedulePersistUiState();
    return this.emit();
  }

  private updateSessionConfig(sessionRef: SessionRef, config: SessionConfig | undefined): void {
    const key = sessionKey(sessionRef);
    if (config && Object.keys(config).length > 0) {
      this.sessionConfigBySession.set(key, config);
    } else {
      this.sessionConfigBySession.delete(key);
    }
  }
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "worktree";
}

function clampSlug(value: string, limit = 28): string {
  if (value.length <= limit) {
    return value;
  }
  const trimmed = value.slice(0, limit).replace(/-+$/g, "");
  return trimmed || "worktree";
}

function shortUniqueSuffix(): string {
  return randomUUID().slice(0, 6);
}

function shortDisplayTitle(value: string | undefined, limit = 44): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3).trimEnd()}...` : trimmed;
}

function initialThreadTitle(prompt: string): string {
  const firstLine = prompt
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!firstLine) {
    return "New thread";
  }
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}...` : firstLine;
}
