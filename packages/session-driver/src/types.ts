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
  readonly children: readonly SessionTreeNodeSnapshot[];
}

export interface SessionTreeSnapshot {
  readonly roots: readonly SessionTreeNodeSnapshot[];
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

export interface AssistantThinkingDeltaEvent extends SessionEventBase {
  readonly type: "assistantThinkingDelta";
  readonly text: string;
}

export interface AssistantThinkingStartedEvent extends SessionEventBase {
  readonly type: "assistantThinkingStarted";
}

export interface AssistantThinkingFinishedEvent extends SessionEventBase {
  readonly type: "assistantThinkingFinished";
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
  | AssistantThinkingStartedEvent
  | AssistantThinkingFinishedEvent
  | AssistantThinkingDeltaEvent
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
  openSession(sessionRef: SessionRef): Promise<SessionSnapshot>;
  archiveSession(sessionRef: SessionRef): Promise<void>;
  unarchiveSession(sessionRef: SessionRef): Promise<void>;
  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void>;
  replaceQueuedMessages(sessionRef: SessionRef, messages: readonly SessionQueuedMessage[]): Promise<void>;
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
  getSessionCommands(sessionRef: SessionRef): Promise<readonly import("./runtime-types.js").RuntimeCommandRecord[]>;
  respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void>;
  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe;
  closeSession(sessionRef: SessionRef): Promise<void>;
}
