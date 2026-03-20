declare module "@mariozechner/pi-coding-agent" {
  export interface SessionManager {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
    appendSessionInfo(name: string): string;
    buildSessionContext(): {
      messages: readonly unknown[];
      thinkingLevel: string;
      model: { provider: string; modelId: string } | null;
    };
    appendThinkingLevelChange(thinkingLevel: string): string;
    appendModelChange(provider: string, modelId: string): string;
  }

  export interface AgentSessionEventMessage {
    role?: string;
    stopReason?: string;
    content?: readonly unknown[] | string;
  }

  export interface AgentSessionAssistantMessageEvent {
    type:
      | "start"
      | "text_start"
      | "text_delta"
      | "text_end"
      | "thinking_start"
      | "thinking_delta"
      | "thinking_end"
      | "toolcall_start"
      | "toolcall_delta"
      | "toolcall_end"
      | "done"
      | "error";
    contentIndex?: number;
    delta?: string;
    content?: string;
    reason?: string;
    partial?: AgentSessionEventMessage;
    message?: AgentSessionEventMessage;
    error?: AgentSessionEventMessage;
    toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  }

  export type AgentSessionEvent =
    | { type: "agent_start" }
    | { type: "agent_end"; messages: readonly AgentSessionEventMessage[] }
    | { type: "turn_start" }
    | { type: "turn_end"; message: AgentSessionEventMessage; toolResults: readonly unknown[] }
    | { type: "message_start"; message: AgentSessionEventMessage }
    | { type: "message_update"; message: AgentSessionEventMessage; assistantMessageEvent: AgentSessionAssistantMessageEvent }
    | { type: "message_end"; message: AgentSessionEventMessage }
    | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
    | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
    | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

  export type AgentSessionEventListener = (event: AgentSessionEvent) => void | Promise<void>;

  export interface AgentSessionMessageInput {
    text: string;
    attachments?: readonly { kind: "image"; mimeType: string; data: string; name?: string }[];
  }

  export interface CreateAgentSessionOptions {
    cwd?: string;
    sessionManager?: SessionManager;
  }

  export interface CreateAgentSessionResult {
    session: AgentSession;
    modelFallbackMessage?: string;
  }

  export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    name?: string;
    created: Date;
    modified: Date;
    messageCount: number;
    firstMessage: string;
    allMessagesText: string;
  }

  export class AgentSession {
    readonly sessionManager: SessionManager;
    readonly sessionId: string;
    readonly sessionFile: string | undefined;
    readonly sessionName: string | undefined;
    readonly isStreaming: boolean;
    readonly messages: readonly unknown[];
    subscribe(listener: AgentSessionEventListener): () => void;
    sendUserMessage(content: string | readonly unknown[], options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
  }

  export class SessionManager {
    static create(cwd: string, sessionDir?: string): SessionManager;
    static open(path: string, sessionDir?: string): SessionManager;
    static inMemory(cwd?: string): SessionManager;
    static list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
    appendSessionInfo(name: string): string;
    appendThinkingLevelChange(thinkingLevel: string): string;
    appendModelChange(provider: string, modelId: string): string;
    buildSessionContext(): {
      messages: readonly unknown[];
      thinkingLevel: string;
      model: { provider: string; modelId: string } | null;
    };
  }

  export function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
}
