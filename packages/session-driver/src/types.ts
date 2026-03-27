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
}

export interface SessionAttachment {
  readonly kind: "image";
  readonly mimeType: string;
  readonly data: string;
  readonly name?: string;
}

export interface SessionConfig {
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
}

export interface SessionModelSelection {
  readonly provider: string;
  readonly modelId: string;
}

export interface SessionMessageInput {
  readonly text: string;
  readonly attachments?: readonly SessionAttachment[];
}

export interface CreateSessionOptions {
  readonly title?: string;
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

export interface SessionClosedEvent extends SessionEventBase {
  readonly type: "sessionClosed";
  readonly reason: "manual" | "ended" | "failed";
}

export type SessionDriverEvent =
  | SessionOpenedEvent
  | SessionUpdatedEvent
  | AssistantDeltaEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolFinishedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | HostUiRequestEvent
  | SessionClosedEvent;

export type SessionEventListener = (event: SessionDriverEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface SessionDriver {
  createSession(workspace: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot>;
  openSession(sessionRef: SessionRef): Promise<SessionSnapshot>;
  archiveSession(sessionRef: SessionRef): Promise<void>;
  unarchiveSession(sessionRef: SessionRef): Promise<void>;
  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void>;
  cancelCurrentRun(sessionRef: SessionRef): Promise<void>;
  setSessionModel(sessionRef: SessionRef, selection: SessionModelSelection): Promise<void>;
  setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string): Promise<void>;
  renameSession(sessionRef: SessionRef, title: string): Promise<void>;
  compactSession(sessionRef: SessionRef, customInstructions?: string): Promise<void>;
  reloadSession(sessionRef: SessionRef): Promise<void>;
  getSessionCommands(sessionRef: SessionRef): Promise<readonly import("./runtime-types.js").RuntimeCommandRecord[]>;
  respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void>;
  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe;
  closeSession(sessionRef: SessionRef): Promise<void>;
}
