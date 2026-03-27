declare module "@pi-gui/session-driver" {
  export type WorkspaceId = string;
  export type SessionId = string;
  export type RunId = string;
  export type Timestamp = string;
  export type RuntimeSourceScope = "user" | "project" | "temporary";
  export type RuntimeSourceOrigin = "package" | "top-level";
  export type RuntimeCommandSource = "extension" | "prompt" | "skill";

  export interface RuntimeSourceInfo {
    readonly path: string;
    readonly source: string;
    readonly scope: RuntimeSourceScope;
    readonly origin: RuntimeSourceOrigin;
    readonly baseDir?: string;
  }

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

  export interface SessionErrorInfo {
    readonly message: string;
    readonly code?: string;
    readonly details?: unknown;
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

  export interface RuntimeExtensionDiagnostic {
    readonly type: "warning" | "error" | "collision";
    readonly message: string;
    readonly path?: string;
  }

  export interface RuntimeExtensionRecord {
    readonly path: string;
    readonly displayName: string;
    readonly enabled: boolean;
    readonly sourceInfo: RuntimeSourceInfo;
    readonly commands: readonly string[];
    readonly tools: readonly string[];
    readonly flags: readonly string[];
    readonly shortcuts: readonly string[];
    readonly diagnostics: readonly RuntimeExtensionDiagnostic[];
  }

  export interface RuntimeCommandRecord {
    readonly name: string;
    readonly description?: string;
    readonly source: RuntimeCommandSource;
    readonly sourceInfo: RuntimeSourceInfo;
  }

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
    getSessionCommands(sessionRef: SessionRef): Promise<readonly RuntimeCommandRecord[]>;
    respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void>;
    subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe;
    closeSession(sessionRef: SessionRef): Promise<void>;
  }
}

declare module "@pi-gui/session-driver/runtime-types" {
  import type { WorkspaceRef } from "@pi-gui/session-driver";

  export type RuntimeAuthType = "oauth" | "api_key" | "none";
  export type RuntimeSourceScope = "user" | "project" | "temporary";
  export type RuntimeSourceOrigin = "package" | "top-level";
  export type RuntimeCommandSource = "extension" | "prompt" | "skill";

  export interface RuntimeSourceInfo {
    readonly path: string;
    readonly source: string;
    readonly scope: RuntimeSourceScope;
    readonly origin: RuntimeSourceOrigin;
    readonly baseDir?: string;
  }

  export interface RuntimeProviderRecord {
    readonly id: string;
    readonly name: string;
    readonly hasAuth: boolean;
    readonly authType: RuntimeAuthType;
    readonly oauthSupported: boolean;
  }

  export interface RuntimeModelRecord {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelId: string;
    readonly label: string;
    readonly available: boolean;
    readonly authType: RuntimeAuthType;
    readonly reasoning: boolean;
    readonly supportsImages: boolean;
  }

  export interface RuntimeSkillRecord {
    readonly name: string;
    readonly description: string;
    readonly filePath: string;
    readonly baseDir: string;
    readonly source: string;
    readonly enabled: boolean;
    readonly disableModelInvocation: boolean;
    readonly slashCommand: string;
  }

  export interface RuntimeExtensionDiagnostic {
    readonly type: "warning" | "error" | "collision";
    readonly message: string;
    readonly path?: string;
  }

  export interface RuntimeExtensionRecord {
    readonly path: string;
    readonly displayName: string;
    readonly enabled: boolean;
    readonly sourceInfo: RuntimeSourceInfo;
    readonly commands: readonly string[];
    readonly tools: readonly string[];
    readonly flags: readonly string[];
    readonly shortcuts: readonly string[];
    readonly diagnostics: readonly RuntimeExtensionDiagnostic[];
  }

  export interface RuntimeCommandRecord {
    readonly name: string;
    readonly description?: string;
    readonly source: RuntimeCommandSource;
    readonly sourceInfo: RuntimeSourceInfo;
  }

  export interface RuntimeSettingsSnapshot {
    readonly defaultProvider?: string;
    readonly defaultModelId?: string;
    readonly defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    readonly enableSkillCommands: boolean;
    readonly enabledModelPatterns: readonly string[];
  }

  export interface RuntimeLoginAuthInfo {
    readonly url: string;
    readonly instructions?: string;
  }

  export interface RuntimeLoginPrompt {
    readonly message: string;
    readonly placeholder?: string;
    readonly allowEmpty?: boolean;
  }

  export interface RuntimeLoginCallbacks {
    readonly onAuth: (info: RuntimeLoginAuthInfo) => void | Promise<void>;
    readonly onPrompt: (prompt: RuntimeLoginPrompt) => Promise<string>;
    readonly onProgress?: (message: string) => void | Promise<void>;
    readonly onManualCodeInput?: () => Promise<string>;
    readonly signal?: AbortSignal;
  }

  export interface RuntimeSnapshot {
    readonly workspace: WorkspaceRef;
    readonly providers: readonly RuntimeProviderRecord[];
    readonly models: readonly RuntimeModelRecord[];
    readonly skills: readonly RuntimeSkillRecord[];
    readonly extensions: readonly RuntimeExtensionRecord[];
    readonly settings: RuntimeSettingsSnapshot;
  }

  export interface RuntimeResourceDriver {
    getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot>;
    refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot>;
    login(workspace: WorkspaceRef, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<RuntimeSnapshot>;
    logout(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot>;
    setDefaultModel(
      workspace: WorkspaceRef,
      selection: {
        readonly provider: string;
        readonly modelId: string;
      },
    ): Promise<RuntimeSnapshot>;
    setDefaultThinkingLevel(
      workspace: WorkspaceRef,
      thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
    ): Promise<RuntimeSnapshot>;
    setEnableSkillCommands(workspace: WorkspaceRef, enabled: boolean): Promise<RuntimeSnapshot>;
    setScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot>;
    setSkillEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot>;
    setExtensionEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot>;
  }
}
