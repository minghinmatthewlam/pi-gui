import { basename } from "node:path";
import {
  sessionEntryToContextMessages,
  type CustomEntry,
  type SessionInfo,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAction,
  ExtensionCard,
  ExtensionCardRow,
  SessionAttachment,
  SessionConfig,
  SessionErrorInfo,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  SessionTranscriptAttachment,
  SessionTranscriptCard,
  SessionTranscriptCustomMessage,
  SessionTranscriptItem,
  SessionUsageSnapshot,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import { EXTENSION_CARD_CUSTOM_TYPE, parseExtensionAction } from "@pi-gui/session-driver";
import type { SessionQueuedMessage } from "@pi-gui/session-driver/types";

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
  readonly usage?: SessionUsageSnapshot | undefined;
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
    ...(source.usage ? { usage: source.usage } : {}),
    ...(source.queuedMessages.length > 0
      ? {
          queuedMessages: source.queuedMessages.map((message) => ({
            ...message,
            ...(message.attachments
              ? {
                  attachments: message.attachments.map((attachment: SessionAttachment) => ({
                    ...attachment,
                  })),
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
    ...(context.thinkingLevel && context.thinkingLevel !== "off"
      ? { thinkingLevel: context.thinkingLevel }
      : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Whether an agent event's driver events should be persisted to the catalog
 * before they are emitted.
 *
 * Streaming partials (`message_update`) only mutate in-memory preview state, so
 * persisting on each one bought nothing and cost an atomic catalog write -- full
 * re-read, re-serialize, fsync, rename, directory fsync -- per token, all
 * serialized on the catalog's single mutation queue. Any other session
 * operation that writes the catalog (most visibly createSession) then waited out
 * the whole delta backlog.
 *
 * Crash-recovery state stays current to the last message boundary:
 * `message_start`/`message_end`, `tool_execution_*`, `agent_end` and every other
 * snapshot-producing event still persist. The one observable trade-off is that
 * the catalog's `previewSnippet` no longer refreshes per token; it catches up at
 * the next discrete event.
 */
export function shouldPersistSnapshotForAgentEvent(eventType: string): boolean {
  return eventType !== "message_update";
}

export function workspaceToRef(workspace: {
  workspaceId: string;
  path: string;
  displayName: string;
}): WorkspaceRef {
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

/** A custom message its extension sent with `display: false`: model context only. */
export function isHiddenCustomMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "custom" && message.display !== true;
}

export function extractPreview(message: unknown): string | undefined {
  if (!isRecord(message) || isHiddenCustomMessage(message)) {
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

export type RunOutcome =
  | { readonly status: "completed" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: SessionErrorInfo };

export function determineRunOutcome(
  messages: readonly unknown[],
  cancellationRequested = false,
): RunOutcome {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "aborted" && cancellationRequested) {
      return { status: "cancelled" };
    }
    if (stopReason === "error" || stopReason === "aborted") {
      const messageText =
        typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
          ? message.errorMessage
          : stopReason === "aborted"
            ? "Run aborted"
            : "Run failed";
      return { status: "failed", error: { message: messageText, code: stopReason.toUpperCase() } };
    }
    break;
  }
  return { status: "completed" };
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
  const files =
    attachments?.filter(
      (attachment): attachment is Extract<SessionAttachment, { readonly kind: "file" }> =>
        attachment.kind === "file",
    ) ?? [];
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

/** One thing the transcript draws: a context message, or a custom entry pi itself projects to nothing. */
type DisplaySource =
  | { readonly kind: "message"; readonly message: unknown }
  | { readonly kind: "card"; readonly entry: CustomEntry };

export function transcriptFromMessages(
  messages: readonly unknown[],
  fallbackTimestamp = nowIso(),
): SessionTranscriptItem[] {
  return transcriptFromSources(
    messages.map((message) => ({ kind: "message", message })),
    fallbackTimestamp,
  );
}

/** The visible transcript of the session's active branch, including extension cards. */
export function transcriptFromSession(
  sessionManager: Pick<SessionManager, "buildContextEntries">,
  fallbackTimestamp = nowIso(),
): SessionTranscriptItem[] {
  return transcriptFromSources(displaySourcesFromSession(sessionManager), fallbackTimestamp);
}

function transcriptFromSources(
  sources: readonly DisplaySource[],
  fallbackTimestamp: string,
): SessionTranscriptItem[] {
  const transcript: SessionTranscriptItem[] = [];
  const toolIndexByCallId = new Map<string, number>();
  const cardIndexById = new Map<string, number>();

  for (const [index, source] of sources.entries()) {
    if (source.kind === "card") {
      const item = transcriptItemFromCardEntry(source.entry);
      // A keyed card stays where it first appeared and shows its latest write.
      const existing = cardIndexById.get(item.id);
      if (existing === undefined) {
        cardIndexById.set(item.id, transcript.length);
        transcript.push(item);
      } else {
        transcript[existing] = item;
      }
      continue;
    }
    const { message } = source;
    if (!isRecord(message)) {
      continue;
    }

    const role = message.role;
    const createdAt = messageCreatedAt(message, fallbackTimestamp);

    if (role === "toolResult") {
      applyToolResult(transcript, toolIndexByCallId, message, createdAt);
      continue;
    }

    if (role === "custom") {
      const item = customMessageTranscriptItem(
        message,
        typeof message.id === "string" ? message.id : `custom-${index}`,
        createdAt,
      );
      if (item) transcript.push(item);
      continue;
    }

    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "branchSummary" &&
      role !== "compactionSummary"
    ) {
      continue;
    }

    const text = messageText(message);
    const attachments = messageAttachments(message);
    if (text || attachments.length > 0) {
      transcript.push({
        kind: "message",
        id: typeof message.id === "string" ? message.id : `${role}-${index}`,
        ...(typeof message.id === "string" ? { sourceMessageId: message.id } : {}),
        role,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        createdAt,
      });
    }

    if (role === "assistant") {
      appendToolCalls(transcript, toolIndexByCallId, message, createdAt);
    }
  }

  return transcript;
}

/**
 * Terminal pi draws a custom message only when its sender set `display: true`, as the
 * customType over the markdown text; hidden ones only feed the model.
 */
export function customMessageTranscriptItem(
  message: Record<string, unknown>,
  id: string,
  createdAt: string,
): SessionTranscriptCustomMessage | undefined {
  if (message.role !== "custom" || message.display !== true) return undefined;
  const text = messageText(message);
  if (!text) return undefined;
  return {
    kind: "custom",
    id,
    createdAt,
    customType: typeof message.customType === "string" ? message.customType : "custom",
    text,
  };
}

/**
 * Keep the visible transcript independent from Pi's model-only context edits.
 * Pi still selects the active branch and compaction range; its public entry
 * projector supplies the original message and summary content for that range.
 */
export function displayMessagesFromSession(
  sessionManager: Pick<SessionManager, "buildContextEntries">,
) {
  return displaySourcesFromSession(sessionManager).flatMap((source) =>
    source.kind === "message" ? [source.message] : [],
  );
}

/**
 * The display messages plus extension cards in entry order. pi projects custom entries to no
 * messages, so cards are read from the entries directly.
 */
function displaySourcesFromSession(
  sessionManager: Pick<SessionManager, "buildContextEntries">,
): DisplaySource[] {
  return sessionManager.buildContextEntries().flatMap((entry, index): DisplaySource[] => {
    if (isExtensionCardEntry(entry)) return [{ kind: "card", entry }];
    // A retained range can contain older compactions. Only the latest one,
    // which Pi places first, contributes a summary (matching Pi's projection).
    if (entry.type === "compaction" && index > 0) return [];
    return sessionEntryToContextMessages(entry).map((message) => ({
      kind: "message",
      message: { ...message, id: entry.id },
    }));
  });
}

export function isExtensionCardEntry(entry: { readonly type: string }): entry is CustomEntry {
  return (
    entry.type === "custom" &&
    (entry as Partial<CustomEntry>).customType === EXTENSION_CARD_CUSTOM_TYPE
  );
}

/**
 * The only place a `pi-gui.card` entry's data becomes a card. Unknown fields are ignored and
 * malformed rows or actions are skipped. A card without a title is not dropped silently: it
 * becomes a custom row saying what is wrong, so the extension author sees it.
 */
export function transcriptItemFromCardEntry(
  entry: CustomEntry,
): SessionTranscriptCard | SessionTranscriptCustomMessage {
  const card = parseExtensionCard(entry.data);
  if (typeof card === "string") {
    return {
      id: entry.id,
      createdAt: entry.timestamp,
      kind: "custom",
      customType: EXTENSION_CARD_CUSTOM_TYPE,
      text: `This card was not shown: ${card}.`,
    };
  }
  return {
    id: card.key ? `card:${card.key}` : entry.id,
    createdAt: entry.timestamp,
    kind: "card",
    card,
  };
}

/** Card keys: 1 to 64 letters, digits, dots, dashes, underscores or colons. */
const CARD_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
/** More buttons than this on one card are dropped. */
const MAX_CARD_ACTIONS = 8;

function parseExtensionCard(data: unknown): ExtensionCard | string {
  if (!isRecord(data)) return "its data must be an object";
  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (!title) return "it needs a non-empty string `title`";
  if (
    data.key !== undefined &&
    (typeof data.key !== "string" || !CARD_KEY_PATTERN.test(data.key))
  ) {
    return "its `key` must be 1 to 64 letters, digits, dots, dashes, underscores or colons";
  }
  const key = data.key as string | undefined;
  const subtitle = typeof data.subtitle === "string" ? data.subtitle.trim() : "";
  const tone =
    data.tone === "success" || data.tone === "warning" || data.tone === "error"
      ? data.tone
      : "neutral";
  const rows = Array.isArray(data.rows)
    ? data.rows.flatMap((row): ExtensionCardRow[] =>
        isRecord(row) && nonEmptyString(row.label) && isCardValue(row.value)
          ? [{ label: row.label, value: String(row.value) }]
          : [],
      )
    : [];
  const actions = Array.isArray(data.actions)
    ? data.actions
        .flatMap((action): ExtensionAction[] => {
          const parsed = parseExtensionAction(action);
          return parsed ? [parsed] : [];
        })
        .slice(0, MAX_CARD_ACTIONS)
    : [];
  return { ...(key ? { key } : {}), title, ...(subtitle ? { subtitle } : {}), tone, rows, actions };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCardValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
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

/** The part of a tool result Pi saves in the session: its content and details. */
export function persistedToolOutput(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) {
    return {};
  }
  const { content, details } = result as Record<string, unknown>;
  return {
    ...(content !== undefined ? { content } : {}),
    ...(details !== undefined ? { details } : {}),
  };
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
  const output = persistedToolOutput(message);
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

    if (
      !isRecord(part) ||
      part.type !== "image" ||
      typeof part.data !== "string" ||
      typeof part.mimeType !== "string"
    ) {
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
    const parsed = JSON.parse(payload) as {
      readonly version?: unknown;
      readonly files?: readonly unknown[];
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
      return [];
    }

    return parsed.files.flatMap((entry) => {
      if (
        !isRecord(entry) ||
        entry.kind !== "file" ||
        typeof entry.name !== "string" ||
        typeof entry.mimeType !== "string" ||
        typeof entry.fsPath !== "string"
      ) {
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
