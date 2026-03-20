import { basename } from "node:path";
import type { SessionInfo } from "@mariozechner/pi-coding-agent";
import type { SessionConfig, SessionErrorInfo, SessionRef, SessionSnapshot, SessionStatus, WorkspaceRef } from "@pi-app/session-driver";
import type { SessionTranscriptMessage } from "./transcript.js";

export interface SnapshotSource {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly status: SessionStatus;
  readonly updatedAt: string;
  readonly preview: string | undefined;
  readonly config: SessionConfig | undefined;
  readonly runningRunId: string | undefined;
}

export function buildSnapshot(source: SnapshotSource): SessionSnapshot {
  return {
    ref: { ...source.ref },
    workspace: { ...source.workspace },
    title: source.title.trim() || deriveWorkspaceTitle(source.workspace),
    status: source.status,
    updatedAt: source.updatedAt,
    ...(source.preview !== undefined ? { preview: source.preview } : {}),
    ...(source.config ? { config: source.config } : {}),
    ...(source.runningRunId !== undefined ? { runningRunId: source.runningRunId } : {}),
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

  const content = message.content;
  if (typeof content === "string") {
    return truncate(content);
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join(" ")
      .trim();
    return text ? truncate(text) : undefined;
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

export function transcriptFromMessages(messages: readonly unknown[], fallbackTimestamp = nowIso()): SessionTranscriptMessage[] {
  const transcript: SessionTranscriptMessage[] = [];

  for (const [index, message] of messages.entries()) {
    if (!isRecord(message)) {
      continue;
    }

    const role = message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = messageText(message);
    const attachments = messageAttachments(message);
    if (!text) {
      if (attachments.length === 0) {
        continue;
      }
    }

    transcript.push({
      kind: "message",
      id: typeof message.id === "string" ? message.id : `${role}-${index}`,
      role,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: typeof message.createdAt === "string" ? message.createdAt : fallbackTimestamp,
    });
  }

  return transcript;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageText(message: Record<string, unknown>): string {
  const { content } = message;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join(" ")
      .trim();
  }

  return "";
}

function messageAttachments(message: Record<string, unknown>) {
  const { content } = message;
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
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
