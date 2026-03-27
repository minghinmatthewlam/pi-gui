import { access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ModelRegistry,
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ExtensionCommandContextActions,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type ExtensionWidgetOptions,
  type SessionInfo,
} from "@mariozechner/pi-coding-agent";
import type { SessionCatalogSnapshot, WorkspaceCatalogSnapshot } from "@pi-gui/catalogs";
import type {
  CreateSessionOptions,
  HostUiRequest,
  HostUiResponse,
  SessionConfig,
  SessionDriverEvent,
  SessionEventListener,
  SessionModelSelection,
  SessionMessageInput,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  Unsubscribe,
  WorkspaceId,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { RuntimeCommandRecord } from "@pi-gui/session-driver/runtime-types";
import { JsonCatalogStore, type SessionFileCatalogStorage } from "./json-catalog-store.js";
import {
  applyHostUiRequestToExtensionUiState,
  createEmptyExtensionUiState,
  type ExtensionUiState,
} from "./extension-ui-state.js";
import { normalizeRuntimeCommandName, skillCommandName } from "./runtime-command-utils.js";
import {
  buildSnapshot,
  createWorkspaceRef,
  deriveSessionConfig,
  deriveWorkspaceTitle,
  determineRunOutcome,
  extractPreview,
  forcePersistSession,
  nowIso,
  previewFromSessionInfo,
  sessionKey,
  titleFromSessionInfo,
  toSessionErrorInfo,
  transcriptFromMessages,
  truncate,
  workspaceToRef,
} from "./session-supervisor-utils.js";
import type { SessionTranscriptMessage } from "./transcript.js";

export interface PiSdkDriverOptions {
  readonly catalogFilePath?: string;
  readonly createAgentSessionImpl?: (options?: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
  readonly modelRegistry?: ModelRegistry;
}

export interface SyncWorkspaceResult {
  readonly workspace: WorkspaceRef;
  readonly sessions: SessionCatalogSnapshot["sessions"];
}

interface ManagedSessionRecord {
  ref: SessionRef;
  workspace: WorkspaceRef;
  title: string;
  session: AgentSession | undefined;
  sessionFile: string | undefined;
  status: SessionStatus;
  updatedAt: string;
  archivedAt: string | undefined;
  preview: string | undefined;
  config: SessionConfig | undefined;
  runningRunId: string | undefined;
  closed: boolean;
  listeners: Set<SessionEventListener>;
  eventQueue: Promise<void>;
  unsubscribeAgent: (() => void) | undefined;
  pendingHostUiRequests: Map<
    string,
    {
      resolve: (response: HostUiResponse) => void;
      reject: (error: Error) => void;
    }
  >;
  extensionUiState: ExtensionUiState;
  sessionCommands: RuntimeCommandRecord[];
}

interface RegisteredCommandAdapter {
  readonly name: string;
  readonly invocationName?: string;
  readonly description?: string;
  readonly sourceInfo?: RuntimeCommandRecord["sourceInfo"];
  readonly extensionPath?: string;
}

interface PromptTemplateAdapter {
  readonly name: string;
  readonly description?: string;
  readonly sourceInfo?: RuntimeCommandRecord["sourceInfo"];
  readonly filePath?: string;
}

interface SkillAdapter {
  readonly name: string;
  readonly description: string;
  readonly sourceInfo?: RuntimeCommandRecord["sourceInfo"];
  readonly filePath?: string;
  readonly source?: string;
}

export class SessionSupervisor {
  private readonly catalogs: SessionFileCatalogStorage;
  private readonly createAgentSessionImpl: (options?: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
  private readonly modelRegistry: ModelRegistry | undefined;
  private readonly records = new Map<string, ManagedSessionRecord>();

  constructor(options: PiSdkDriverOptions = {}) {
    this.catalogs = options.catalogFilePath
      ? new JsonCatalogStore({ catalogFilePath: options.catalogFilePath })
      : new JsonCatalogStore();
    this.createAgentSessionImpl = options.createAgentSessionImpl ?? ((createOptions) => createAgentSession(createOptions));
    this.modelRegistry = options.modelRegistry;
  }

  listWorkspaces(): Promise<WorkspaceCatalogSnapshot> {
    return this.catalogs.workspaces.listWorkspaces();
  }

  listSessions(workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot> {
    return this.catalogs.sessions.listSessions(workspaceId);
  }

  async registerWorkspace(path: string, displayName?: string): Promise<WorkspaceRef> {
    const workspace = await createCanonicalWorkspaceRef(path, displayName);
    await this.touchWorkspace(workspace);
    return workspace;
  }

  async syncWorkspace(path: string, displayName?: string): Promise<SyncWorkspaceResult> {
    const workspace = await this.registerWorkspace(path, displayName);
    const infos = await SessionManager.list(path);
    const existingSessions = (await this.catalogs.sessions.listSessions(workspace.workspaceId)).sessions;
    const existingByKey = new Map(existingSessions.map((session) => [sessionKey(session.sessionRef), session]));
    const nextEntries = infos.map((info) =>
      this.sessionEntryFromInfo(
        workspace,
        info,
        this.records.get(sessionKey({ workspaceId: workspace.workspaceId, sessionId: info.id })),
        existingByKey.get(sessionKey({ workspaceId: workspace.workspaceId, sessionId: info.id })),
      ),
    );
    const discoveredKeys = new Set(nextEntries.map((entry) => sessionKey(entry.sessionRef)));
    const preservedEntries = (
      await Promise.all(
        existingSessions.map(async (session) => {
          const key = sessionKey(session.sessionRef);
          if (discoveredKeys.has(key) || !session.sessionFilePath) {
            return undefined;
          }

          try {
            await access(session.sessionFilePath);
            return session;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((session): session is (typeof existingSessions)[number] => Boolean(session));
    const preservedKeys = new Set(preservedEntries.map((entry) => sessionKey(entry.sessionRef)));
    const mergedEntries = [...nextEntries, ...preservedEntries];
    const nextSessionFiles = Object.fromEntries([
      ...nextEntries.map((entry, index) => [sessionKey(entry.sessionRef), infos[index]?.path ?? ""]),
      ...preservedEntries.map((entry) => [sessionKey(entry.sessionRef), entry.sessionFilePath ?? ""]),
    ]);

    await this.catalogs.replaceWorkspaceSessions(workspace.workspaceId, mergedEntries, nextSessionFiles);
    for (const session of existingSessions) {
      const key = sessionKey(session.sessionRef);
      if (discoveredKeys.has(key) || preservedKeys.has(key)) {
        continue;
      }

      await this.catalogs.sessions.deleteSession(session.sessionRef);
      const record = this.records.get(key);
      if (!record) {
        continue;
      }

      record.unsubscribeAgent?.();
      record.unsubscribeAgent = undefined;
      record.listeners.clear();
      record.session?.dispose();
      this.records.delete(key);
    }

    return {
      workspace,
      sessions: (await this.catalogs.sessions.listSessions(workspace.workspaceId)).sessions,
    };
  }

  async renameWorkspace(workspaceId: WorkspaceId, displayName: string): Promise<void> {
    const existing = await this.catalogs.workspaces.getWorkspace(workspaceId);
    if (!existing) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }

    const nextWorkspace = await createCanonicalWorkspaceRef(existing.path, displayName.trim() || undefined);
    await this.touchWorkspace(nextWorkspace);

    for (const record of this.records.values()) {
      if (record.workspace.workspaceId === workspaceId) {
        record.workspace = nextWorkspace;
      }
    }
  }

  async removeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const sessions = (await this.catalogs.sessions.listSessions(workspaceId)).sessions;
    await this.catalogs.workspaces.deleteWorkspace(workspaceId);

    for (const session of sessions) {
      const key = sessionKey(session.sessionRef);
      const record = this.records.get(key);
      if (!record) {
        continue;
      }

      record.unsubscribeAgent?.();
      record.unsubscribeAgent = undefined;
      record.listeners.clear();
      record.session?.dispose();
      this.records.delete(key);
    }
  }

  async getTranscript(sessionRef: SessionRef): Promise<SessionTranscriptMessage[]> {
    const record = await this.ensureRecord(sessionRef);
    return transcriptFromMessages(record.session?.messages ?? [], record.updatedAt);
  }

  async getSessionCommands(sessionRef: SessionRef): Promise<readonly RuntimeCommandRecord[]> {
    const record = await this.ensureRecord(sessionRef);
    return record.sessionCommands;
  }

  async respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const pending = record.pendingHostUiRequests.get(response.requestId);
    if (!pending) {
      return;
    }

    record.pendingHostUiRequests.delete(response.requestId);
    pending.resolve(response);
  }

  async createSession(workspace: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot> {
    await this.touchWorkspace(workspace);

    const { session } = await this.createAgentSessionImpl({
      cwd: workspace.path,
      sessionManager: SessionManager.create(workspace.path),
      ...(this.modelRegistry ? { modelRegistry: this.modelRegistry } : {}),
    });

    const record = this.createRecord(workspace, session, options?.title ?? deriveWorkspaceTitle(workspace));
    session.sessionManager.appendSessionInfo(record.title);
    forcePersistSession(session.sessionManager);
    record.config = deriveSessionConfig(session.sessionManager);
    const sessionFile = record.sessionFile ?? session.sessionManager.getSessionFile();
    if (sessionFile) {
      record.sessionFile = sessionFile;
      await this.catalogs.setSessionFile(record.ref, sessionFile);
    }

    this.records.set(sessionKey(record.ref), record);
    await this.bindSessionRuntime(record);
    await this.persistSnapshot(record);
    const snapshot = buildSnapshot(record);
    await this.emit(record, {
      type: "sessionOpened",
      sessionRef: record.ref,
      timestamp: nowIso(),
      snapshot,
    });
    return snapshot;
  }

  async openSession(sessionRef: SessionRef): Promise<SessionSnapshot> {
    const record = await this.ensureRecord(sessionRef);
    await this.touchWorkspace(record.workspace);
    const snapshot = buildSnapshot(record);
    await this.emit(record, {
      type: "sessionOpened",
      sessionRef: record.ref,
      timestamp: nowIso(),
      snapshot,
    });
    return snapshot;
  }

  async archiveSession(sessionRef: SessionRef): Promise<void> {
    await this.updateArchivedState(sessionRef, nowIso());
  }

  async unarchiveSession(sessionRef: SessionRef): Promise<void> {
    await this.updateArchivedState(sessionRef, undefined);
  }

  async sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const session = this.requireSession(record);
    const isExtensionCommand = this.isExtensionCommand(session, input.text);
    if (session.isStreaming && !isExtensionCommand) {
      throw new Error("Session is already streaming. TODO: expose steer/follow-up queueing on the driver API.");
    }

    const runId = isExtensionCommand ? undefined : crypto.randomUUID();
    record.runningRunId = runId;
    record.status = isExtensionCommand ? record.status : "running";
    record.updatedAt = nowIso();
    record.config = deriveSessionConfig(session.sessionManager);
    record.preview = truncate(input.text);
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));

    try {
      const images = input.attachments?.map((attachment) => ({
        type: "image" as const,
        data: attachment.data,
        mimeType: attachment.mimeType,
      }));
      await session.prompt(input.text, {
        ...(images && images.length > 0 ? { images } : {}),
        source: "interactive",
      });

      if (isExtensionCommand) {
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
      }
    } catch (error) {
      record.runningRunId = undefined;
      record.status = isExtensionCommand ? "idle" : "failed";
      record.updatedAt = nowIso();
      record.preview = error instanceof Error ? error.message : String(error);
      await this.persistSnapshot(record);
      await this.emit(record, {
        type: "runFailed",
        sessionRef: record.ref,
        timestamp: nowIso(),
        error: toSessionErrorInfo(error, "SEND_FAILED"),
        ...(runId ? { runId } : {}),
      });
      await this.emit(record, sessionUpdatedEvent(record));
      throw error;
    }
  }

  async cancelCurrentRun(sessionRef: SessionRef): Promise<void> {
    const record = this.records.get(sessionKey(sessionRef));
    if (!record?.session) {
      return;
    }

    await record.session.abort();
    record.runningRunId = undefined;
    record.status = "idle";
    record.updatedAt = nowIso();
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));
  }

  async setSessionModel(sessionRef: SessionRef, selection: SessionModelSelection): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const session = record.session;
    if (!session) {
      throw new Error(`Session ${sessionKey(record.ref)} is not active.`);
    }

    await session.setModel(this.resolveModel(selection.provider, selection.modelId));
    record.config = deriveSessionConfig(session.sessionManager);
    record.updatedAt = nowIso();
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));
  }

  async setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const sessionManager = this.getWritableSessionManager(record);
    sessionManager.appendThinkingLevelChange(thinkingLevel);
    forcePersistSession(sessionManager);
    record.config = deriveSessionConfig(sessionManager);
    record.updatedAt = nowIso();
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));
  }

  async renameSession(sessionRef: SessionRef, title: string): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Session title cannot be empty.");
    }

    const sessionManager = this.getWritableSessionManager(record);
    sessionManager.appendSessionInfo(nextTitle);
    forcePersistSession(sessionManager);
    record.title = nextTitle;
    record.updatedAt = nowIso();
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));
  }

  async compactSession(sessionRef: SessionRef, customInstructions?: string): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    if (!record.session) {
      throw new Error(`Session ${sessionKey(sessionRef)} is not active.`);
    }

    await record.session.compact(customInstructions);
    record.runningRunId = undefined;
    record.status = "idle";
    record.updatedAt = nowIso();
    record.config = deriveSessionConfig(record.session.sessionManager);
    record.preview = extractPreview(record.session.messages) ?? record.preview;
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));
  }

  async reloadSession(sessionRef: SessionRef): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const session = this.requireSession(record);

    this.resetExtensionUi(record);
    await session.reload();
    await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
  }

  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
    const record = this.records.get(sessionKey(sessionRef));
    if (!record) {
      throw new Error(`Unknown session ${sessionKey(sessionRef)}.`);
    }

    record.listeners.add(listener);
    void Promise.resolve(listener(sessionUpdatedEvent(record))).catch(() => {});
    this.replayExtensionUiState(record, listener);

    return () => {
      record.listeners.delete(listener);
    };
  }

  async closeSession(sessionRef: SessionRef): Promise<void> {
    const record = this.records.get(sessionKey(sessionRef));
    if (!record) {
      return;
    }

    record.closed = true;
    record.runningRunId = undefined;
    record.status = "idle";
    record.updatedAt = nowIso();
    this.clearExtensionUiState(record);
    this.cancelPendingHostUiRequests(record);

    if (record.session) {
      try {
        await record.session.abort();
      } catch {
        // Best effort.
      }
      record.unsubscribeAgent?.();
      record.unsubscribeAgent = undefined;
      record.session.dispose();
      record.session = undefined;
    }

    await this.persistSnapshot(record);
    await this.emit(record, {
      type: "sessionClosed",
      sessionRef: record.ref,
      timestamp: nowIso(),
      reason: "manual",
    });
  }

  private async ensureRecord(sessionRef: SessionRef): Promise<ManagedSessionRecord> {
    const key = sessionKey(sessionRef);
    const existing = this.records.get(key);
    if (existing && existing.session && !existing.closed) {
      return existing;
    }

    const sessionEntry = await this.catalogs.sessions.getSession(sessionRef);
    if (!sessionEntry) {
      throw new Error(`Session ${key} is not in the catalog.`);
    }

    const workspace = await this.catalogs.workspaces.getWorkspace(sessionEntry.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${sessionEntry.workspaceId} is not in the catalog.`);
    }
    await this.touchWorkspace(workspaceToRef(workspace));

    const sessionFile = existing?.sessionFile ?? sessionEntry.sessionFilePath ?? (await this.catalogs.getSessionFile(sessionRef));
    if (!sessionFile) {
      throw new Error(`Session ${key} cannot be reopened because no session file is tracked.`);
    }

    const { session } = await this.createAgentSessionImpl({
      cwd: workspace.path,
      sessionManager: SessionManager.open(sessionFile),
      ...(this.modelRegistry ? { modelRegistry: this.modelRegistry } : {}),
    });

    const record = existing ?? this.createRecord(workspaceToRef(workspace), session, sessionEntry.title);
    record.session = session;
    record.sessionFile = sessionFile;
    record.title = sessionEntry.title;
    record.status = sessionEntry.status;
    record.updatedAt = sessionEntry.updatedAt;
    record.archivedAt = sessionEntry.archivedAt;
    record.preview = sessionEntry.previewSnippet ?? undefined;
    record.config = deriveSessionConfig(session.sessionManager);
    record.closed = false;

    record.unsubscribeAgent?.();
    record.unsubscribeAgent = session.subscribe((event) => {
      void this.handleAgentEvent(record, event);
    });

    this.records.set(key, record);
    await this.bindSessionRuntime(record);
    return record;
  }

  private createRecord(workspace: WorkspaceRef, session: AgentSession, title: string): ManagedSessionRecord {
    const ref = {
      workspaceId: workspace.workspaceId,
      sessionId: session.sessionId,
    };

    const record: ManagedSessionRecord = {
      ref,
      workspace: { ...workspace },
      title,
      session,
      sessionFile: session.sessionFile ?? session.sessionManager.getSessionFile(),
      status: "idle",
      updatedAt: nowIso(),
      archivedAt: undefined,
      preview: undefined,
      config: deriveSessionConfig(session.sessionManager),
      runningRunId: undefined,
      closed: false,
      listeners: new Set<SessionEventListener>(),
      eventQueue: Promise.resolve(),
      unsubscribeAgent: undefined,
      pendingHostUiRequests: new Map(),
      extensionUiState: createEmptyExtensionUiState(),
      sessionCommands: [],
    };

    record.unsubscribeAgent = session.subscribe((event) => {
      void this.handleAgentEvent(record, event);
    });
    return record;
  }

  private getWritableSessionManager(record: ManagedSessionRecord): SessionManager {
    const sessionManager = record.session?.sessionManager;
    if (!sessionManager) {
      throw new Error(`Session ${sessionKey(record.ref)} is not active.`);
    }
    return sessionManager;
  }

  private requireSession(record: ManagedSessionRecord): AgentSession {
    if (!record.session) {
      throw new Error(`Session ${sessionKey(record.ref)} is not active.`);
    }
    return record.session;
  }

  private async bindSessionRuntime(record: ManagedSessionRecord): Promise<void> {
    const session = this.requireSession(record);
    await session.bindExtensions({
      uiContext: this.createExtensionUiContext(record),
      commandContextActions: this.createCommandContextActions(record),
      onError: (error) => {
        void this.emitExtensionError(record, error.extensionPath, error.event, error.error);
      },
    });
    record.sessionCommands = this.collectSessionCommands(session);
  }

  private createCommandContextActions(record: ManagedSessionRecord): ExtensionCommandContextActions {
    return {
      waitForIdle: () => this.requireSession(record).agent.waitForIdle(),
      newSession: async (options) => {
        const cancelled = !(await this.requireSession(record).newSession(options));
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
        return { cancelled };
      },
      fork: async (entryId) => {
        const result = await this.requireSession(record).fork(entryId);
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const result = await this.requireSession(record).navigateTree(targetId, options);
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath) => {
        const cancelled = !(await this.requireSession(record).switchSession(sessionPath));
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
        return { cancelled };
      },
      reload: async () => {
        this.resetExtensionUi(record);
        await this.requireSession(record).reload();
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
      },
    };
  }

  private createExtensionUiContext(record: ManagedSessionRecord): ExtensionUIContext {
    const noOpTheme = extensionUiThemeStub;

    const createDialogPromise = <T>(
      opts: ExtensionUIDialogOptions | undefined,
      defaultValue: T,
      createRequest: (requestId: string) => HostUiRequest,
      parseResponse: (response: HostUiResponse) => T,
    ): Promise<T> => {
      if (opts?.signal?.aborted) {
        return Promise.resolve(defaultValue);
      }

      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          opts?.signal?.removeEventListener("abort", onAbort);
          record.pendingHostUiRequests.delete(requestId);
        };

        const onAbort = () => {
          cleanup();
          resolve(defaultValue);
        };

        opts?.signal?.addEventListener("abort", onAbort, { once: true });

        if (opts?.timeout) {
          timeoutId = setTimeout(() => {
            cleanup();
            resolve(defaultValue);
          }, opts.timeout);
        }

        record.pendingHostUiRequests.set(requestId, {
          resolve: (response) => {
            cleanup();
            resolve(parseResponse(response));
          },
          reject,
        });

        this.emitHostUiRequest(record, createRequest(requestId));
      });
    };

    return {
      select: (title, options, opts) =>
        createDialogPromise(
          opts,
          undefined,
          (requestId) => ({
            kind: "select",
            requestId,
            title,
            options,
            ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
          }),
          (response) => ("cancelled" in response && response.cancelled ? undefined : "value" in response ? response.value : undefined),
        ),
      confirm: (title, message, opts) =>
        createDialogPromise(
          opts,
          false,
          (requestId) => ({
            kind: "confirm",
            requestId,
            title,
            message,
            ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
          }),
          (response) =>
            "cancelled" in response && response.cancelled ? false : "confirmed" in response ? response.confirmed : false,
        ),
      input: (title, placeholder, opts) =>
        createDialogPromise(
          opts,
          undefined,
          (requestId) => ({
            kind: "input",
            requestId,
            title,
            ...(placeholder ? { placeholder } : {}),
            ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
          }),
          (response) => ("cancelled" in response && response.cancelled ? undefined : "value" in response ? response.value : undefined),
        ),
      notify: (message, level) => {
        this.emitHostUiRequest(record, {
          kind: "notify",
          requestId: crypto.randomUUID(),
          message,
          ...(level ? { level } : {}),
        });
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        this.emitHostUiRequest(record, {
          kind: "status",
          requestId: crypto.randomUUID(),
          key,
          ...(text ? { text } : {}),
        });
      },
      setWorkingMessage: () => {},
      setWidget: (key, content: unknown, options?: ExtensionWidgetOptions) => {
        if (content === undefined || Array.isArray(content)) {
          const lines = content as readonly string[] | undefined;
          this.emitHostUiRequest(record, {
            kind: "widget",
            requestId: crypto.randomUUID(),
            key,
            ...(lines ? { lines } : {}),
            placement: options?.placement === "belowEditor" ? "belowComposer" : "aboveComposer",
          });
        }
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emitHostUiRequest(record, {
          kind: "title",
          requestId: crypto.randomUUID(),
          title,
        });
      },
      custom: async () => undefined as never,
      pasteToEditor: (text) => {
        this.emitHostUiRequest(record, {
          kind: "editorText",
          requestId: crypto.randomUUID(),
          text,
        });
      },
      setEditorText: (text) => {
        this.emitHostUiRequest(record, {
          kind: "editorText",
          requestId: crypto.randomUUID(),
          text,
        });
      },
      getEditorText: () => record.extensionUiState.editorText ?? "",
      editor: (title, initialValue) =>
        createDialogPromise(
          undefined,
          undefined,
          (requestId) => ({
            kind: "editor",
            requestId,
            title,
            ...(initialValue ? { initialValue } : {}),
          }),
          (response) => ("cancelled" in response && response.cancelled ? undefined : "value" in response ? response.value : undefined),
        ),
      setEditorComponent: () => {},
      get theme() {
        return noOpTheme;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching not supported in pi-gui host UI" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private isExtensionCommand(session: AgentSession, text: string): boolean {
    if (!text.trimStart().startsWith("/")) {
      return false;
    }
    const trimmed = text.trimStart();
    const spaceIndex = trimmed.indexOf(" ");
    const commandName = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
    return Boolean(session.extensionRunner?.getCommand(commandName));
  }

  private resolveModel(provider: string, modelId: string) {
    const model = this.modelRegistry?.find(provider, modelId);
    if (!model) {
      throw new Error(`Unknown model ${provider}:${modelId}`);
    }
    return model;
  }

  private emitHostUiRequest(
    record: ManagedSessionRecord,
    request: Extract<SessionDriverEvent, { type: "hostUiRequest" }>["request"],
  ): void {
    this.applyExtensionUiRequest(record, request);
    this.queueDriverEvents(record, [
      {
        type: "hostUiRequest",
        sessionRef: record.ref,
        timestamp: nowIso(),
        request,
      },
    ], { persistSnapshot: false });
  }

  private async emitExtensionError(
    record: ManagedSessionRecord,
    extensionPath: string,
    eventName: string,
    error: string,
  ): Promise<void> {
    this.emitHostUiRequest(record, {
      kind: "notify",
      requestId: crypto.randomUUID(),
      level: "error",
      message: `[${extensionPath}] ${eventName}: ${error}`,
    });
  }

  private applyExtensionUiRequest(
    record: ManagedSessionRecord,
    request: Extract<SessionDriverEvent, { type: "hostUiRequest" }>["request"],
  ): void {
    applyHostUiRequestToExtensionUiState(record.extensionUiState, request);
  }

  private clearExtensionUiState(record: ManagedSessionRecord): void {
    record.extensionUiState.statuses.clear();
    record.extensionUiState.widgets.clear();
    record.extensionUiState.title = undefined;
    record.extensionUiState.editorText = undefined;
  }

  private resetExtensionUi(record: ManagedSessionRecord): void {
    this.emitHostUiRequest(record, {
      kind: "reset",
      requestId: crypto.randomUUID(),
    });
    this.clearExtensionUiState(record);
    this.cancelPendingHostUiRequests(record);
  }

  private cancelPendingHostUiRequests(record: ManagedSessionRecord): void {
    for (const [requestId, pending] of [...record.pendingHostUiRequests.entries()]) {
      record.pendingHostUiRequests.delete(requestId);
      pending.resolve({ requestId, cancelled: true });
    }
  }

  private replayExtensionUiState(record: ManagedSessionRecord, listener: SessionEventListener): void {
    const timestamp = nowIso();

    for (const [key, text] of record.extensionUiState.statuses) {
      void Promise.resolve(
        listener({
          type: "hostUiRequest",
          sessionRef: record.ref,
          timestamp,
          request: {
            kind: "status",
            requestId: `replay:status:${key}`,
            key,
            text,
          },
        }),
      ).catch(() => {});
    }

    for (const widget of record.extensionUiState.widgets.values()) {
      void Promise.resolve(
        listener({
          type: "hostUiRequest",
          sessionRef: record.ref,
          timestamp,
          request: {
            kind: "widget",
            requestId: `replay:widget:${widget.key}`,
            key: widget.key,
            ...(widget.lines ? { lines: widget.lines } : {}),
            placement: widget.placement,
          },
        }),
      ).catch(() => {});
    }

    if (record.extensionUiState.title) {
      void Promise.resolve(
        listener({
          type: "hostUiRequest",
          sessionRef: record.ref,
          timestamp,
          request: {
            kind: "title",
            requestId: "replay:title",
            title: record.extensionUiState.title,
          },
        }),
      ).catch(() => {});
    }

    if (record.extensionUiState.editorText) {
      void Promise.resolve(
        listener({
          type: "hostUiRequest",
          sessionRef: record.ref,
          timestamp,
          request: {
            kind: "editorText",
            requestId: "replay:editorText",
            text: record.extensionUiState.editorText,
          },
        }),
      ).catch(() => {});
    }
  }

  private async syncRecordAfterSessionMutation(
    record: ManagedSessionRecord,
    options: { emitUpdate?: boolean } = {},
  ): Promise<void> {
    const session = this.requireSession(record);
    const previousKey = sessionKey(record.ref);
    const nextRef = {
      workspaceId: record.workspace.workspaceId,
      sessionId: session.sessionId,
    } satisfies SessionRef;
    const nextKey = sessionKey(nextRef);

    if (previousKey !== nextKey) {
      this.records.delete(previousKey);
      record.ref = nextRef;
      this.records.set(nextKey, record);
    }

    record.sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    record.title = session.sessionName?.trim() || record.title || deriveWorkspaceTitle(record.workspace);
    record.updatedAt = nowIso();
    record.status = session.isStreaming ? "running" : "idle";
    record.runningRunId = session.isStreaming ? record.runningRunId ?? crypto.randomUUID() : undefined;
    record.config = deriveSessionConfig(session.sessionManager);
    record.preview =
      session.messages.length > 0 ? extractPreview(session.messages[session.messages.length - 1]) : undefined;
    record.sessionCommands = this.collectSessionCommands(session);
    await this.persistSnapshot(record);
    if (options.emitUpdate) {
      await this.emit(record, sessionUpdatedEvent(record));
    }
  }

  private queueDriverEvents(
    record: ManagedSessionRecord,
    events: readonly SessionDriverEvent[],
    options?: {
      readonly persistSnapshot?: boolean;
    },
  ): void {
    if (events.length === 0) {
      return;
    }

    record.eventQueue = record.eventQueue.then(async () => {
      if (options?.persistSnapshot !== false) {
        await this.persistSnapshot(record);
      }
      for (const event of events) {
        await this.emit(record, event);
      }
    });
    record.eventQueue.catch(() => {});
  }

  private async handleAgentEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
    const mapped = this.mapAgentEvent(record, event);
    if (mapped.length === 0) {
      return;
    }

    this.queueDriverEvents(record, mapped);
  }

  private mapAgentEvent(record: ManagedSessionRecord, event: AgentSessionEvent): SessionDriverEvent[] {
    const timestamp = nowIso();

    switch (event.type) {
      case "agent_start":
      case "turn_start":
        record.status = "running";
        record.updatedAt = timestamp;
        return [sessionUpdatedEvent(record)];
      case "message_start":
      case "message_end":
        this.updatePreviewFromMessage(record, event.message);
        record.updatedAt = timestamp;
        return [sessionUpdatedEvent(record)];
      case "message_update":
        this.updatePreviewFromMessage(record, event.message);
        record.updatedAt = timestamp;
        if (event.message.role === "assistant" && event.assistantMessageEvent.type === "text_delta") {
          return toDriverEvents({
            type: "assistantDelta" as const,
            sessionRef: record.ref,
            timestamp,
            text: event.assistantMessageEvent.delta ?? "",
          }, record);
        }
        return [sessionUpdatedEvent(record)];
      case "tool_execution_start":
        record.status = "running";
        record.updatedAt = timestamp;
        return toDriverEvents({
          type: "toolStarted" as const,
          sessionRef: record.ref,
          timestamp,
          toolName: event.toolName,
          callId: event.toolCallId,
          input: event.args,
        }, record);
      case "tool_execution_update":
        record.updatedAt = timestamp;
        return toDriverEvents({
          type: "toolUpdated" as const,
          sessionRef: record.ref,
          timestamp,
          callId: event.toolCallId,
          ...(typeof event.partialResult === "string" ? { text: event.partialResult } : {}),
          ...(typeof event.partialResult === "number" ? { progress: event.partialResult } : {}),
        }, record);
      case "tool_execution_end":
        record.updatedAt = timestamp;
        return toDriverEvents({
          type: "toolFinished" as const,
          sessionRef: record.ref,
          timestamp,
          callId: event.toolCallId,
          success: !event.isError,
          output: event.result,
        }, record);
      case "turn_end":
        record.updatedAt = timestamp;
        return [sessionUpdatedEvent(record)];
      case "agent_end": {
        const outcome = determineRunOutcome(event.messages);
        const runId = record.runningRunId;
        record.runningRunId = undefined;
        record.status = outcome.success ? "idle" : "failed";
        record.updatedAt = timestamp;
        if (!outcome.success && outcome.error) {
          record.preview = outcome.error.message;
        }
        if (record.session) {
          record.sessionCommands = this.collectSessionCommands(record.session);
        }

        return toDriverEvents(
          outcome.success
            ? {
                type: "runCompleted" as const,
                sessionRef: record.ref,
                timestamp,
                snapshot: buildSnapshot(record),
              }
            : {
                type: "runFailed" as const,
                sessionRef: record.ref,
                timestamp,
                error: outcome.error ?? toSessionErrorInfo(undefined, "RUN_FAILED"),
              },
          record,
          runId,
        );
      }
      default:
        return [];
    }
  }

  private updatePreviewFromMessage(record: ManagedSessionRecord, message: unknown): void {
    const preview = extractPreview(message);
    if (preview) {
      record.preview = preview;
    }
  }

  private async emit(record: ManagedSessionRecord, event: SessionDriverEvent): Promise<void> {
    for (const listener of [...record.listeners]) {
      await listener(event);
    }
  }

  private async persistSnapshot(record: ManagedSessionRecord): Promise<void> {
    const snapshot = buildSnapshot(record);
    await this.catalogs.sessions.upsertSession({
      sessionRef: snapshot.ref,
      workspaceId: snapshot.ref.workspaceId,
      title: snapshot.title,
      updatedAt: snapshot.updatedAt,
      status: snapshot.status,
      ...(snapshot.archivedAt !== undefined ? { archivedAt: snapshot.archivedAt } : {}),
      ...(snapshot.preview !== undefined ? { previewSnippet: snapshot.preview } : {}),
      ...(record.sessionFile ? { sessionFilePath: record.sessionFile } : {}),
    });
    if (record.sessionFile) {
      await this.catalogs.setSessionFile(record.ref, record.sessionFile);
    }
  }

  private collectSessionCommands(session: AgentSession): RuntimeCommandRecord[] {
    const commands: RuntimeCommandRecord[] = [];

    for (const command of getRegisteredCommands(session)) {
      commands.push({
        name: normalizeRuntimeCommandName(command.invocationName ?? command.name),
        ...(command.description ? { description: command.description } : {}),
        source: "extension",
        sourceInfo: runtimeSourceInfoFromLoose(command.sourceInfo, {
          path: command.extensionPath ?? `<extension:${command.name}>`,
          source: "extension",
        }),
      });
    }

    for (const template of getPromptTemplates(session)) {
      commands.push({
        name: normalizeRuntimeCommandName(template.name),
        ...(template.description ? { description: template.description } : {}),
        source: "prompt",
        sourceInfo: runtimeSourceInfoFromLoose(template.sourceInfo, {
          path: template.filePath ?? `<prompt:${template.name}>`,
          source: "prompt",
        }),
      });
    }

    for (const skill of getSkills(session)) {
      commands.push({
        name: skillCommandName(skill.name),
        description: skill.description,
        source: "skill",
        sourceInfo: runtimeSourceInfoFromLoose(skill.sourceInfo, {
          path: skill.filePath ?? `<skill:${skill.name}>`,
          source: skill.source ?? "skill",
        }),
      });
    }

    return commands;
  }

  private async deriveWorkspaceSortOrder(workspaceId: string): Promise<number> {
    const current = await this.catalogs.workspaces.getWorkspace(workspaceId);
    if (current) {
      return current.sortOrder;
    }
    const listing = await this.catalogs.workspaces.listWorkspaces();
    return listing.workspaces.length;
  }

  private async touchWorkspace(workspace: WorkspaceRef): Promise<void> {
    await this.catalogs.workspaces.upsertWorkspace({
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      displayName: workspace.displayName ?? deriveWorkspaceTitle(workspace),
      lastOpenedAt: nowIso(),
      sortOrder: await this.deriveWorkspaceSortOrder(workspace.workspaceId),
      pinned: false,
    });
  }

  private sessionEntryFromInfo(
    workspace: WorkspaceRef,
    info: SessionInfo,
    runtimeRecord?: ManagedSessionRecord,
    existingEntry?: SessionCatalogSnapshot["sessions"][number],
  ): SessionCatalogSnapshot["sessions"][number] {
    const runtimeSnapshot =
      runtimeRecord && runtimeRecord.session && !runtimeRecord.closed ? buildSnapshot(runtimeRecord) : undefined;
    const previewSnippet = runtimeSnapshot?.preview ?? previewFromSessionInfo(info);
    const archivedAt = runtimeSnapshot?.archivedAt ?? existingEntry?.archivedAt;
    const entry: SessionCatalogSnapshot["sessions"][number] = {
      sessionRef: {
        workspaceId: workspace.workspaceId,
        sessionId: info.id,
      },
      workspaceId: workspace.workspaceId,
      title: runtimeSnapshot?.title ?? existingEntry?.title ?? titleFromSessionInfo(info),
      updatedAt: runtimeSnapshot?.updatedAt ?? info.modified.toISOString(),
      status: runtimeSnapshot?.status ?? "idle",
      sessionFilePath: info.path,
    };
    if (archivedAt) {
      entry.archivedAt = archivedAt;
    }
    if (previewSnippet !== undefined) {
      entry.previewSnippet = previewSnippet;
    }
    return entry;
  }

  private async updateArchivedState(sessionRef: SessionRef, archivedAt: string | undefined): Promise<void> {
    const key = sessionKey(sessionRef);
    const record = this.records.get(key);
    if (record) {
      if (record.archivedAt === archivedAt) {
        return;
      }
      record.archivedAt = archivedAt;
      await this.persistSnapshot(record);
      await this.emit(record, sessionUpdatedEvent(record));
      return;
    }

    const sessionEntry = await this.catalogs.sessions.getSession(sessionRef);
    if (!sessionEntry) {
      throw new Error(`Session ${key} is not in the catalog.`);
    }
    if (sessionEntry.archivedAt === archivedAt) {
      return;
    }

    const nextEntry =
      archivedAt !== undefined
        ? { ...sessionEntry, archivedAt }
        : {
            sessionRef: sessionEntry.sessionRef,
            workspaceId: sessionEntry.workspaceId,
            title: sessionEntry.title,
            updatedAt: sessionEntry.updatedAt,
            ...(sessionEntry.previewSnippet !== undefined ? { previewSnippet: sessionEntry.previewSnippet } : {}),
            ...(sessionEntry.sessionFilePath !== undefined ? { sessionFilePath: sessionEntry.sessionFilePath } : {}),
            status: sessionEntry.status,
          };

    await this.catalogs.sessions.upsertSession(nextEntry);
  }
}

async function createCanonicalWorkspaceRef(path: string, displayName?: string): Promise<WorkspaceRef> {
  const canonicalPath = await canonicalizePath(path);
  return createWorkspaceRef(canonicalPath, displayName);
}

async function canonicalizePath(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  try {
    return await realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function runtimeSourceInfoFromLoose(
  sourceInfo: RuntimeCommandRecord["sourceInfo"] | undefined,
  fallback: { path: string; source: string },
): RuntimeCommandRecord["sourceInfo"] {
  if (sourceInfo) {
    return sourceInfo;
  }

  return {
    path: fallback.path,
    source: fallback.source,
    scope: "temporary",
    origin: "top-level",
  };
}

function getRegisteredCommands(session: AgentSession): readonly RegisteredCommandAdapter[] {
  return (session.extensionRunner?.getRegisteredCommands() ?? []) as readonly RegisteredCommandAdapter[];
}

function getPromptTemplates(session: AgentSession): readonly PromptTemplateAdapter[] {
  return session.promptTemplates as readonly PromptTemplateAdapter[];
}

function getSkills(session: AgentSession): readonly SkillAdapter[] {
  return session.resourceLoader.getSkills().skills as readonly SkillAdapter[];
}

const extensionUiThemeStub = new Proxy(
  {},
  {
    get: () => (...args: unknown[]) => {
      const last = args.at(-1);
      return typeof last === "string" ? last : "";
    },
  },
) as ExtensionUIContext["theme"];

function sessionUpdatedEvent(record: ManagedSessionRecord): SessionDriverEvent {
  return {
    type: "sessionUpdated",
    sessionRef: record.ref,
    timestamp: record.updatedAt,
    snapshot: buildSnapshot(record),
  };
}

function toDriverEvents(
  base: SessionDriverEvent,
  record: ManagedSessionRecord,
  runId?: string,
): SessionDriverEvent[] {
  const id = runId ?? record.runningRunId;
  const event = id ? { ...base, runId: id } : base;
  return [event, sessionUpdatedEvent(record)];
}
