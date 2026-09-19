import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const createChildThreadToolName = "create_child_thread";
export const createChildThreadAction = "pi_gui_create_child_thread";
export const listThreadsToolName = "list_threads";
export const listThreadsAction = "pi_gui_list_threads";
export const readThreadToolName = "read_thread";
export const readThreadAction = "pi_gui_read_thread";
export const sendMessageToThreadToolName = "send_message_to_thread";
export const sendMessageToThreadAction = "pi_gui_send_message_to_thread";

export interface CreateChildThreadToolDetails {
  readonly action: typeof createChildThreadAction;
  readonly prompt: string;
  readonly childThreadId?: string;
  readonly childWorkspaceId?: string;
  readonly childSessionId?: string;
  readonly title?: string;
  readonly deliveryStatus?: "running" | "responded";
  readonly error?: string;
}

export interface OrchestrationThreadListEntry {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly relationship: "current" | "child" | "workspace";
  readonly updatedAt: string;
  readonly preview: string;
  readonly childThreadId?: string;
  readonly supervisionGate?: "continue" | "wake" | "stop";
  readonly supervisionReason?: string;
  readonly nextSupervisionRunAt?: string;
}

export interface OrchestrationThreadTranscriptMessage {
  readonly id: string;
  readonly role: "parent" | "child" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export interface ListThreadsToolDetails {
  readonly action: typeof listThreadsAction;
  readonly threads?: readonly OrchestrationThreadListEntry[];
  readonly error?: string;
}

export interface ReadThreadToolDetails {
  readonly action: typeof readThreadAction;
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly childThreadId?: string;
  readonly goal?: string;
  readonly messages?: readonly OrchestrationThreadTranscriptMessage[];
  readonly error?: string;
}

export interface SendMessageToThreadToolDetails {
  readonly action: typeof sendMessageToThreadAction;
  readonly threadId: string;
  readonly message: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly status?: "queued" | "sent";
  readonly queuedMessageCount?: number;
  readonly error?: string;
}

export interface OrchestrationRuntimeBridge {
  readonly createChildThread: (
    ctx: ExtensionContext,
    input: { readonly prompt: string; readonly toolCallId: string },
  ) => Promise<AgentToolResult<CreateChildThreadToolDetails>>;
  readonly listThreads: (ctx: ExtensionContext) => Promise<AgentToolResult<ListThreadsToolDetails>>;
  readonly readThread: (
    ctx: ExtensionContext,
    threadId: string,
  ) => Promise<AgentToolResult<ReadThreadToolDetails>>;
  readonly sendMessageToThread: (
    ctx: ExtensionContext,
    input: { readonly threadId: string; readonly message: string },
  ) => Promise<AgentToolResult<SendMessageToThreadToolDetails>>;
}

type OrchestrationToolDetails =
  | CreateChildThreadToolDetails
  | ListThreadsToolDetails
  | ReadThreadToolDetails
  | SendMessageToThreadToolDetails;

function createCreateChildThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: createChildThreadToolName,
    label: "Create child thread",
    description:
      "Start a separate pi-gui child thread for a delegated investigation or implementation task.",
    promptSnippet: "create_child_thread: start a separate pi-gui child thread for delegated work.",
    promptGuidelines: [
      "Use create_child_thread when the user asks you to spin up, delegate to, or run a separate child thread.",
      "Keep the child prompt concrete and self-contained so the user can inspect the resulting thread.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Concrete instructions for the child thread.",
        },
      },
      required: ["prompt"],
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const prompt = createChildThreadPromptFromParams(params);
      if (!prompt) {
        throw new Error("create_child_thread requires a non-empty prompt.");
      }
      return bridge.createChildThread(ctx, { prompt, toolCallId });
    },
  };
}

function createListThreadsTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: listThreadsToolName,
    label: "List threads",
    description: "List pi-gui threads visible to the current workspace and parent thread.",
    promptSnippet:
      "list_threads: list relevant pi-gui threads for the current workspace and parent context.",
    promptGuidelines: [
      "Use list_threads before reading or messaging another pi-gui thread when you need the exact thread id.",
      "Use the returned thread id with read_thread or send_message_to_thread.",
    ],
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return bridge.listThreads(ctx);
    },
  };
}

function createReadThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: readThreadToolName,
    label: "Read thread",
    description: "Read a pi-gui thread transcript or child thread summary by id.",
    promptSnippet: "read_thread: read a pi-gui thread transcript by id.",
    promptGuidelines: [
      "Use read_thread with a thread id returned by list_threads or create_child_thread.",
      "Prefer reading a child thread before summarizing its status back to the parent.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id, child thread id, or session id to read.",
        },
      },
      required: ["thread_id"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      if (!threadId) {
        return {
          content: [{ type: "text", text: "read_thread requires a thread_id." }],
          details: {
            action: readThreadAction,
            threadId: "",
            error: "read_thread requires a thread_id.",
          },
        };
      }
      return bridge.readThread(ctx, threadId);
    },
  };
}

function createSendMessageToThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: sendMessageToThreadToolName,
    label: "Send message to thread",
    description: "Send a follow-up message to an existing pi-gui thread.",
    promptSnippet: "send_message_to_thread: send a follow-up to an existing pi-gui thread.",
    promptGuidelines: [
      "Use send_message_to_thread to follow up with an existing child or sibling pi-gui thread.",
      "Use a thread id returned by list_threads or create_child_thread.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id, child thread id, or session id to message.",
        },
        message: {
          type: "string",
          description: "Follow-up message to send.",
        },
      },
      required: ["thread_id", "message"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      const message = messageFromParams(params);
      if (!threadId || !message) {
        return {
          content: [
            { type: "text", text: "send_message_to_thread requires thread_id and message." },
          ],
          details: {
            action: sendMessageToThreadAction,
            threadId: threadId ?? "",
            message: message ?? "",
            error: "send_message_to_thread requires thread_id and message.",
          },
        };
      }
      return bridge.sendMessageToThread(ctx, { threadId, message });
    },
  };
}

export function createOrchestrationRuntimeTools(
  bridge: OrchestrationRuntimeBridge,
): readonly ToolDefinition<any, OrchestrationToolDetails>[] {
  return [
    createCreateChildThreadTool(bridge),
    createListThreadsTool(bridge),
    createReadThreadTool(bridge),
    createSendMessageToThreadTool(bridge),
  ];
}

export function createOrchestrationRuntimeExtension(
  bridge: OrchestrationRuntimeBridge,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createOrchestrationRuntimeTools(bridge)) {
      pi.registerTool(tool);
    }
  };
}

export function createChildThreadPromptFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  return prompt || undefined;
}

export function createChildThreadPromptFromToolOutput(output: unknown): string | undefined {
  if (!isRecord(output) || !isRecord(output.details)) {
    return undefined;
  }
  if (output.details.action !== createChildThreadAction) {
    return undefined;
  }
  return createChildThreadPromptFromParams(output.details);
}

export function listThreadsRequestedFromToolOutput(output: unknown): boolean {
  return toolOutputDetails(output)?.action === listThreadsAction;
}

export function readThreadIdFromToolOutput(output: unknown): string | undefined {
  const details = toolOutputDetails(output);
  if (details?.action !== readThreadAction) {
    return undefined;
  }
  return threadIdFromParams(details);
}

export function sendMessageToThreadFromToolOutput(
  output: unknown,
): { readonly threadId: string; readonly message: string } | undefined {
  const details = toolOutputDetails(output);
  if (details?.action !== sendMessageToThreadAction) {
    return undefined;
  }
  const threadId = threadIdFromParams(details);
  const message = messageFromParams(details);
  if (!threadId || !message) {
    return undefined;
  }
  return { threadId, message };
}

function toolOutputDetails(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output) || !isRecord(output.details)) {
    return undefined;
  }
  return output.details;
}

function threadIdFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const threadId =
    stringParam(params, "thread_id") ??
    stringParam(params, "threadId") ??
    stringParam(params, "id");
  return threadId || undefined;
}

function messageFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const message = stringParam(params, "message") ?? stringParam(params, "text");
  return message || undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
