import { access, realpath, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SessionManager,
  type AuthStorage,
  type ModelRegistry,
  type AgentSessionRuntime,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
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
} from "@pi-gui/session-driver/types";
import type {
  CreateSessionOptions,
  ForkSessionOptions,
  ForkSessionResult,
  HostUiRequest,
  HostUiResponse,
  SessionConfig,
  SessionDriverEvent,
  SessionEventListener,
  SessionModelSelection,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  Unsubscribe,
  WorkspaceId,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { RuntimeCommandRecord } from "@pi-gui/session-driver/runtime-types";
import { isMissingFileError, JsonCatalogStore, type SessionFileCatalogStorage } from "./json-catalog-store.js";
import {
  buildSessionSchemaInfo,
  readSessionFileSchemaVersion,
  type SessionSchemaInfo,
} from "./session-schema.js";
import {
  buildOwnLease,
  currentLeaseIdentity,
  defaultIsPidAlive,
  DEFAULT_LEASE_TTL_MS,
  type LeaseIdentity,
  leaseBlocksBinding,
  readLeaseSnapshot,
  removeLeaseFile,
  sessionLeasePath,
  SessionLeasedError,
  writeLeaseFile,
} from "./session-lease.js";
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
  chainRecoveringEventQueue,
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
  shouldTailFromDisk,
  singleFlight,
  titleFromSessionInfo,
  toSessionErrorInfo,
  transcriptFromMessages,
  truncate,
  workspaceToRef,
} from "./session-supervisor-utils.js";
import type { SessionTranscriptItem, SessionTranscriptMessage } from "./transcript.js";
import {
  createAgentSessionRuntimeWithNpmFallback,
  type PiCreateAgentSessionOptions,
  type PiModelInfo,
} from "./npm-package-fallback.js";

function requireModel(modelRegistry: ModelRegistry, provider: string, modelId: string): PiModelInfo {
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Unknown model ${provider}:${modelId}`);
  }
  return model;
}

/**
 * Resolve a model against a live session's registry.
 *
 * The registry was built when the session was created, so a provider added since
 * then — a custom provider set up in Settings, say — is not in it yet. Refreshing
 * on a miss reloads `models.json` and reapplies the session's own extension
 * registrations, which is what makes a freshly added model selectable without
 * reopening the session.
 */
function requireSessionModel(modelRegistry: ModelRegistry, provider: string, modelId: string): PiModelInfo {
  const model = modelRegistry.find(provider, modelId);
  if (model) {
    return model;
  }
  modelRegistry.refresh();
  return requireModel(modelRegistry, provider, modelId);
}

export interface PiSdkDriverOptions {
  readonly catalogFilePath?: string;
  readonly createAgentSessionRuntimeImpl?: (options?: PiCreateAgentSessionOptions) => Promise<AgentSessionRuntime>;
  readonly agentDir?: string;
  readonly authStorage?: AuthStorage;
  readonly extensionFactories?: readonly ExtensionFactory[];
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
  /** Path of the advisory lease file this record currently holds, if any. */
  leasePath: string | undefined;
  /** mtime (epoch ms) of the JSONL last reconciled into the served transcript. */
  transcriptDiskMtimeMs: number | undefined;
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
  private readonly createAgentSessionRuntimeImpl: (options?: PiCreateAgentSessionOptions) => Promise<AgentSessionRuntime>;
  private readonly agentDir: string | undefined;
  private readonly authStorage: AuthStorage | undefined;
  private readonly records = new Map<string, ManagedSessionRecord>();
  private readonly ensureRecordInFlight = new Map<string, Promise<ManagedSessionRecord>>();
  private readonly leaseIdentity: LeaseIdentity = currentLeaseIdentity();
  private readonly leaseTtlMs = DEFAULT_LEASE_TTL_MS;
  private readonly isPidAlive = defaultIsPidAlive;

  constructor(options: PiSdkDriverOptions = {}) {
    this.catalogs = options.catalogFilePath
      ? new JsonCatalogStore({ catalogFilePath: options.catalogFilePath })
      : new JsonCatalogStore();
    this.createAgentSessionRuntimeImpl =
      options.createAgentSessionRuntimeImpl ??
      ((createOptions) =>
        createAgentSessionRuntimeWithNpmFallback({
          ...createOptions,
          resourceLoaderOptions: {
            ...(createOptions as PiCreateAgentSessionOptions | undefined)?.resourceLoaderOptions,
            ...(options.extensionFactories ? { extensionFactories: [...options.extensionFactories] } : {}),
          },
        }));
    this.agentDir = options.agentDir;
    this.authStorage = options.authStorage;
  }

  /**
   * Options every session creation shares.
   *
   * Deliberately no `modelRegistry`: letting `createAgentSessionServices` build
   * one per session keeps it cwd-bound, so it holds exactly the extension
   * providers registered for this workspace and cannot pick up another open
   * workspace's endpoint or credentials for the same provider id. `authStorage`
   * is shared so a login made in Settings reaches sessions that are already open.
   */
  private baseCreateOptions(cwd: string, sessionManager: SessionManager): PiCreateAgentSessionOptions {
    return {
      cwd,
      sessionManager,
      ...(this.agentDir ? { agentDir: this.agentDir } : {}),
      ...(this.authStorage ? { authStorage: this.authStorage } : {}),
    };
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
          if (discoveredKeys.has(key)) {
            return undefined;
          }

          const sessionFilePath = session.sessionFilePath ?? (await this.catalogs.getSessionFile(session.sessionRef));
          if (!sessionFilePath) {
            return undefined;
          }

          try {
            await access(sessionFilePath);
          } catch (error) {
            // Only a confirmed missing file may drop a session. Transient
            // failures (unmounted volume, permissions) must not delete state.
            if (isMissingFileError(error)) {
              return undefined;
            }
          }

          const record = this.records.get(key);
          const runtimeSnapshot = record && record.session && !record.closed ? buildSnapshot(record) : undefined;
          return {
            ...session,
            sessionFilePath,
            status: runtimeSnapshot?.status ?? ("idle" as const),
          };
        }),
      )
    ).filter((session): session is NonNullable<typeof session> => Boolean(session));
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
      await this.disposeRecordRuntimeSafely(record);
      this.records.delete(key);
    }

    return {
      workspace,
      sessions: (await this.catalogs.sessions.listSessions(workspace.workspaceId)).sessions,
    };
  }

  /**
   * Re-scan a workspace's pi session directory from disk and reconcile the
   * catalog. Thin wrapper over syncWorkspace keyed by workspaceId, for
   * window-focus / external-change reconcile. Returns undefined if the
   * workspace is no longer tracked.
   */
  async reconcileWorkspace(workspaceId: WorkspaceId): Promise<SyncWorkspaceResult | undefined> {
    const workspace = await this.catalogs.workspaces.getWorkspace(workspaceId);
    if (!workspace) {
      return undefined;
    }
    return this.syncWorkspace(workspace.path);
  }

  /**
   * Best-effort absolute path of a session's pi `.jsonl` file. Used by the app
   * layer to stat the selected session on window focus and only reload the
   * transcript when the on-disk file actually changed.
   */
  getSessionFilePath(sessionRef: SessionRef): Promise<string | undefined> {
    return this.resolveSessionFilePath(sessionRef);
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
      await this.disposeRecordRuntimeSafely(record);
      this.records.delete(key);
    }
  }

  async getTranscript(sessionRef: SessionRef): Promise<SessionTranscriptItem[]> {
    const record = this.records.get(sessionKey(sessionRef));
    if (record && record.session && !record.closed) {
      const diskMtimeMs = record.session.isStreaming ? undefined : await this.statMtimeMs(record.sessionFile);
      const tail = shouldTailFromDisk({
        isStreaming: record.session.isStreaming,
        diskMtimeMs,
        baselineMtimeMs: record.transcriptDiskMtimeMs,
      });
      if (tail) {
        record.transcriptDiskMtimeMs = diskMtimeMs;
        return this.readTranscriptFromDisk(sessionRef);
      }
      return transcriptFromMessages(record.session.messages ?? [], record.updatedAt);
    }
    return this.readTranscriptFromDisk(sessionRef);
  }

  /**
   * Build a transcript straight from the session's JSONL file without binding
   * an agent runtime. Pi's file is the source of truth for closed sessions, so
   * this can never serve a stale view.
   */
  private async readTranscriptFromDisk(sessionRef: SessionRef): Promise<SessionTranscriptItem[]> {
    const sessionEntry = await this.catalogs.sessions.getSession(sessionRef);
    const sessionFile = await this.resolveSessionFilePath(sessionRef, sessionEntry);
    if (!sessionFile) {
      throw new Error(`Session ${sessionKey(sessionRef)} has no tracked session file.`);
    }

    const sessionManager = SessionManager.open(sessionFile);
    return transcriptFromMessages(sessionManager.buildSessionContext().messages, sessionEntry?.updatedAt);
  }

  private async resolveSessionFilePath(
    sessionRef: SessionRef,
    sessionEntry?: SessionCatalogSnapshot["sessions"][number],
  ): Promise<string | undefined> {
    const entry = sessionEntry ?? (await this.catalogs.sessions.getSession(sessionRef));
    return (
      entry?.sessionFilePath ??
      (await this.catalogs.getSessionFile(sessionRef)) ??
      (await this.findSessionFileOnDisk(sessionRef))
    );
  }

  /**
   * Report whether a session file was written by a newer pi than the bundled
   * runtime (which would silently drop content the runtime can't parse). Cheap:
   * live sessions read the already-parsed header; closed sessions read only the
   * file's first line. Additive and read-only — no behavior change for
   * current/older sessions. See {@link SessionSchemaInfo} for field names.
   */
  async getSessionSchemaInfo(sessionRef: SessionRef): Promise<SessionSchemaInfo> {
    const record = this.records.get(sessionKey(sessionRef));
    if (record?.session && !record.closed) {
      const version = record.session.sessionManager.getHeader()?.version;
      return buildSessionSchemaInfo(typeof version === "number" ? version : undefined);
    }

    const sessionFile = await this.resolveSessionFilePath(sessionRef);
    if (!sessionFile) {
      return buildSessionSchemaInfo(undefined);
    }
    return buildSessionSchemaInfo(await readSessionFileSchemaVersion(sessionFile));
  }

  private async findSessionFileOnDisk(sessionRef: SessionRef): Promise<string | undefined> {
    const workspace = await this.catalogs.workspaces.getWorkspace(sessionRef.workspaceId);
    if (!workspace) {
      return undefined;
    }
    const infos = await SessionManager.list(workspace.path);
    return infos.find((info) => info.id === sessionRef.sessionId)?.path;
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

    const initialModel = options?.initialModel;
    const createOptions: PiCreateAgentSessionOptions = {
      ...this.baseCreateOptions(workspace.path, SessionManager.create(workspace.path)),
      ...(initialModel
        ? {
            resolveInitialModel: (modelRegistry: ModelRegistry) =>
              requireModel(modelRegistry, initialModel.provider, initialModel.modelId),
          }
        : {}),
      ...(options?.initialThinkingLevel
        ? {
            thinkingLevel: options.initialThinkingLevel as NonNullable<CreateAgentSessionOptions["thinkingLevel"]>,
          }
        : {}),
    };

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

  async validateForkSession(sourceRef: SessionRef, options: ForkSessionOptions): Promise<void> {
    await this.resolveForkSource(sourceRef, options);
  }

  async forkSession(sourceRef: SessionRef, options: ForkSessionOptions): Promise<ForkSessionResult> {
    const { sourceRecord, sourceFile, branch, selectedEntry } = await this.resolveForkSource(sourceRef, options);

    const position = options.position ?? "before";
    let targetLeafId: string | undefined;
    let selectedText: string | undefined;
    if (position === "after") {
      const selectedIndex = branch.findIndex((entry) => entry.id === selectedEntry.id);
      if (selectedEntry.message.role === "assistant") {
        // Assistant entries can be followed by tool-result entries that belong
        // to the same visible response. Include those, but stop before the next
        // assistant/user message so forking an earlier response does not keep a
        // later response from the same user turn.
        const nextMessageIndex = branch.findIndex(
          (entry, index) =>
            index > selectedIndex &&
            entry.type === "message" &&
            (entry.message.role === "user" || entry.message.role === "assistant"),
        );
        targetLeafId = nextMessageIndex > selectedIndex
          ? branch[nextMessageIndex - 1]?.id ?? selectedEntry.id
          : branch[branch.length - 1]?.id ?? selectedEntry.id;
      } else {
        const nextUserIndex = branch.findIndex(
          (entry, index) =>
            index > selectedIndex && entry.type === "message" && entry.message.role === "user",
        );
        targetLeafId = nextUserIndex > selectedIndex
          ? branch[nextUserIndex - 1]?.id ?? selectedEntry.id
          : branch[branch.length - 1]?.id ?? selectedEntry.id;
      }
    } else if (position === "at") {
      targetLeafId = selectedEntry.id;
    } else {
      targetLeafId = selectedEntry.parentId ?? undefined;
      selectedText = messageText(selectedEntry.message as unknown as Record<string, unknown>) || undefined;
    }

    const targetWorkspace = options.targetWorkspace;
    await this.touchWorkspace(targetWorkspace);
    const sameWorkspace = resolve(targetWorkspace.path) === resolve(sourceRecord.workspace.path);

    // Build a branched SessionManager containing only the history up to the fork point.
    let branchedManager: SessionManager;
    if (!targetLeafId) {
      // Forking before the first user message: start a fresh empty session in the target.
      branchedManager = SessionManager.create(targetWorkspace.path);
      branchedManager.newSession({ parentSession: sourceFile });
    } else if (sameWorkspace) {
      const opened = SessionManager.open(sourceFile);
      const forkedPath = opened.createBranchedSession(targetLeafId);
      if (!forkedPath) {
        throw new Error(`Failed to create forked session from ${sessionKey(sourceRef)}.`);
      }
      branchedManager = opened;
    } else {
      const forked = SessionManager.forkFrom(sourceFile, targetWorkspace.path);
      const fullForkPath = forked.getSessionFile();
      let forkedPath: string | undefined;
      try {
        forkedPath = forked.createBranchedSession(targetLeafId);
        if (!forkedPath) {
          throw new Error(`Failed to create forked session from ${sessionKey(sourceRef)}.`);
        }
      } catch (error) {
        await removeIntermediateForkSession(fullForkPath, undefined);
        throw error;
      }
      await removeIntermediateForkSession(fullForkPath, forkedPath);
      branchedManager = forked;
    }

    const forkConfig = deriveSessionConfig(branchedManager);
    const forkProvider = forkConfig?.provider;
    const forkModelId = forkConfig?.modelId;
    const createOptions: PiCreateAgentSessionOptions = {
      ...this.baseCreateOptions(targetWorkspace.path, branchedManager),
      ...(forkProvider && forkModelId
        ? {
            // A model the source session used may not exist in the target
            // workspace; fall back to the runtime default rather than failing.
            resolveInitialModel: (modelRegistry: ModelRegistry) => modelRegistry.find(forkProvider, forkModelId),
          }
        : {}),
      ...(forkConfig?.thinkingLevel
        ? {
            thinkingLevel: forkConfig.thinkingLevel as NonNullable<CreateAgentSessionOptions["thinkingLevel"]>,
          }
        : {}),
    };

    const runtime = await this.createAgentSessionRuntimeImpl(createOptions);
    const session = runtime.session;

    const title = options.title ?? sourceRecord.title;
    const record = this.createRecord(targetWorkspace, runtime, title);
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
    return selectedText === undefined ? { snapshot } : { snapshot, selectedText };
  }

  private async resolveForkSource(
    sourceRef: SessionRef,
    options: ForkSessionOptions,
  ): Promise<{
    readonly sourceRecord: ManagedSessionRecord;
    readonly sourceFile: string;
    readonly branch: readonly SessionBranchEntry[];
    readonly selectedEntry: SessionMessageBranchEntry;
  }> {
    const sourceRecord = await this.ensureRecord(sourceRef);
    const sourceSession = this.requireSession(sourceRecord);
    const sourceManager = sourceSession.sessionManager;
    const sourceFile = sourceRecord.sessionFile ?? sourceManager.getSessionFile();
    if (!sourceFile) {
      throw new Error(`Session ${sessionKey(sourceRef)} cannot be forked because no session file is tracked.`);
    }

    const branch = sourceManager.getBranch();
    const selectedEntry = resolveForkSourceEntry(branch, sourceSession.messages ?? [], options);
    if (!selectedEntry) {
      const selector =
        options.sourceMessageId !== undefined
          ? `message ${options.sourceMessageId}`
          : options.sourceMessageIndex !== undefined
            ? `rendered message index ${options.sourceMessageIndex}`
            : `user message index ${options.userMessageIndex}`;
      throw new Error(`Cannot fork session ${sessionKey(sourceRef)}: no ${selector}.`);
    }

    return { sourceRecord, sourceFile, branch, selectedEntry };
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
        // The queued-vs-prompt decision was made before the persistSnapshot/emit
        // awaits above; the agent may have finished its turn in that window. A
        // steer/follow-up now would attach to nothing and be silently dropped,
        // so re-check the live streaming state and surface a retryable error
        // instead. The catch below rolls back the optimistic queued entry.
        if (!session.isStreaming) {
          throw new Error(
            "Session finished streaming before the queued message could be delivered. Retry to send it as a new turn.",
          );
        }
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

    try {
      await record.session.abort();
    } catch (error) {
      // Abort is best-effort. Even if the runtime reports a failure we still
      // reset local run state below so the UI does not stay stuck on "running".
      console.warn(`[pi-sdk-driver] abort failed for ${sessionKey(record.ref)}:`, error);
    }

    // Aborting ends the current turn, so any steer/follow-up messages queued
    // against it can never be delivered. Clear both the SDK queue and our
    // mirror so the composer stops showing orphaned pending messages — matching
    // the SDK's own "clear the queue when the user aborts" convention.
    record.session?.clearQueue();
    record.queuedMessages = [];
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

    // The session's own registry, not a shared one: it holds this workspace's
    // extension providers, so the endpoint and credentials resolved here are the
    // ones this workspace registered even if another workspace claims the id.
    const model = requireSessionModel(session.modelRegistry, selection.provider, selection.modelId);
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
      // Guard dispose so a failure still lets us persist and emit sessionClosed
      // below — otherwise the UI never learns the session closed.
      await this.disposeRecordRuntimeSafely(record);
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

    // Dedupe concurrent reopen/create for the same session. Without this, two
    // callers both pass the guard above, both build a runtime across the awaits
    // below, and the second overwrites (and leaks) the first.
    return singleFlight(this.ensureRecordInFlight, key, () => this.createOrReopenRecord(sessionRef, key));
  }

  private async createOrReopenRecord(sessionRef: SessionRef, key: string): Promise<ManagedSessionRecord> {
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

    // Advisory single-writer check: if another live writer already holds this
    // file, refuse to bind so the app can warn instead of blind-forking the
    // conversation. Absent/dead/own leases never block (fully advisory).
    await this.assertSessionNotForeignLeased(sessionFile);

    const runtime = await this.createAgentSessionRuntimeImpl(
      this.baseCreateOptions(workspace.path, SessionManager.open(sessionFile)),
    );
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
      leasePath: undefined,
      transcriptDiskMtimeMs: undefined,
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
    // Release the advisory lease before disposing so another writer can take
    // over promptly. Runs on every teardown path (close/remove/sync/rebind).
    await this.releaseSessionLease(record);
    if (runtime) {
      await runtime.dispose();
      return;
    }
    session?.dispose();
  }

  /**
   * Dispose without letting a failure abort the caller. Used by bulk teardown
   * loops (workspace removal/sync) and closeSession, where one runtime failing
   * to dispose must not skip disposing the rest or skip the sessionClosed emit.
   */
  private async disposeRecordRuntimeSafely(record: ManagedSessionRecord): Promise<void> {
    try {
      await this.disposeRecordRuntime(record);
    } catch (error) {
      console.warn(`[pi-sdk-driver] failed to dispose runtime for ${sessionKey(record.ref)}:`, error);
    }
  }

  /**
   * Throw {@link SessionLeasedError} if a live foreign writer already holds this
   * session file. Absent, corrupt, dead, or our own leases never block — the
   * lease is purely advisory, so any read/stat failure is swallowed.
   */
  private async assertSessionNotForeignLeased(sessionFile: string): Promise<void> {
    const leasePath = sessionLeasePath(sessionFile);
    let snapshot;
    try {
      snapshot = await readLeaseSnapshot(leasePath);
    } catch {
      return;
    }
    if (!snapshot) {
      return;
    }
    const blocks = leaseBlocksBinding(snapshot, {
      now: Date.now(),
      ttlMs: this.leaseTtlMs,
      self: this.leaseIdentity,
      isPidAlive: this.isPidAlive,
    });
    if (blocks) {
      throw new SessionLeasedError(sessionFile, snapshot.info);
    }
  }

  /**
   * Claim (or refresh) the advisory lease for the record's current session file,
   * moving it if the file changed under a rebind. Best-effort: a write failure
   * must not stop the runtime from binding.
   */
  private async acquireSessionLease(record: ManagedSessionRecord): Promise<void> {
    const sessionFile = record.sessionFile;
    if (!sessionFile) {
      return;
    }
    const nextLeasePath = sessionLeasePath(sessionFile);
    if (record.leasePath && record.leasePath !== nextLeasePath) {
      await this.releaseSessionLease(record);
    }
    try {
      await writeLeaseFile(nextLeasePath, buildOwnLease(this.leaseIdentity, Date.now()));
      record.leasePath = nextLeasePath;
    } catch (error) {
      console.warn(`[pi-sdk-driver] failed to write session lease for ${sessionKey(record.ref)}:`, error);
    }
  }

  private async releaseSessionLease(record: ManagedSessionRecord): Promise<void> {
    const leasePath = record.leasePath;
    if (!leasePath) {
      return;
    }
    record.leasePath = undefined;
    try {
      await removeLeaseFile(leasePath);
    } catch (error) {
      console.warn(`[pi-sdk-driver] failed to remove session lease for ${sessionKey(record.ref)}:`, error);
    }
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
      // A rebind (fork/newSession/switch) can point at a different JSONL, so
      // move the lease and reset the disk-tail baseline to the new file.
      await this.refreshLeaseAndTranscriptBaseline(record);
    });
    await this.rebindRuntimeSession(record, runtime.session);
    await this.refreshLeaseAndTranscriptBaseline(record);
  }

  /** Claim the lease and capture the disk-tail baseline for the record's current file. */
  private async refreshLeaseAndTranscriptBaseline(record: ManagedSessionRecord): Promise<void> {
    const [, mtimeMs] = await Promise.all([
      this.acquireSessionLease(record),
      this.statMtimeMs(record.sessionFile),
    ]);
    record.transcriptDiskMtimeMs = mtimeMs;
  }

  private async statMtimeMs(filePath: string | undefined): Promise<number | undefined> {
    if (!filePath) {
      return undefined;
    }
    try {
      return (await stat(filePath)).mtimeMs;
    } catch {
      return undefined;
    }
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
        // switchSession adopts an arbitrary existing JSONL. Refuse before the
        // runtime opens it if a live foreign writer holds it, mirroring the
        // reopen path so this seam can't silently fork a leased session.
        await this.assertSessionNotForeignLeased(sessionPath);
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
    model: PiModelInfo,
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

    record.eventQueue = chainRecoveringEventQueue(
      record.eventQueue,
      async () => {
        if (options?.persistSnapshot !== false) {
          await this.persistSnapshot(record);
        }
        for (const event of events) {
          await this.emit(record, event);
        }
      },
      (error) => {
        // Contain the failure so the queue keeps flowing. A rethrow here would
        // leave record.eventQueue rejected and freeze the session forever.
        console.warn(`[pi-sdk-driver] event queue work failed for ${sessionKey(record.ref)}:`, error);
      },
    );
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
      try {
        await listener(event);
      } catch (error) {
        // Isolate listeners: one throwing must not skip the remaining ones or
        // reject the caller (which would poison the event queue).
        console.warn(`[pi-sdk-driver] session listener failed for ${sessionKey(record.ref)}:`, error);
      }
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
const THINKING_LEVEL_ORDER = ["off", "low", "medium", "high", "xhigh", "max"] as const;
type SessionTreeNodeRecord = ReturnType<SessionManager["getTree"]>[number];
type SessionBranchEntry = ReturnType<SessionManager["getBranch"]>[number];
type SessionMessageBranchEntry = Extract<SessionBranchEntry, { type: "message" }>;

function resolveForkSourceEntry(
  branch: readonly SessionBranchEntry[],
  renderedMessages: readonly unknown[],
  options: ForkSessionOptions,
): SessionMessageBranchEntry | undefined {
  const messageEntries = branch.filter(
    (entry): entry is SessionMessageBranchEntry => entry.type === "message",
  );

  if (options.sourceMessageId) {
    return messageEntries.find((entry) => entry.id === options.sourceMessageId);
  }

  const renderedMessageItems = transcriptFromMessages(renderedMessages).filter(
    (item): item is SessionTranscriptMessage => item.kind === "message",
  );
  if (options.sourceMessageIndex !== undefined) {
    return findBranchEntryForRenderedMessageIndex(branch, renderedMessageItems, options.sourceMessageIndex);
  }

  if (options.userMessageIndex === undefined) {
    return undefined;
  }

  let userMessageIndex = -1;
  const renderedSourceMessageIndex = renderedMessageItems.findIndex((item) => {
    if (item.role !== "user") {
      return false;
    }
    userMessageIndex += 1;
    return userMessageIndex === options.userMessageIndex;
  });
  return renderedSourceMessageIndex === -1
    ? undefined
    : findBranchEntryForRenderedMessageIndex(branch, renderedMessageItems, renderedSourceMessageIndex);
}

function findBranchEntryForRenderedMessageIndex(
  branch: readonly SessionBranchEntry[],
  renderedMessages: readonly SessionTranscriptMessage[],
  targetRenderedIndex: number,
): SessionMessageBranchEntry | undefined {
  if (targetRenderedIndex < 0 || targetRenderedIndex >= renderedMessages.length) {
    return undefined;
  }
  const branchMessages = branch.filter(
    (entry): entry is SessionMessageBranchEntry => entry.type === "message",
  );
  let branchStartIndex = 0;
  for (const [renderedIndex, renderedMessage] of renderedMessages.entries()) {
    if (renderedMessage.role !== "user" && renderedMessage.role !== "assistant") {
      if (renderedIndex === targetRenderedIndex) {
        return undefined;
      }
      continue;
    }
    const branchIndex = branchMessages.findIndex((entry, index) => {
      if (index < branchStartIndex) {
        return false;
      }
      return (
        entry.message.role === renderedMessage.role &&
        messageText(entry.message as unknown as Record<string, unknown>) === renderedMessage.text
      );
    });
    if (branchIndex === -1) {
      return undefined;
    }
    const entry = branchMessages[branchIndex];
    if (renderedIndex === targetRenderedIndex) {
      return entry;
    }
    branchStartIndex = branchIndex + 1;
  }
  return undefined;
}

async function removeIntermediateForkSession(
  sessionFile: string | undefined,
  keepSessionFile: string | undefined,
): Promise<void> {
  if (!sessionFile || (keepSessionFile && resolve(sessionFile) === resolve(keepSessionFile))) {
    return;
  }
  try {
    await unlink(sessionFile);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

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
