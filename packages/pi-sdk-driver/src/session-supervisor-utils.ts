import { basename } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type {
  SessionAttachment,
  SessionConfig,
  SessionErrorInfo,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { SessionQueuedMessage } from "@pi-gui/session-driver/types";
import type { SessionTranscriptAttachment, SessionTranscriptMessage } from "./transcript.js";

const FILE_ATTACHMENT_BLOCK_START = "<pi-gui-file-attachments>";
const FILE_ATTACHMENT_BLOCK_END = "</pi-gui-file-attachments>";

export interface SnapshotSource {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly status: SessionStatus;
  readonly updatedAt: string;
  readonly archivedAt: string | undefined;
  readonly preview: string | undefined;
  readonly config: SessionConfig | undefined;
  readonly runningRunId: string | undefined;
  readonly queuedMessages: readonly SessionQueuedMessage[];
}

export function buildSnapshot(source: SnapshotSource): SessionSnapshot {
  return {
    ref: { ...source.ref },
    workspace: { ...source.workspace },
    title: source.title.trim() || deriveWorkspaceTitle(source.workspace),
    status: source.status,
    updatedAt: source.updatedAt,
    ...(source.archivedAt !== undefined ? { archivedAt: source.archivedAt } : {}),
    ...(source.preview !== undefined ? { preview: source.preview } : {}),
    ...(source.config ? { config: source.config } : {}),
    ...(source.runningRunId !== undefined ? { runningRunId: source.runningRunId } : {}),
    ...(source.queuedMessages.length > 0
      ? {
          queuedMessages: source.queuedMessages.map((message) => ({
            ...message,
            ...(message.attachments
              ? {
                  attachments: message.attachments.map((attachment: SessionAttachment) => ({ ...attachment })),
                }
              : {}),
          })),
        }
      : {}),
  };
}

export function deriveSessionConfig(sessionManager: {
  buildSessionContext(): {
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}): SessionConfig | undefined {
  const context = sessionManager.buildSessionContext();
  const config: SessionConfig = {
    ...(context.model ? { provider: context.model.provider, modelId: context.model.modelId } : {}),
    ...(context.thinkingLevel && context.thinkingLevel !== "off" ? { thinkingLevel: context.thinkingLevel } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export function forcePersistSession(sessionManager: object): void {
  const maybeRewrite = (sessionManager as { _rewriteFile?: () => void })._rewriteFile;
  maybeRewrite?.call(sessionManager);
}

export function sessionKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

export function workspaceToRef(workspace: { workspaceId: string; path: string; displayName: string }): WorkspaceRef {
  return {
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    displayName: workspace.displayName,
  };
}

export function deriveWorkspaceTitle(workspace: WorkspaceRef): string {
  return workspace.displayName?.trim() || basename(workspace.path) || workspace.path;
}

export function createWorkspaceRef(path: string, displayName?: string): WorkspaceRef {
  return {
    workspaceId: path,
    path,
    ...(displayName ? { displayName } : {}),
  };
}

export function titleFromSessionInfo(info: SessionInfo): string {
  const preferred = info.name?.trim();
  if (preferred) {
    return preferred;
  }

  const firstMessage = truncate(info.firstMessage, 72);
  if (firstMessage) {
    return firstMessage;
  }

  return basename(info.cwd || info.path);
}

export function previewFromSessionInfo(info: SessionInfo): string | undefined {
  const text = truncate(info.firstMessage || info.allMessagesText, 140);
  return text || undefined;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function extractPreview(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const text = messageText(message);
  if (text) {
    return truncate(text);
  }

  if (typeof message.stopReason === "string" && typeof message.errorMessage === "string") {
    return truncate(message.errorMessage);
  }

  return undefined;
}

export function determineRunOutcome(messages: readonly unknown[]): {
  success: boolean;
  error?: SessionErrorInfo;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "error" || stopReason === "aborted") {
      const messageText =
        typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
          ? message.errorMessage
          : stopReason === "aborted"
            ? "Run aborted"
            : "Run failed";
      return {
        success: false,
        error: {
          message: messageText,
          code: stopReason.toUpperCase(),
        },
      };
    }
    break;
  }

  return { success: true };
}

export function toSessionErrorInfo(error: unknown, code: string): SessionErrorInfo {
  if (error instanceof Error) {
    return {
      message: error.message,
      code,
      details: {
        name: error.name,
        stack: error.stack,
      },
    };
  }

  return {
    message: typeof error === "string" ? error : "Unknown error",
    code,
    details: error,
  };
}

export function truncate(value: string, limit = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

export function injectFileAttachmentPreamble(
  text: string,
  attachments: readonly SessionAttachment[] | undefined,
): string {
  const files = attachments?.filter((attachment): attachment is Extract<SessionAttachment, { readonly kind: "file" }> => attachment.kind === "file") ?? [];
  if (files.length === 0) {
    return text;
  }

  const payload = JSON.stringify({
    version: 1,
    files: files.map((attachment) => ({
      kind: "file" as const,
      name: attachment.name,
      mimeType: attachment.mimeType,
      fsPath: attachment.fsPath,
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    })),
  });
  const block = `${FILE_ATTACHMENT_BLOCK_START}${payload}${FILE_ATTACHMENT_BLOCK_END}`;
  return text ? `${block}\n${text}` : block;
}

export function transcriptFromMessages(messages: readonly unknown[], fallbackTimestamp = nowIso()): SessionTranscriptMessage[] {
  const transcript: SessionTranscriptMessage[] = [];

  for (const [index, message] of messages.entries()) {
    if (!isRecord(message)) {
      continue;
    }

    const role = message.role;
    if (role !== "user" && role !== "assistant" && role !== "branchSummary" && role !== "compactionSummary") {
      continue;
    }

    const text = messageText(message);
    const attachments = messageAttachments(message);
    if (!text) {
      if (attachments.length === 0) {
        continue;
      }
    }

    const reasoningText = extractReasoning(message);
    if (reasoningText) {
      console.log(`[pi-sdk-driver] Extracted reasoning for message ${message.id || 'unknown'}: ${reasoningText.slice(0, 100)}...`);
    }

    transcript.push({
      kind: "message",
      id: typeof message.id === "string" ? message.id : `${role}-${index}`,
      role,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(reasoningText ? { reasoning: reasoningText } : {}),
      createdAt: typeof message.createdAt === "string" ? message.createdAt : fallbackTimestamp,
    });
  }

  return transcript;
}

function extractReasoning(message: Record<string, unknown>): string | undefined {
  const { content } = message;
  if (Array.isArray(content)) {
    const thinkingPart = content.find((part) => isRecord(part) && (part.type === "thinking" || part.type === "reasoning"));
    if (thinkingPart) {
      return (
        (thinkingPart as any).thinking ||
        (thinkingPart as any).text ||
        (thinkingPart as any).content ||
        (thinkingPart as any).reasoning
      ) as string | undefined;
    }
  }

  if (typeof message.thought === "string") return message.thought;
  if (typeof message.reasoning === "string") {
    return message.reasoning;
  }

  // Debug: Dump the message structure if it's an assistant message and we haven't found reasoning yet
  if (message.role === 'assistant') {
    console.log(`[pi-sdk-driver] MESSAGE DUMP for ${message.id || 'unknown'}:`);
    console.log(JSON.stringify(message, null, 2));
  }

  if (typeof content === 'string' && content.includes('thinking')) {
     console.log(`[pi-sdk-driver] Found 'thinking' keyword in string content for message ${message.id || 'unknown'}`);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function messageText(message: Record<string, unknown>): string {
  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    return typeof message.summary === "string" ? message.summary.trim() : "";
  }

  const { content } = message;
  if (typeof content === "string") {
    return stripSerializedFileAttachments(content, message.role).text.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string"
          ? stripSerializedFileAttachments(part.text, message.role).text
          : "",
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return "";
}

function messageAttachments(message: Record<string, unknown>) {
  const { content } = message;
  if (typeof content === "string") {
    return stripSerializedFileAttachments(content, message.role).attachments;
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      return stripSerializedFileAttachments(part.text, message.role).attachments;
    }

    if (!isRecord(part) || part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string") {
      return [];
    }

    return [
      {
        kind: "image" as const,
        data: part.data,
        mimeType: part.mimeType,
        ...(typeof part.name === "string" ? { name: part.name } : {}),
      },
    ];
  });
}

function stripSerializedFileAttachments(
  text: string,
  role: unknown,
): { readonly text: string; readonly attachments: readonly SessionTranscriptAttachment[] } {
  if (role !== "user" || !text.startsWith(FILE_ATTACHMENT_BLOCK_START)) {
    return {
      text,
      attachments: [],
    };
  }

  const endIndex = text.indexOf(FILE_ATTACHMENT_BLOCK_END, FILE_ATTACHMENT_BLOCK_START.length);
  if (endIndex < 0) {
    return {
      text,
      attachments: [],
    };
  }

  const payload = text.slice(FILE_ATTACHMENT_BLOCK_START.length, endIndex);
  const remainder = text.slice(endIndex + FILE_ATTACHMENT_BLOCK_END.length).replace(/^\n+/, "");
  const attachments = parseSerializedFileAttachments(payload);
  if (attachments.length === 0) {
    return {
      text,
      attachments: [],
    };
  }

  return {
    text: remainder,
    attachments,
  };
}

function parseSerializedFileAttachments(payload: string): SessionTranscriptAttachment[] {
  try {
    const parsed = JSON.parse(payload) as { readonly version?: unknown; readonly files?: readonly unknown[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
      return [];
    }

    return parsed.files.flatMap((entry) => {
      if (!isRecord(entry) || entry.kind !== "file" || typeof entry.name !== "string" || typeof entry.mimeType !== "string" || typeof entry.fsPath !== "string") {
        return [];
      }

      return [
        {
          kind: "file" as const,
          name: entry.name,
          mimeType: entry.mimeType,
          fsPath: entry.fsPath,
          ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}
