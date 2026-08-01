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
import type { SessionTranscriptAttachment, SessionTranscriptItem } from "./transcript.js";

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
  const writableSessionManager = sessionManager as {
    _rewriteFile?: () => void;
    flushed?: boolean;
  };
  const maybeRewrite = writableSessionManager._rewriteFile;
  maybeRewrite?.call(sessionManager);
  if (maybeRewrite) {
    // Pi 0.80 defers first writes until the assistant response; keep its
    // internal append/create mode aligned when the desktop forces an early file.
    writableSessionManager.flushed = true;
  }
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

export function transcriptFromMessages(messages: readonly unknown[], fallbackTimestamp = nowIso()): SessionTranscriptItem[] {
  const transcript: SessionTranscriptItem[] = [];
  const toolIndexByCallId = new Map<string, number>();

  for (const [index, message] of messages.entries()) {
    if (!isRecord(message)) {
      continue;
    }

    const role = message.role;
    const createdAt = messageCreatedAt(message, fallbackTimestamp);

    if (role === "toolResult") {
      applyToolResult(transcript, toolIndexByCallId, message, createdAt);
      continue;
    }

    if (role !== "user" && role !== "assistant" && role !== "branchSummary" && role !== "compactionSummary") {
      continue;
    }

    const text = messageText(message);
    const attachments = messageAttachments(message);
    const contextTokens = role === "assistant" ? messageContextTokens(message) : undefined;
    if (text || attachments.length > 0) {
      transcript.push({
        kind: "message",
        id: typeof message.id === "string" ? message.id : `${role}-${index}`,
        role,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(contextTokens != null ? { contextTokens } : {}),
        createdAt,
      });
    }

    if (role === "assistant") {
      appendToolCalls(transcript, toolIndexByCallId, message, createdAt);
    }
  }

  return transcript;
}

function messageContextTokens(message: Record<string, unknown>): number | undefined {
  const usage = message.usage;
  if (!isRecord(usage)) {
    return undefined;
  }
  const total = usage.totalTokens;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : undefined;
}

function messageCreatedAt(message: Record<string, unknown>, fallback: string): string {
  if (typeof message.createdAt === "string") {
    return message.createdAt;
  }
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return new Date(message.timestamp).toISOString();
  }
  return fallback;
}

function appendToolCalls(
  transcript: SessionTranscriptItem[],
  toolIndexByCallId: Map<string, number>,
  message: Record<string, unknown>,
  createdAt: string,
): void {
  const { content } = message;
  if (!Array.isArray(content)) {
    return;
  }

  for (const part of content) {
    if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") {
      continue;
    }
    toolIndexByCallId.set(part.id, transcript.length);
    transcript.push({
      kind: "tool",
      id: part.id,
      callId: part.id,
      toolName: typeof part.name === "string" ? part.name : "tool",
      status: "error",
      ...(part.arguments !== undefined ? { input: part.arguments } : {}),
      createdAt,
    });
  }
}

function applyToolResult(
  transcript: SessionTranscriptItem[],
  toolIndexByCallId: Map<string, number>,
  message: Record<string, unknown>,
  createdAt: string,
): void {
  const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  if (!callId) {
    return;
  }

  const status = message.isError === true ? ("error" as const) : ("success" as const);
  const output = {
    ...(message.content !== undefined ? { content: message.content } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
  };
  const index = toolIndexByCallId.get(callId);
  const existing = index !== undefined ? transcript[index] : undefined;
  if (index !== undefined && existing?.kind === "tool") {
    transcript[index] = { ...existing, status, output };
    return;
  }

  transcript.push({
    kind: "tool",
    id: callId,
    callId,
    toolName: typeof message.toolName === "string" ? message.toolName : "tool",
    status,
    output,
    createdAt,
  });
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
      .filter((text) => text.length > 0)
      .join("\n\n")
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

/**
 * Chain `work` after the current tail of a per-session serial event queue,
 * returning the new tail. Crucially the returned promise is *error-recovering*:
 * if `work` rejects it is reported via `onError` and swallowed, so the tail
 * resolves and later events still run. Chaining onto a rejected promise would
 * otherwise skip every future `.then`, freezing the session's event stream.
 */
export function chainRecoveringEventQueue(
  queue: Promise<void>,
  work: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  return queue.then(work).catch(onError);
}

/**
 * Decide whether getTranscript should re-read the JSONL from disk instead of
 * serving the in-memory runtime view. We tail from disk only when the session
 * is idle (never mid-stream — the live runtime is authoritative while
 * generating) and the file has grown since we last reconciled it, which means
 * an external writer (e.g. `pi --continue`) appended turns the runtime never
 * saw. For a persisting idle session the file is a superset of memory, so the
 * disk read is safe. A missing baseline (first serve) does not trigger a tail:
 * the baseline is captured at bind time, matching the freshly-opened file.
 */
export function shouldTailFromDisk(input: {
  readonly isStreaming: boolean;
  readonly diskMtimeMs: number | undefined;
  readonly baselineMtimeMs: number | undefined;
}): boolean {
  // `diskMtimeMs` is undefined when there is no session file or the stat failed,
  // so it also covers the "no file" case; the caller passes undefined while
  // streaming too, but we guard isStreaming here to keep the rule explicit.
  if (input.isStreaming || input.diskMtimeMs === undefined || input.baselineMtimeMs === undefined) {
    return false;
  }
  return input.diskMtimeMs > input.baselineMtimeMs;
}

/**
 * Deduplicate concurrent async work by `key`. While a call for `key` is in
 * flight, later callers receive the same promise instead of starting a second
 * `factory` run, so exactly one result is produced. The entry is removed once
 * settled so the next call starts fresh.
 */
export function singleFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async () => factory())().finally(() => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, promise);
  return promise;
}
