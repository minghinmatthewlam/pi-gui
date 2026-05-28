import { access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ModelRegistry,
  SessionManager,
  type AgentSessionRuntime,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ExtensionCommandContextActions,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type ExtensionWidgetOptions,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { SessionCatalogSnapshot, WorkspaceCatalogSnapshot } from "@pi-gui/catalogs";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionMessageDeliveryMode,
  SessionMessageInput,
  SessionQueuedMessage,
  SessionTreeNodeSnapshot,
  SessionTreeSnapshot,
  CreateSessionOptions,
  HostUiRequest,
  HostUiResponse,
  SessionConfig,
  SessionEventListener,
  SessionModelSelection,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  Unsubscribe,
  WorkspaceId,
  WorkspaceRef,
} from "@pi-gui/session-driver/types";
import type { SessionDriverEvent } from "@pi-gui/session-driver/types";
import type { } from "@pi-gui/session-driver";
import type { RuntimeCommandRecord } from "@pi-gui/session-driver/runtime-types";
import { JsonCatalogStore, type SessionFileCatalogStorage } from "./json-catalog-store.js";
import {
  applyHostUiRequestToExtensionUiState,
  createEmptyExtensionUiState,
  type ExtensionUiState,
} from "./extension-ui-state.js";
import {
  createUnsupportedHostUiError,
  parseUnsupportedHostUiErrorMessage,
} from "./unsupported-host-ui.js";
import { normalizeRuntimeCommandName, skillCommandName } from "./runtime-command-utils.js";
import {
  buildSnapshot,
  createWorkspaceRef,
  deriveSessionConfig,
  deriveWorkspaceTitle,
  determineRunOutcome,
  extractPreview,
  forcePersistSession,
  injectFileAttachmentPreamble,
  messageText,
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
import { createAgentSessionRuntimeWithNpmFallback } from "./npm-package-fallback.js";

export interface PiSdkDriverOptions {
  readonly catalogFilePath?: string;
  readonly createAgentSessionRuntimeImpl?: (options?: CreateAgentSessionOptions) => Promise<AgentSessionRuntime>;
  readonly modelRegistry?: ModelRegistry;
  readonly generateThreadTitleOverride?: (
    workspace: WorkspaceRef,
    options: import("./thread-title-generator.js").GenerateThreadTitleOptions,
  ) => Promise<string | null | undefined>;
}

export interface SyncWorkspaceResult {
  readonly workspace: WorkspaceRef;
  readonly sessions: SessionCatalogSnapshot["sessions"];
}

interface ManagedSessionRecord {
  ref: SessionRef;
  workspace: WorkspaceRef;
  title: string;
  runtime: AgentSessionRuntime | undefined;
  session: AgentSession | undefined;
  sessionFile: string | undefined;
  status: SessionStatus;
  updatedAt: string;
  archivedAt: string | undefined;
  preview: string | undefined;
  config: SessionConfig | undefined;
  runningRunId: string | undefined;
  queuedMessages: SessionQueuedMessage[];
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
  bindingExtensions: boolean;
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

const NEW_THREAD_PLACEHOLDER_TITLE = "New thread";

interface SkillAdapter {
  readonly name: string;
  readonly description: string;
  readonly sourceInfo?: RuntimeCommandRecord["sourceInfo"];
  readonly filePath?: string;
  readonly source?: string;
}

export class SessionSupervisor {
  private readonly catalogs: SessionFileCatalogStorage;
  private readonly createAgentSessionRuntimeImpl: (options?: CreateAgentSessionOptions) => Promise<AgentSessionRuntime>;
  private readonly modelRegistry: ModelRegistry | undefined;
  private readonly records = new Map<string, ManagedSessionRecord>();

  constructor(options: PiSdkDriverOptions = {}) {
    this.catalogs = options.catalogFilePath
      ? new JsonCatalogStore({ catalogFilePath: options.catalogFilePath })
      : new JsonCatalogStore();
    this.createAgentSessionRuntimeImpl =
      options.createAgentSessionRuntimeImpl ?? ((createOptions) => createAgentSessionRuntimeWithNpmFallback(createOptions));
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
      await this.disposeRecordRuntime(record);
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
      await this.disposeRecordRuntime(record);
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

    const initialModel = options?.initialModel
      ? this.resolveModel(options.initialModel.provider, options.initialModel.modelId)
      : undefined;
    const createOptions: CreateAgentSessionOptions = {
      cwd: workspace.path,
      sessionManager: SessionManager.create(workspace.path),
      ...(this.modelRegistry ? { modelRegistry: this.modelRegistry } : {}),
    };
    if (initialModel) {
      createOptions.model = initialModel;
    }
    if (options?.initialThinkingLevel) {
      createOptions.thinkingLevel = options.initialThinkingLevel as NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
    }

    const runtime = await this.createAgentSessionRuntimeImpl(createOptions);
    const session = runtime.session;

    const record = this.createRecord(workspace, runtime, options?.title ?? deriveWorkspaceTitle(workspace));
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
    if (session.isStreaming && !isExtensionCommand && !input.deliverAs) {
      throw new Error("Session is already streaming. Specify deliverAs ('steer' or 'followUp') to queue the message.");
    }

    const isQueuedMessage = session.isStreaming && !isExtensionCommand && Boolean(input.deliverAs);
    const runId = isQueuedMessage || isExtensionCommand ? undefined : crypto.randomUUID();
    record.runningRunId = runId ?? record.runningRunId;
    record.status = isQueuedMessage || isExtensionCommand ? record.status : "running";
    record.updatedAt = nowIso();
    record.config = deriveSessionConfig(session.sessionManager);
    record.preview = truncate(input.text);
    if (isQueuedMessage) {
      record.queuedMessages = [
        ...record.queuedMessages,
        queuedMessageFromInput(input, record.updatedAt),
      ];
    }
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));

    try {
      const images = input.attachments?.flatMap((attachment: NonNullable<SessionMessageInput["attachments"]>[number]) =>
        attachment.kind === "image"
          ? [{
              type: "image" as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
            }]
          : [],
      );
      const promptText = injectFileAttachmentPreamble(input.text, input.attachments);
      if (isQueuedMessage) {
        await this.queuePrompt(session, promptText, input.deliverAs!, images);
      } else {
        await session.prompt(promptText, {
          ...(images && images.length > 0 ? { images } : {}),
          source: "interactive",
        });
      }

      if (isExtensionCommand) {
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
      }
    } catch (error) {
      if (isQueuedMessage) {
        record.queuedMessages = record.queuedMessages.slice(0, -1);
      }
      if (!isQueuedMessage) {
        record.runningRunId = undefined;
      }
      record.status = isQueuedMessage ? "running" : isExtensionCommand ? "idle" : "failed";
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

  async replaceQueuedMessages(sessionRef: SessionRef, messages: readonly SessionQueuedMessage[]): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const session = this.requireSession(record);
    session.clearQueue();

    record.queuedMessages = messages.map((message) => cloneQueuedMessage(message));
    for (const message of record.queuedMessages) {
      const images = message.attachments?.flatMap((attachment: NonNullable<SessionQueuedMessage["attachments"]>[number]) =>
        attachment.kind === "image"
          ? [{
              type: "image" as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
            }]
          : [],
      );
      const promptText = injectFileAttachmentPreamble(message.text, message.attachments);
      await this.queuePrompt(session, promptText, message.mode, images);
    }

    record.updatedAt = nowIso();
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));
  }

  async cancelCurrentRun(sessionRef: SessionRef): Promise<void> {
    const record = this.records.get(sessionKey(sessionRef));
    if (!record?.session) {
      return;
    }

    await record.session.abort();
    record.runningRunId = undefined;
    record.status = "idle";
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));
  }

  async setSessionModel(sessionRef: SessionRef, selection: SessionModelSelection): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const session = record.session;
    if (!session) {
      throw new Error(`Session ${sessionKey(record.ref)} is not active.`);
    }

    const model = this.resolveModel(selection.provider, selection.modelId);
    const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }

    const previousModel = session.model;
    const previousThinkingLevel = session.supportsThinking()
      ? session.thinkingLevel
      : (session.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_SESSION_THINKING_LEVEL);

    session.agent.state.model = model;
    session.sessionManager.appendModelChange(model.provider, model.id);
    this.applySessionThinkingLevel(session, previousThinkingLevel);
    await this.emitModelSelection(session, model, previousModel);
    forcePersistSession(session.sessionManager);
    record.config = deriveSessionConfig(session.sessionManager);
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));
  }

  async setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    const session = this.requireSession(record);
    this.applySessionThinkingLevel(session, thinkingLevel);
    forcePersistSession(session.sessionManager);
    record.config = deriveSessionConfig(session.sessionManager);
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

  async getSessionTree(sessionRef: SessionRef): Promise<SessionTreeSnapshot> {
    const record = await this.ensureRecord(sessionRef);
    const session = this.requireSession(record);
    return {
      roots: session.sessionManager.getTree().map((node) => toSessionTreeNodeSnapshot(node)),
      leafId: session.sessionManager.getLeafId(),
    };
  }

  async navigateSessionTree(
    sessionRef: SessionRef,
    targetId: string,
    options: NavigateSessionTreeOptions = {},
  ): Promise<NavigateSessionTreeResult> {
    const record = await this.ensureRecord(sessionRef);
    const session = this.requireSession(record);
    const result = await session.navigateTree(targetId, options);
    if (result.cancelled || result.aborted) {
      return {
        cancelled: result.cancelled,
        ...(result.aborted ? { aborted: true } : {}),
        ...(result.editorText ? { editorText: result.editorText } : {}),
        ...(result.summaryEntry ? { summaryCreated: true } : {}),
      };
    }

    record.updatedAt = nowIso();
    await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
    return {
      cancelled: false,
      ...(result.editorText ? { editorText: result.editorText } : {}),
      ...(result.summaryEntry ? { summaryCreated: true } : {}),
    };
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
      for (const currentRecord of this.records.values()) {
        currentRecord.listeners.delete(listener);
      }
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
      await this.disposeRecordRuntime(record);
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

    const runtime = await this.createAgentSessionRuntimeImpl({
      cwd: workspace.path,
      sessionManager: SessionManager.open(sessionFile),
      ...(this.modelRegistry ? { modelRegistry: this.modelRegistry } : {}),
    });
    const session = runtime.session;

    const record = existing ?? this.createRecord(workspaceToRef(workspace), runtime, sessionEntry.title);
    record.runtime = runtime;
    record.session = session;
    record.sessionFile = sessionFile;
    record.title = sessionEntry.title;
    record.status = sessionEntry.status;
    record.updatedAt = sessionEntry.updatedAt;
    record.archivedAt = sessionEntry.archivedAt;
    record.preview = sessionEntry.previewSnippet ?? undefined;
    record.config = deriveSessionConfig(session.sessionManager);
    record.closed = false;

    this.records.set(key, record);
    await this.bindSessionRuntime(record);
    return record;
  }

  private createRecord(workspace: WorkspaceRef, runtime: AgentSessionRuntime, title: string): ManagedSessionRecord {
    const session = runtime.session;
    const ref = {
      workspaceId: workspace.workspaceId,
      sessionId: session.sessionId,
    };

    const record: ManagedSessionRecord = {
      ref,
      workspace: { ...workspace },
      title,
      runtime,
      session,
      sessionFile: session.sessionFile ?? session.sessionManager.getSessionFile(),
      status: "idle",
      updatedAt: nowIso(),
      archivedAt: undefined,
      preview: undefined,
      config: deriveSessionConfig(session.sessionManager),
      runningRunId: undefined,
      queuedMessages: [],
      closed: false,
      listeners: new Set<SessionEventListener>(),
      eventQueue: Promise.resolve(),
      unsubscribeAgent: undefined,
      pendingHostUiRequests: new Map(),
      extensionUiState: createEmptyExtensionUiState(),
      bindingExtensions: false,
      sessionCommands: [],
    };
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

  private requireRuntime(record: ManagedSessionRecord): AgentSessionRuntime {
    if (!record.runtime) {
      throw new Error(`Session ${sessionKey(record.ref)} runtime is not active.`);
    }
    return record.runtime;
  }

  private async disposeRecordRuntime(record: ManagedSessionRecord): Promise<void> {
    const runtime = record.runtime;
    const session = record.session;
    record.runtime = undefined;
    record.session = undefined;
    record.sessionCommands = [];
    if (runtime) {
      await runtime.dispose();
      return;
    }
    session?.dispose();
  }

  private async rebindRuntimeSession(record: ManagedSessionRecord, session: AgentSession): Promise<void> {
    const previousKey = sessionKey(record.ref);
    const nextRef = {
      workspaceId: record.workspace.workspaceId,
      sessionId: session.sessionId,
    } satisfies SessionRef;
    const nextKey = sessionKey(nextRef);

    if (previousKey !== nextKey) {
      const existingTarget = this.records.get(nextKey);
      if (existingTarget && existingTarget !== record) {
        for (const listener of existingTarget.listeners) {
          record.listeners.add(listener);
        }
        existingTarget.unsubscribeAgent?.();
        existingTarget.unsubscribeAgent = undefined;
        this.cancelPendingHostUiRequests(existingTarget);
        await this.disposeRecordRuntime(existingTarget);
      }
      this.records.delete(previousKey);
      record.ref = nextRef;
      this.records.set(nextKey, record);
    }

    record.session = session;
    record.sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    record.unsubscribeAgent?.();
    record.unsubscribeAgent = session.subscribe((event) => {
      void this.handleAgentEvent(record, event);
    });
    record.bindingExtensions = true;
    try {
      await session.bindExtensions({
        uiContext: this.createExtensionUiContext(record),
        commandContextActions: this.createCommandContextActions(record),
        onError: (error) => {
          const unsupportedIssue = parseUnsupportedHostUiErrorMessage(error.error);
          if (unsupportedIssue) {
            this.emitExtensionCompatibilityIssue(record, {
              ...unsupportedIssue,
              ...(error.extensionPath ? { extensionPath: error.extensionPath } : {}),
              ...(error.event ? { eventName: error.event } : {}),
            });
            return;
          }
          void this.emitExtensionError(record, error.extensionPath, error.event, error.error);
        },
      });
    } finally {
      record.bindingExtensions = false;
    }
    record.sessionCommands = this.collectSessionCommands(session);
  }

  private async bindSessionRuntime(record: ManagedSessionRecord): Promise<void> {
    const runtime = this.requireRuntime(record);
    runtime.setRebindSession(async (session) => {
      this.clearExtensionUiState(record);
      this.cancelPendingHostUiRequests(record);
      await this.rebindRuntimeSession(record, session);
    });
    await this.rebindRuntimeSession(record, runtime.session);
  }

  private createCommandContextActions(record: ManagedSessionRecord): ExtensionCommandContextActions {
    return {
      waitForIdle: () => this.requireSession(record).agent.waitForIdle(),
      newSession: async (options) => {
        const { cancelled } = await this.requireRuntime(record).newSession(options);
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
        return { cancelled };
      },
      fork: async (entryId, options) => {
        const result = await this.requireRuntime(record).fork(entryId, options);
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const result = await this.requireSession(record).navigateTree(targetId, options);
        await this.syncRecordAfterSessionMutation(record, { emitUpdate: true });
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, options) => {
        const { cancelled } = await this.requireRuntime(record).switchSession(sessionPath, options);
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
      if (record.bindingExtensions && opts?.timeout === undefined) {
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

        const timeoutMs = opts?.timeout;
        if (timeoutMs !== undefined) {
          timeoutId = setTimeout(() => {
            cleanup();
            resolve(defaultValue);
          }, timeoutMs);
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
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
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
      // pi-gui does not render arbitrary TUI custom components. Throwing a
      // typed unsupported-host error allows extensions to catch and degrade,
      // while uncaught command paths fail fast and are surfaced cleanly by
      // the desktop host.
      custom: async () => {
        throw createUnsupportedHostUiError("custom");
      },
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
      getEditorComponent: () => undefined,
      addAutocompleteProvider: () => {},
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

  private async queuePrompt(
    session: AgentSession,
    text: string,
    deliverAs: SessionMessageDeliveryMode,
    images?: readonly {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }[],
  ): Promise<void> {
    if (deliverAs === "steer") {
      await session.steer(text, images ? [...images] : undefined);
      return;
    }
    await session.followUp(text, images ? [...images] : undefined);
  }

  private resolveModel(provider: string, modelId: string) {
    const model = this.modelRegistry?.find(provider, modelId);
    if (!model) {
      throw new Error(`Unknown model ${provider}:${modelId}`);
    }
    return model;
  }

  private applySessionThinkingLevel(session: AgentSession, thinkingLevel: string): void {
    const availableLevels = session.getAvailableThinkingLevels();
    const effectiveLevel = clampThinkingLevel(thinkingLevel, availableLevels) as AgentSession["thinkingLevel"];
    if (effectiveLevel !== session.agent.state.thinkingLevel) {
      session.agent.state.thinkingLevel = effectiveLevel;
      session.sessionManager.appendThinkingLevelChange(effectiveLevel);
      return;
    }
    session.agent.state.thinkingLevel = effectiveLevel;
  }

  private async emitModelSelection(
    session: AgentSession,
    model: ReturnType<SessionSupervisor["resolveModel"]>,
    previousModel: AgentSession["model"],
  ): Promise<void> {
    const emitModelSelect = (session as unknown as {
      _emitModelSelect?: (nextModel: unknown, previousModel: unknown, source: string) => Promise<void>;
    })._emitModelSelect;
    if (!emitModelSelect) {
      return;
    }
    await emitModelSelect.call(session, model, previousModel, "set");
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

  private emitExtensionCompatibilityIssue(
    record: ManagedSessionRecord,
    issue: Extract<SessionDriverEvent, { type: "extensionCompatibilityIssue" }>["issue"],
  ): void {
    this.queueDriverEvents(
      record,
      [
        {
          type: "extensionCompatibilityIssue",
          sessionRef: record.ref,
          timestamp: nowIso(),
          issue,
        },
      ],
      { persistSnapshot: false },
    );
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
        return [sessionUpdatedEvent(record)];
      case "message_start":
      case "message_end":
        if (event.message.role === "user") {
          const queuedMessage = reconcileQueuedMessagesForStartedUserMessage(record, event.message, timestamp);
          if (queuedMessage) {
            this.updatePreviewFromMessage(record, event.message);
            return [{
              type: "queuedMessageStarted" as const,
              sessionRef: record.ref,
              timestamp,
              message: queuedMessage,
            }, sessionUpdatedEvent(record)];
          }
        }
        this.updatePreviewFromMessage(record, event.message);
        return [sessionUpdatedEvent(record)];
      case "message_update":
        this.updatePreviewFromMessage(record, event.message);
        if (event.message.role === "assistant") {
          if (event.assistantMessageEvent.type === "thinking_start") {
            return toDriverEvents({
              type: "assistantThinkingStarted" as const,
              sessionRef: record.ref,
              timestamp,
            }, record);
          }
          if (event.assistantMessageEvent.type === "thinking_end") {
            return toDriverEvents({
              type: "assistantThinkingFinished" as const,
              sessionRef: record.ref,
              timestamp,
            }, record);
          }
        }
        if (event.message.role === "assistant") {
          if (event.assistantMessageEvent.type === "thinking_delta") {
            return toDriverEvents({
              type: "assistantThinkingDelta" as const,
              sessionRef: record.ref,
              timestamp,
              text: event.assistantMessageEvent.delta ?? "",
            }, record);
          }
          if (event.assistantMessageEvent.type === "text_delta") {
            return toDriverEvents({
              type: "assistantDelta" as const,
              sessionRef: record.ref,
              timestamp,
              text: event.assistantMessageEvent.delta ?? "",
            }, record);
          }
        }
        return [sessionUpdatedEvent(record)];
      case "tool_execution_start":
        record.status = "running";
        return toDriverEvents({
          type: "toolStarted" as const,
          sessionRef: record.ref,
          timestamp,
          toolName: event.toolName,
          callId: event.toolCallId,
          input: event.args,
        }, record);
      case "tool_execution_update":
        return toDriverEvents({
          type: "toolUpdated" as const,
          sessionRef: record.ref,
          timestamp,
          callId: event.toolCallId,
          ...(typeof event.partialResult === "string" ? { text: event.partialResult } : {}),
          ...(typeof event.partialResult === "number" ? { progress: event.partialResult } : {}),
        }, record);
      case "tool_execution_end":
        return toDriverEvents({
          type: "toolFinished" as const,
          sessionRef: record.ref,
          timestamp,
          callId: event.toolCallId,
          success: !event.isError,
          output: event.result,
        }, record);
      case "turn_end":
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
    const titleFromInfo = titleFromSessionInfo(info);
    const entry: SessionCatalogSnapshot["sessions"][number] = {
      sessionRef: {
        workspaceId: workspace.workspaceId,
        sessionId: info.id,
      },
      workspaceId: workspace.workspaceId,
      title: runtimeSnapshot?.title ?? resolvedCatalogSessionTitle(existingEntry?.title, titleFromInfo),
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

function resolvedCatalogSessionTitle(existingTitle: string | undefined, infoTitle: string): string {
  const trimmedExisting = existingTitle?.trim();
  if (!trimmedExisting) {
    return infoTitle;
  }
  if (trimmedExisting === NEW_THREAD_PLACEHOLDER_TITLE && infoTitle !== NEW_THREAD_PLACEHOLDER_TITLE) {
    return infoTitle;
  }
  return trimmedExisting;
}

const DEFAULT_SESSION_THINKING_LEVEL = "medium";
const THINKING_LEVEL_ORDER = ["off", "low", "medium", "high", "xhigh"] as const;
type SessionTreeNodeRecord = ReturnType<SessionManager["getTree"]>[number];

function clampThinkingLevel(level: string, availableLevels: readonly string[]): string {
  const available = new Set(availableLevels);
  const requestedIndex = THINKING_LEVEL_ORDER.indexOf(level as (typeof THINKING_LEVEL_ORDER)[number]);
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }
  for (let index = requestedIndex; index < THINKING_LEVEL_ORDER.length; index += 1) {
    const candidate = THINKING_LEVEL_ORDER[index];
    if (candidate && available.has(candidate)) {
      return candidate;
    }
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVEL_ORDER[index];
    if (candidate && available.has(candidate)) {
      return candidate;
    }
  }
  return availableLevels[0] ?? "off";
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

interface TreeToolCallRecord {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

function toSessionTreeNodeSnapshot(
  node: SessionTreeNodeRecord,
  toolCalls: ReadonlyMap<string, TreeToolCallRecord> = new Map(),
): SessionTreeNodeSnapshot {
  const role = treeNodeRole(node.entry);
  const customType = treeNodeCustomType(node.entry);
  const preview = treeNodePreview(node.entry, toolCalls);
  const childToolCalls = extendTreeToolCalls(toolCalls, node.entry);
  return {
    id: node.entry.id,
    parentId: node.entry.parentId,
    kind: node.entry.type,
    timestamp: node.entry.timestamp,
    ...(node.label ? { label: node.label } : {}),
    ...(role ? { role } : {}),
    ...(customType ? { customType } : {}),
    title: treeNodeTitle(node.entry),
    ...(preview ? { preview } : {}),
    children: node.children.map((child) => toSessionTreeNodeSnapshot(child, childToolCalls)),
  };
}

function extendTreeToolCalls(
  toolCalls: ReadonlyMap<string, TreeToolCallRecord>,
  entry: SessionTreeNodeRecord["entry"],
): ReadonlyMap<string, TreeToolCallRecord> {
  if (entry.type !== "message" || entry.message.role !== "assistant") {
    return toolCalls;
  }

  const content = entry.message.content;
  if (!Array.isArray(content)) {
    return toolCalls;
  }

  let nextToolCalls: Map<string, TreeToolCallRecord> | undefined;
  for (const block of content) {
    if (
      typeof block !== "object" ||
      block === null ||
      !("type" in block) ||
      block.type !== "toolCall" ||
      !("id" in block) ||
      typeof block.id !== "string" ||
      !("name" in block) ||
      typeof block.name !== "string"
    ) {
      continue;
    }
    nextToolCalls ??= new Map(toolCalls);
    nextToolCalls.set(block.id, {
      name: block.name,
      arguments:
        "arguments" in block && typeof block.arguments === "object" && block.arguments !== null
          ? (block.arguments as Record<string, unknown>)
          : {},
    });
  }

  return nextToolCalls ?? toolCalls;
}

function treeNodeRole(entry: SessionTreeNodeRecord["entry"]): string | undefined {
  if (entry.type !== "message") {
    return undefined;
  }
  return entry.message.role;
}

function treeNodeCustomType(entry: SessionTreeNodeRecord["entry"]): string | undefined {
  if (entry.type === "custom" || entry.type === "custom_message") {
    return entry.customType;
  }
  return undefined;
}

function treeNodeTitle(entry: SessionTreeNodeRecord["entry"]): string {
  switch (entry.type) {
    case "message":
      switch (entry.message.role) {
        case "user":
          return "User";
        case "assistant":
          return "Assistant";
        case "toolResult":
          return "Tool result";
        case "bashExecution":
          return "Shell";
        case "branchSummary":
          return "Branch summary";
        case "compactionSummary":
          return "Compaction";
        default:
          return entry.message.role;
      }
    case "custom_message":
      return entry.customType;
    case "compaction":
      return "Compaction";
    case "branch_summary":
      return "Branch summary";
    case "model_change":
      return "Model";
    case "thinking_level_change":
      return "Thinking";
    case "custom":
      return "Custom";
    case "label":
      return "Label";
    case "session_info":
      return "Title";
  }
  return "Entry";
}

function treeNodePreview(
  entry: SessionTreeNodeRecord["entry"],
  toolCalls: ReadonlyMap<string, TreeToolCallRecord>,
): string | undefined {
  switch (entry.type) {
    case "message":
      return previewForTreeMessage(entry.message as unknown as Record<string, unknown>, toolCalls);
    case "custom_message":
      return previewForTreeContent(entry.content);
    case "compaction":
      return `${Math.max(1, Math.round(entry.tokensBefore / 1000))}k token summary`;
    case "branch_summary":
      return truncate(entry.summary);
    case "model_change":
      return `${entry.provider}:${entry.modelId}`;
    case "thinking_level_change":
      return entry.thinkingLevel;
    case "custom":
      return entry.customType;
    case "label":
      return entry.label ?? "(cleared)";
    case "session_info":
      return entry.name || "(empty)";
    default:
      return undefined;
  }
}

function previewForTreeMessage(
  message: Record<string, unknown>,
  toolCalls: ReadonlyMap<string, TreeToolCallRecord>,
): string | undefined {
  if (message.role === "toolResult") {
    return previewForTreeToolResult(message, toolCalls);
  }
  const content = message.content;
  if (typeof content === "string") {
    return truncate(content.trim()) || undefined;
  }
  if (Array.isArray(content)) {
    const preview = truncate(
      content
        .flatMap((part) =>
          typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (preview) {
      return preview;
    }
  }
  if (message.role === "bashExecution" && typeof message.command === "string") {
    return truncate(message.command);
  }
  return undefined;
}

function previewForTreeToolResult(
  message: Record<string, unknown>,
  toolCalls: ReadonlyMap<string, TreeToolCallRecord>,
): string | undefined {
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
  const toolCall = toolCallId ? toolCalls.get(toolCallId) : undefined;

  if (toolCall) {
    return formatTreeToolCall(toolCall.name, toolCall.arguments);
  }

  if (toolName) {
    return `[${toolName}]`;
  }

  return "[tool]";
}

function formatTreeToolCall(name: string, args: Readonly<Record<string, unknown>>): string {
  switch (name) {
    case "read": {
      const path = shortenHomePath(String(args.path ?? args.file_path ?? ""));
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let display = path;
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : undefined;
        display += `:${start}${end !== undefined ? `-${end}` : ""}`;
      }
      return `[read: ${display}]`;
    }
    case "write":
      return `[write: ${shortenHomePath(String(args.path ?? args.file_path ?? ""))}]`;
    case "edit":
      return `[edit: ${shortenHomePath(String(args.path ?? args.file_path ?? ""))}]`;
    case "bash": {
      const rawCommand = String(args.command ?? "")
        .replace(/[\n\t]/g, " ")
        .trim();
      return `[bash: ${truncate(rawCommand, 50)}]`;
    }
    case "grep":
      return `[grep: /${String(args.pattern ?? "")}/ in ${shortenHomePath(String(args.path ?? "."))}]`;
    case "find":
      return `[find: ${String(args.pattern ?? "")} in ${shortenHomePath(String(args.path ?? "."))}]`;
    case "ls":
      return `[ls: ${shortenHomePath(String(args.path ?? "."))}]`;
    default: {
      const json = JSON.stringify(args);
      return truncate(`[${name}: ${json}]`, 80);
    }
  }
}

function shortenHomePath(path: string): string {
  const homePath = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (homePath && path.startsWith(homePath)) {
    return `~${path.slice(homePath.length)}`;
  }
  return path;
}

function previewForTreeContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return truncate(content.trim()) || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return (
    truncate(
      content
        .flatMap((part) =>
          typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    ) || undefined
  );
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

function cloneQueuedMessage(message: SessionQueuedMessage): SessionQueuedMessage {
  return {
    ...message,
    ...(message.attachments
      ? {
          attachments: message.attachments.map((attachment: NonNullable<SessionQueuedMessage["attachments"]>[number]) => ({ ...attachment })),
        }
      : {}),
  };
}

function queuedMessageFromInput(input: SessionMessageInput, timestamp: string): SessionQueuedMessage {
  return {
    id: crypto.randomUUID(),
    mode: input.deliverAs!,
    text: input.text,
    ...(input.attachments
      ? {
          attachments: input.attachments.map((attachment) => ({ ...attachment })),
        }
      : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function reconcileQueuedMessagesForStartedUserMessage(
  record: ManagedSessionRecord,
  message: unknown,
  timestamp: string,
): SessionQueuedMessage | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }

  const text = messageText(message as Record<string, unknown>);
  if (!text) {
    return undefined;
  }

  const steeringIndex = record.queuedMessages.findIndex((item) => item.mode === "steer" && item.text === text);
  if (steeringIndex !== -1) {
    const [started] = record.queuedMessages.splice(steeringIndex, 1);
    record.updatedAt = timestamp;
    return started;
  }

  const followUpIndex = record.queuedMessages.findIndex((item) => item.mode === "followUp" && item.text === text);
  if (followUpIndex !== -1) {
    const [started] = record.queuedMessages.splice(followUpIndex, 1);
    record.updatedAt = timestamp;
    return started;
  }

  return undefined;
}

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
