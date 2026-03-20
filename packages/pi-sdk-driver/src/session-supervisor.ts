import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type SessionInfo,
} from "@mariozechner/pi-coding-agent";
import type { SessionCatalogSnapshot, WorkspaceCatalogSnapshot } from "@pi-app/catalogs";
import type {
  CreateSessionOptions,
  SessionDriverEvent,
  SessionEventListener,
  SessionMessageInput,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  Unsubscribe,
  WorkspaceId,
  WorkspaceRef,
} from "@pi-app/session-driver";
import { JsonCatalogStore, type SessionFileCatalogStorage } from "./json-catalog-store.js";
import {
  buildSnapshot,
  createWorkspaceRef,
  deriveWorkspaceTitle,
  determineRunOutcome,
  extractPreview,
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
}

export interface SyncWorkspaceResult {
  readonly workspace: WorkspaceRef;
  readonly sessions: SessionCatalogSnapshot["sessions"];
}

interface ManagedSessionRecord {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  title: string;
  session: AgentSession | undefined;
  sessionFile: string | undefined;
  status: SessionStatus;
  updatedAt: string;
  preview: string | undefined;
  runningRunId: string | undefined;
  closed: boolean;
  listeners: Set<SessionEventListener>;
  eventQueue: Promise<void>;
  unsubscribeAgent: (() => void) | undefined;
}

export class SessionSupervisor {
  private readonly catalogs: SessionFileCatalogStorage;
  private readonly createAgentSessionImpl: (options?: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
  private readonly records = new Map<string, ManagedSessionRecord>();

  constructor(options: PiSdkDriverOptions = {}) {
    this.catalogs = options.catalogFilePath
      ? new JsonCatalogStore({ catalogFilePath: options.catalogFilePath })
      : new JsonCatalogStore();
    this.createAgentSessionImpl = options.createAgentSessionImpl ?? ((createOptions) => createAgentSession(createOptions));
  }

  listWorkspaces(): Promise<WorkspaceCatalogSnapshot> {
    return this.catalogs.workspaces.listWorkspaces();
  }

  listSessions(workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot> {
    return this.catalogs.sessions.listSessions(workspaceId);
  }

  async registerWorkspace(path: string, displayName?: string): Promise<WorkspaceRef> {
    const workspace = createWorkspaceRef(path, displayName);
    await this.touchWorkspace(workspace);
    return workspace;
  }

  async syncWorkspace(path: string, displayName?: string): Promise<SyncWorkspaceResult> {
    const workspace = await this.registerWorkspace(path, displayName);
    const infos = await SessionManager.list(path);
    const existingSessions = (await this.catalogs.sessions.listSessions(workspace.workspaceId)).sessions;
    const nextEntries = infos.map((info) => this.sessionEntryFromInfo(workspace, info));
    const discoveredKeys = new Set(nextEntries.map((entry) => sessionKey(entry.sessionRef)));
    const nextSessionFiles = Object.fromEntries(nextEntries.map((entry, index) => [sessionKey(entry.sessionRef), infos[index]?.path ?? ""]));

    await this.catalogs.replaceWorkspaceSessions(workspace.workspaceId, nextEntries, nextSessionFiles);
    for (const session of existingSessions) {
      const key = sessionKey(session.sessionRef);
      if (discoveredKeys.has(key)) {
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

  async getTranscript(sessionRef: SessionRef): Promise<SessionTranscriptMessage[]> {
    const record = await this.ensureRecord(sessionRef);
    return transcriptFromMessages(record.session?.messages ?? [], record.updatedAt);
  }

  async createSession(workspace: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot> {
    await this.touchWorkspace(workspace);

    const { session } = await this.createAgentSessionImpl({
      cwd: workspace.path,
      sessionManager: SessionManager.create(workspace.path),
    });

    const record = this.createRecord(workspace, session, options?.title ?? deriveWorkspaceTitle(workspace));
    const sessionFile = record.sessionFile ?? session.sessionManager.getSessionFile();
    if (sessionFile) {
      record.sessionFile = sessionFile;
      await this.catalogs.setSessionFile(record.ref, sessionFile);
    }

    this.records.set(sessionKey(record.ref), record);
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

  async sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
    const record = await this.ensureRecord(sessionRef);
    if (!record.session) {
      throw new Error(`Session ${sessionKey(sessionRef)} is not active.`);
    }
    if (record.session.isStreaming) {
      throw new Error("Session is already streaming. TODO: expose steer/follow-up queueing on the driver API.");
    }

    const runId = crypto.randomUUID();
    record.runningRunId = runId;
    record.status = "running";
    record.updatedAt = nowIso();
    record.preview = truncate(input.text);
    await this.persistSnapshot(record);
    await this.emit(record, sessionUpdatedEvent(record));

    try {
      const content = input.attachments?.length
        ? [
            { type: "text" as const, text: input.text },
            ...input.attachments.map((attachment) => ({
              type: "image" as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
            })),
          ]
        : input.text;

      await record.session.sendUserMessage(content);
    } catch (error) {
      record.runningRunId = undefined;
      record.status = "failed";
      record.updatedAt = nowIso();
      record.preview = error instanceof Error ? error.message : String(error);
      await this.persistSnapshot(record);
      await this.emit(record, {
        type: "runFailed",
        sessionRef: record.ref,
        timestamp: nowIso(),
        error: toSessionErrorInfo(error, "SEND_FAILED"),
        runId,
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

  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
    const record = this.records.get(sessionKey(sessionRef));
    if (!record) {
      throw new Error(`Unknown session ${sessionKey(sessionRef)}.`);
    }

    record.listeners.add(listener);
    void Promise.resolve(listener(sessionUpdatedEvent(record))).catch(() => {});

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
    });

    const record = existing ?? this.createRecord(workspaceToRef(workspace), session, sessionEntry.title);
    record.session = session;
    record.sessionFile = sessionFile;
    record.title = sessionEntry.title;
    record.status = sessionEntry.status;
    record.updatedAt = sessionEntry.updatedAt;
    record.preview = sessionEntry.previewSnippet ?? undefined;
    record.closed = false;

    record.unsubscribeAgent?.();
    record.unsubscribeAgent = session.subscribe((event) => {
      void this.handleAgentEvent(record, event);
    });

    this.records.set(key, record);
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
      preview: undefined,
      runningRunId: undefined,
      closed: false,
      listeners: new Set<SessionEventListener>(),
      eventQueue: Promise.resolve(),
      unsubscribeAgent: undefined,
    };

    record.unsubscribeAgent = session.subscribe((event) => {
      void this.handleAgentEvent(record, event);
    });
    return record;
  }

  private async handleAgentEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
    const mapped = this.mapAgentEvent(record, event);
    if (mapped.length === 0) {
      return;
    }

    record.eventQueue = record.eventQueue.then(async () => {
      await this.persistSnapshot(record);
      for (const next of mapped) {
        await this.emit(record, next);
      }
    });
    record.eventQueue.catch(() => {});
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
          const base = {
            type: "assistantDelta" as const,
            sessionRef: record.ref,
            timestamp,
            text: event.assistantMessageEvent.delta ?? "",
          };
          return record.runningRunId
            ? [{ ...base, runId: record.runningRunId }, sessionUpdatedEvent(record)]
            : [base, sessionUpdatedEvent(record)];
        }
        return [sessionUpdatedEvent(record)];
      case "tool_execution_start": {
        record.status = "running";
        record.updatedAt = timestamp;
        const base = {
          type: "toolStarted" as const,
          sessionRef: record.ref,
          timestamp,
          toolName: event.toolName,
          callId: event.toolCallId,
          input: event.args,
        };
        return record.runningRunId ? [{ ...base, runId: record.runningRunId }, sessionUpdatedEvent(record)] : [base, sessionUpdatedEvent(record)];
      }
      case "tool_execution_update": {
        record.updatedAt = timestamp;
        const base = {
          type: "toolUpdated" as const,
          sessionRef: record.ref,
          timestamp,
          callId: event.toolCallId,
          ...(typeof event.partialResult === "string" ? { text: event.partialResult } : {}),
          ...(typeof event.partialResult === "number" ? { progress: event.partialResult } : {}),
        };
        return record.runningRunId ? [{ ...base, runId: record.runningRunId }, sessionUpdatedEvent(record)] : [base, sessionUpdatedEvent(record)];
      }
      case "tool_execution_end": {
        record.updatedAt = timestamp;
        const base = {
          type: "toolFinished" as const,
          sessionRef: record.ref,
          timestamp,
          callId: event.toolCallId,
          success: !event.isError,
          output: event.result,
        };
        return record.runningRunId ? [{ ...base, runId: record.runningRunId }, sessionUpdatedEvent(record)] : [base, sessionUpdatedEvent(record)];
      }
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

        const base = outcome.success
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
            };
        return runId ? [{ ...base, runId }, sessionUpdatedEvent(record)] : [base, sessionUpdatedEvent(record)];
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
      ...(snapshot.preview !== undefined ? { previewSnippet: snapshot.preview } : {}),
      ...(record.sessionFile ? { sessionFilePath: record.sessionFile } : {}),
    });
    if (record.sessionFile) {
      await this.catalogs.setSessionFile(record.ref, record.sessionFile);
    }
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

  private sessionEntryFromInfo(workspace: WorkspaceRef, info: SessionInfo) {
    const preview = previewFromSessionInfo(info);
    return {
      sessionRef: {
        workspaceId: workspace.workspaceId,
        sessionId: info.id,
      },
      workspaceId: workspace.workspaceId,
      title: titleFromSessionInfo(info),
      updatedAt: info.modified.toISOString(),
      status: "idle" as const,
      ...(preview ? { previewSnippet: preview } : {}),
      sessionFilePath: info.path,
    };
  }
}

function sessionUpdatedEvent(record: ManagedSessionRecord): SessionDriverEvent {
  return {
    type: "sessionUpdated",
    sessionRef: record.ref,
    timestamp: record.updatedAt,
    snapshot: buildSnapshot(record),
  };
}
