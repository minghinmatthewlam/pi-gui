import type { SessionUsageSnapshot } from "./usage.js";
import type { SessionTranscriptCustomMessage } from "./transcript.js";

export type WorkspaceId = string;
export type SessionId = string;
export type RunId = string;
export type Timestamp = string;

export interface WorkspaceRef {
  readonly workspaceId: WorkspaceId;
  readonly path: string;
  readonly displayName?: string;
}

export interface SessionRef {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
}

export type SessionStatus = "idle" | "running" | "failed";

export type SessionMessageDeliveryMode = "steer" | "followUp";

export interface SessionQueuedMessage {
  readonly id: string;
  readonly mode: SessionMessageDeliveryMode;
  readonly text: string;
  readonly attachments?: readonly SessionAttachment[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface SessionSnapshot {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly status: SessionStatus;
  readonly updatedAt: Timestamp;
  readonly archivedAt?: Timestamp;
  readonly preview?: string;
  readonly config?: SessionConfig;
  readonly runningRunId?: RunId;
  readonly queuedMessages?: readonly SessionQueuedMessage[];
  readonly usage?: SessionUsageSnapshot;
}

export interface SessionImageAttachment {
  readonly kind: "image";
  readonly mimeType: string;
  readonly data: string;
  readonly name?: string;
}

export interface SessionFileAttachment {
  readonly kind: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly fsPath: string;
  readonly sizeBytes?: number;
}

export type SessionAttachment = SessionImageAttachment | SessionFileAttachment;

export interface SessionConfig {
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
}

export type SessionTreeNodeKind =
  | "message"
  | "thinking_level_change"
  | "model_change"
  | "usage"
  | "context_edit"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";

export interface SessionTreeNodeSnapshot {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: SessionTreeNodeKind;
  readonly timestamp: Timestamp;
  readonly label?: string;
  readonly role?: string;
  readonly customType?: string;
  readonly title: string;
  readonly preview?: string;
}

/**
 * The session tree as a flat list, in depth-first order: every parent comes before its
 * children, and siblings run oldest first. A node whose parentId is null, its own id, or not
 * in the list is a root. It is flat on purpose: Electron's contextBridge refuses values nested more than
 * 1000 levels deep, and a nested tree gains a level per entry on its longest path.
 */
export interface SessionTreeSnapshot {
  readonly nodes: readonly SessionTreeNodeSnapshot[];
  readonly leafId: string | null;
}

export interface NavigateSessionTreeOptions {
  readonly summarize?: boolean;
  readonly customInstructions?: string;
}

export interface NavigateSessionTreeResult {
  readonly cancelled: boolean;
  readonly aborted?: boolean;
  readonly editorText?: string;
  readonly summaryCreated?: boolean;
}

export interface SessionModelSelection {
  readonly provider: string;
  readonly modelId: string;
}

export interface SessionMessageInput {
  readonly text: string;
  readonly attachments?: readonly SessionAttachment[];
  readonly deliverAs?: SessionMessageDeliveryMode;
}

export interface CreateSessionOptions {
  readonly title?: string;
  readonly initialModel?: SessionModelSelection;
  readonly initialThinkingLevel?: string;
  /** Values for flags the session's extensions registered, applied when pi loads them. */
  readonly extensionFlagValues?: ExtensionFlagValues;
}

/** Extension flag values by flag name, as `pi --name` (boolean) or `pi --name value` (string). */
export type ExtensionFlagValues = Readonly<Record<string, boolean | string>>;

export type ForkPosition = "before" | "at" | "after";

export interface ForkSessionOptions {
  /** Target workspace for the forked session (the source workspace, or a new worktree). */
  readonly targetWorkspace: WorkspaceRef;
  /** ID of the rendered source message selected as the fork point, when it maps to a session entry. */
  readonly sourceMessageId?: string;
  /** 0-based index of the rendered source message selected as the fork point. */
  readonly sourceMessageIndex?: number;
  /** 0-based rendered user-message index kept as a fallback for older callers. */
  readonly userMessageIndex?: number;
  /**
   * "before" (default) forks before the selected user message so it can be edited and
   * re-sent; "at" keeps the selected user message in the forked history.
   */
  readonly position?: ForkPosition;
  /** Optional title for the forked session. Defaults to the source session title. */
  readonly title?: string;
  /** Flag values for the fork's pi session, normally the ones the source started with. */
  readonly extensionFlagValues?: ExtensionFlagValues;
}

export interface ForkSessionResult {
  readonly snapshot: SessionSnapshot;
  /** When forking "before", the text of the selected user message for composer prefill. */
  readonly selectedText?: string;
}

export interface SessionEventBase {
  readonly type: string;
  readonly sessionRef: SessionRef;
  readonly timestamp: Timestamp;
  readonly runId?: RunId;
}

export interface SessionOpenedEvent extends SessionEventBase {
  readonly type: "sessionOpened";
  readonly snapshot: SessionSnapshot;
}

export interface SessionUpdatedEvent extends SessionEventBase {
  readonly type: "sessionUpdated";
  readonly snapshot: SessionSnapshot;
}

export interface AssistantDeltaEvent extends SessionEventBase {
  readonly type: "assistantDelta";
  readonly text: string;
}

/** Finalizes one assistant message while the containing run may continue. */
export interface AssistantMessageEndedEvent extends SessionEventBase {
  readonly type: "assistantMessageEnded";
}

/** Identifies the immediately preceding ended assistant message after Pi persists it. */
export interface AssistantMessagePersistedEvent extends SessionEventBase {
  readonly type: "assistantMessagePersisted";
  readonly sourceMessageId: string;
}

/**
 * A persisted transcript item that arrives outside the assistant stream, such as an
 * extension's custom message. `item.id` is the pi entry id, matching a later reload.
 */
export interface TranscriptItemAppendedEvent extends SessionEventBase {
  readonly type: "transcriptItemAppended";
  readonly item: SessionTranscriptCustomMessage;
}

export interface QueuedMessageStartedEvent extends SessionEventBase {
  readonly type: "queuedMessageStarted";
  readonly message: SessionQueuedMessage;
}

export interface ToolStartedEvent extends SessionEventBase {
  readonly type: "toolStarted";
  readonly toolName: string;
  readonly callId: string;
  readonly input?: unknown;
}

export interface ToolUpdatedEvent extends SessionEventBase {
  readonly type: "toolUpdated";
  readonly callId: string;
  readonly text?: string;
  readonly progress?: number;
}

export interface ToolFinishedEvent extends SessionEventBase {
  readonly type: "toolFinished";
  readonly callId: string;
  readonly success: boolean;
  readonly output?: unknown;
}

export interface RunCompletedEvent extends SessionEventBase {
  readonly type: "runCompleted";
  readonly snapshot: SessionSnapshot;
}

export interface SessionErrorInfo {
  readonly message: string;
  readonly code?: string;
  readonly details?: unknown;
}

export interface ExtensionCompatibilityIssue {
  readonly capability: string;
  readonly classification: "terminal-only";
  readonly message: string;
  readonly extensionPath?: string;
  readonly eventName?: string;
}

export interface RunFailedEvent extends SessionEventBase {
  readonly type: "runFailed";
  readonly error: SessionErrorInfo;
}

export type HostUiResponse =
  | {
      readonly requestId: string;
      readonly value: string;
    }
  | {
      readonly requestId: string;
      readonly confirmed: boolean;
    }
  | {
      readonly requestId: string;
      readonly cancelled: true;
    };

export type HostUiRequest =
  | {
      readonly kind: "confirm";
      readonly requestId: string;
      readonly title: string;
      readonly message: string;
      readonly defaultValue?: boolean;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "input";
      readonly requestId: string;
      readonly title: string;
      readonly placeholder?: string;
      readonly initialValue?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "select";
      readonly requestId: string;
      readonly title: string;
      readonly options: readonly string[];
      readonly allowMultiple?: boolean;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "editor";
      readonly requestId: string;
      readonly title: string;
      readonly initialValue?: string;
    }
  | {
      readonly kind: "notify";
      readonly requestId: string;
      readonly message: string;
      readonly level?: "info" | "warning" | "error";
    }
  | {
      readonly kind: "status";
      readonly requestId: string;
      readonly key: string;
      readonly text?: string;
    }
  | {
      readonly kind: "widget";
      readonly requestId: string;
      readonly key: string;
      readonly lines?: readonly string[];
      readonly placement?: "aboveComposer" | "belowComposer";
    }
  | {
      readonly kind: "title";
      readonly requestId: string;
      readonly title: string;
    }
  | {
      readonly kind: "editorText";
      readonly requestId: string;
      readonly text: string;
    }
  | {
      readonly kind: "reset";
      readonly requestId: string;
    };

export interface HostUiRequestEvent extends SessionEventBase {
  readonly type: "hostUiRequest";
  readonly request: HostUiRequest;
}

export interface ExtensionCompatibilityIssueEvent extends SessionEventBase {
  readonly type: "extensionCompatibilityIssue";
  readonly issue: ExtensionCompatibilityIssue;
}

export interface SessionClosedEvent extends SessionEventBase {
  readonly type: "sessionClosed";
  readonly reason: "manual" | "ended" | "failed";
}

export type SessionDriverEvent =
  | SessionOpenedEvent
  | SessionUpdatedEvent
  | AssistantDeltaEvent
  | AssistantMessageEndedEvent
  | AssistantMessagePersistedEvent
  | TranscriptItemAppendedEvent
  | QueuedMessageStartedEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolFinishedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | HostUiRequestEvent
  | ExtensionCompatibilityIssueEvent
  | SessionClosedEvent;

export type SessionEventListener = (event: SessionDriverEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface SessionDriver {
  createSession(workspace: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot>;
  validateForkSession(sourceRef: SessionRef, options: ForkSessionOptions): Promise<void>;
  forkSession(sourceRef: SessionRef, options: ForkSessionOptions): Promise<ForkSessionResult>;
  openSession(sessionRef: SessionRef): Promise<SessionSnapshot>;
  archiveSession(sessionRef: SessionRef): Promise<void>;
  unarchiveSession(sessionRef: SessionRef): Promise<void>;
  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void>;
  replaceQueuedMessages(
    sessionRef: SessionRef,
    messages: readonly SessionQueuedMessage[],
  ): Promise<void>;
  cancelCurrentRun(sessionRef: SessionRef): Promise<void>;
  setSessionModel(sessionRef: SessionRef, selection: SessionModelSelection): Promise<void>;
  setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string): Promise<void>;
  renameSession(sessionRef: SessionRef, title: string): Promise<void>;
  compactSession(sessionRef: SessionRef, customInstructions?: string): Promise<void>;
  reloadSession(sessionRef: SessionRef): Promise<void>;
  getSessionTree(sessionRef: SessionRef): Promise<SessionTreeSnapshot>;
  navigateSessionTree(
    sessionRef: SessionRef,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ): Promise<NavigateSessionTreeResult>;
  getSessionCommands(
    sessionRef: SessionRef,
  ): Promise<readonly import("./runtime-types.js").RuntimeCommandRecord[]>;
  respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void>;
  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe;
  closeSession(sessionRef: SessionRef): Promise<void>;
}

export interface SessionSchemaInfo {
  /**
   * The session file's header version. `undefined` when the file has no
   * readable session header (e.g. missing/corrupt), in which case skew cannot
   * be determined and is assumed absent.
   */
  readonly fileSchemaVersion: number | undefined;
  /** The bundled runtime's schema version. */
  readonly runtimeSchemaVersion: number;
  /** True when the file was written by a newer pi than the bundled runtime. */
  readonly writtenByNewerRuntime: boolean;
}
