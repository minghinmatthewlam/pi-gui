import { join } from "node:path";
import { PiSdkDriver, type PiSdkDriverConfig } from "@pi-app/pi-sdk-driver";
import type { SessionCatalogEntry } from "@pi-app/catalogs";
import type { SessionDriverEvent, SessionRef, WorkspaceRef } from "@pi-app/session-driver";
import {
  cloneDesktopAppState,
  createEmptyDesktopAppState,
  type CreateSessionInput,
  type DesktopAppState,
  type TranscriptMessage,
  type WorkspaceSessionTarget,
} from "../src/desktop-state";
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
  type PersistedUiState,
  writePersistedUiState,
} from "./app-store-persistence";
import {
  buildWorkspaceRecords,
  cloneTranscriptMessage,
  resolveSelectedSessionId,
  resolveSelectedWorkspaceId,
  sessionKey,
  TRANSCRIPT_HISTORY_LIMIT,
  toSessionRef,
} from "./app-store-utils";

type StateListener = (state: DesktopAppState) => void;

interface RefreshStateOptions {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly clearLastError?: boolean;
}

export interface DesktopAppStoreOptions {
  readonly userDataDir: string;
  readonly initialWorkspacePaths: readonly string[];
}

export class DesktopAppStore {
  private state = createEmptyDesktopAppState();
  private readonly listeners = new Set<StateListener>();
  private readonly driver: PiSdkDriver;
  private readonly uiStateFilePath: string;
  private readonly transcriptCache = new Map<string, TranscriptMessage[]>();
  private readonly sessionSubscriptions = new Map<string, () => void>();
  private readonly activeAssistantMessageBySession = new Map<string, string>();
  private readonly runningSinceBySession = new Map<string, string>();
  private readonly runMetricsBySession = new Map<string, RunMetrics>();
  private readonly activeWorkingActivityBySession = new Map<string, string>();
  private readonly loadedTranscriptKeys = new Set<string>();
  private readonly initialWorkspacePaths: readonly string[];
  private persistTimer: NodeJS.Timeout | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(options: DesktopAppStoreOptions) {
    const driverOptions: PiSdkDriverConfig = {
      catalogFilePath: join(options.userDataDir, "catalogs.json"),
    };

    this.driver = new PiSdkDriver(driverOptions);
    this.uiStateFilePath = join(options.userDataDir, "ui-state.json");
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
    return cloneDesktopAppState(this.state);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    void this.getState().then(listener).catch(() => undefined);
    return () => {
      this.listeners.delete(listener);
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

    const syncedState = await this.syncWorkspace(workspaceId, {
      selectedWorkspaceId: workspaceId,
      selectedSessionId: this.state.selectedSessionId,
      clearLastError: true,
    });
    const syncedWorkspace = syncedState.workspaces.find((entry) => entry.id === workspaceId);

    const firstSession = syncedWorkspace?.sessions[0];
    if (firstSession) {
      await this.ensureSessionReady({
        workspaceId,
        sessionId: firstSession.id,
      });
    }

    return this.refreshState({
      selectedWorkspaceId: workspaceId,
      selectedSessionId: firstSession?.id ?? "",
      clearLastError: true,
    });
  }

  async selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);

    try {
      await this.ensureSessionReady(sessionRef);
      return this.refreshState({
        selectedWorkspaceId: target.workspaceId,
        selectedSessionId: target.sessionId,
        clearLastError: true,
      });
    } catch (error) {
      return this.withError(error);
    }
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
      this.transcriptCache.set(sessionKey(snapshot.ref), []);
      await this.ensureSessionSubscribed(snapshot.ref);
      return this.refreshState({
        selectedWorkspaceId: snapshot.ref.workspaceId,
        selectedSessionId: snapshot.ref.sessionId,
        composerDraft: "",
        clearLastError: true,
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async updateComposerDraft(composerDraft: string): Promise<DesktopAppState> {
    await this.initialize();
    this.state = {
      ...this.state,
      composerDraft,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async submitComposer(textInput: string): Promise<DesktopAppState> {
    await this.initialize();
    const text = textInput.trim();
    if (!text) {
      return this.emit();
    }

    const sessionRef = this.selectedSessionRef();
    if (!sessionRef) {
      return this.withError("Create or select a session before sending a message.");
    }

    const key = sessionKey(sessionRef);
    if (!this.loadedTranscriptKeys.has(key)) {
      await this.ensureSessionReady(sessionRef);
    }
    const transcript = appendUserMessage(this.transcriptCache, sessionRef, text);
    clearActiveAssistantMessage(this.activeAssistantMessageBySession, sessionRef);

    try {
      await this.driver.sendUserMessage(sessionRef, { text });
      return this.refreshState({
        composerDraft: "",
        clearLastError: true,
      });
    } catch (error) {
      this.transcriptCache.set(key, transcript.slice(0, -1));
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
      this.transcriptCache.clear();
      for (const [key, transcript] of Object.entries(persisted.transcripts ?? {})) {
        const clonedTranscript = transcript.map(cloneTranscriptMessage);
        this.transcriptCache.set(key, clonedTranscript);
        if (clonedTranscript.length > 0) {
          this.loadedTranscriptKeys.add(key);
        }
      }

      for (const workspacePath of this.initialWorkspacePaths) {
        if (!workspacePath.trim()) {
          continue;
        }
        await this.driver.syncWorkspace(workspacePath);
      }

      const knownWorkspaces = await this.driver.listWorkspaces();
      for (const workspace of knownWorkspaces.workspaces) {
        await this.driver.syncWorkspace(workspace.path, workspace.displayName);
      }

      await this.refreshState({
        selectedWorkspaceId: persisted.selectedWorkspaceId,
        selectedSessionId: persisted.selectedSessionId,
        composerDraft: persisted.composerDraft ?? "",
        clearLastError: true,
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

  private async refreshState(options: RefreshStateOptions = {}): Promise<DesktopAppState> {
    const [workspacesSnapshot, sessionsSnapshot] = await Promise.all([
      this.driver.listWorkspaces(),
      this.driver.listSessions(),
    ]);

    await this.pruneStaleSessionSubscriptions(sessionsSnapshot.sessions);

    let workspaces = buildWorkspaceRecords(
      workspacesSnapshot.workspaces,
      sessionsSnapshot.sessions,
      this.transcriptCache,
      this.runningSinceBySession,
    );
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
      await this.ensureSessionReady({
        workspaceId: selectedWorkspaceId,
        sessionId: selectedSessionId,
      });
      workspaces = buildWorkspaceRecords(
        workspacesSnapshot.workspaces,
        sessionsSnapshot.sessions,
        this.transcriptCache,
        this.runningSinceBySession,
      );
    }

    this.state = {
      ...this.state,
      workspaces,
      selectedWorkspaceId,
      selectedSessionId,
      composerDraft: options.composerDraft ?? this.state.composerDraft,
      lastError: options.clearLastError ? undefined : this.state.lastError,
      revision: this.state.revision + 1,
    };

    await this.persistUiState();
    return this.emit();
  }

  async syncCurrentWorkspace(): Promise<DesktopAppState> {
    await this.initialize();
    if (!this.state.selectedWorkspaceId) {
      return this.refreshState({ clearLastError: true });
    }

    return this.syncWorkspace(this.state.selectedWorkspaceId, {
      selectedWorkspaceId: this.state.selectedWorkspaceId,
      selectedSessionId: this.state.selectedSessionId,
      clearLastError: true,
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
        this.loadedTranscriptKeys.delete(key);
        this.transcriptCache.delete(key);
      }
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
    await this.ensureSessionSubscribed(sessionRef);
  }

  private async ensureTranscriptLoaded(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.loadedTranscriptKeys.has(key)) {
      return;
    }

    const transcript = await this.driver.getTranscript(sessionRef);
    this.loadedTranscriptKeys.add(key);
    this.transcriptCache.set(key, transcript.map(cloneTranscriptMessage));
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
      case "runFailed":
        this.state = {
          ...this.state,
          lastError: event.error.message,
        };
        break;
      case "runCompleted":
      case "sessionClosed":
      case "sessionOpened":
      case "sessionUpdated":
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

    applyTimelineEvent(this.transcriptCache, event, {
      runMetricsBySession: this.runMetricsBySession,
      runningSinceBySession: this.runningSinceBySession,
      activeAssistantMessageBySession: this.activeAssistantMessageBySession,
      activeWorkingActivityBySession: this.activeWorkingActivityBySession,
    });
    this.state = applySessionEventState(this.state, event, this.transcriptCache, this.runningSinceBySession);
    this.state = {
      ...this.state,
      lastError: event.type === "runFailed" ? event.error.message : this.state.lastError,
    };
    if (event.type === "runCompleted" || event.type === "runFailed" || event.type === "sessionClosed") {
      await this.persistUiState();
    } else {
      this.schedulePersistUiState();
    }
    this.emit();
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

  private selectedSessionRef(): SessionRef | undefined {
    if (!this.state.selectedWorkspaceId || !this.state.selectedSessionId) {
      return undefined;
    }

    return toSessionRef({
      workspaceId: this.state.selectedWorkspaceId,
      sessionId: this.state.selectedSessionId,
    });
  }

  private async readUiState(): Promise<PersistedUiState> {
    return readPersistedUiState(this.uiStateFilePath);
  }

  private async persistUiState(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    const payload: PersistedUiState = {
      selectedWorkspaceId: this.state.selectedWorkspaceId || undefined,
      selectedSessionId: this.state.selectedSessionId || undefined,
      composerDraft: this.state.composerDraft || undefined,
      transcripts: Object.fromEntries(
        [...this.transcriptCache.entries()].map(([key, transcript]) => [key, transcript.slice(-TRANSCRIPT_HISTORY_LIMIT)]),
      ),
    };

    await writePersistedUiState(this.uiStateFilePath, payload);
  }

  private schedulePersistUiState(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistUiState();
    }, 250);
  }

  private emit(): DesktopAppState {
    const snapshot = cloneDesktopAppState(this.state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async withError(error: unknown): Promise<DesktopAppState> {
    const message = error instanceof Error ? error.message : String(error);
    this.state = {
      ...this.state,
      lastError: message,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }
}
