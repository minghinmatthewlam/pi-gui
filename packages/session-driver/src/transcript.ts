export interface SessionTranscriptImageAttachment {
  readonly kind: "image";
  readonly mimeType: string;
  readonly data: string;
  readonly name?: string;
}

export interface SessionTranscriptFileAttachment {
  readonly kind: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly fsPath: string;
  readonly sizeBytes?: number;
}

export type SessionTranscriptAttachment =
  SessionTranscriptImageAttachment | SessionTranscriptFileAttachment;

export type SessionTranscriptRole = "user" | "assistant" | "branchSummary" | "compactionSummary";

export interface SessionTranscriptMessage {
  readonly kind: "message";
  readonly role: SessionTranscriptRole;
  readonly text: string;
  readonly attachments?: readonly SessionTranscriptAttachment[];
  readonly createdAt: string;
  readonly id: string;
  /** Authoritative persisted entry identity; a live display row can retain its own id. */
  readonly sourceMessageId?: string;
}

export interface SessionTranscriptToolCall {
  readonly kind: "tool";
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  /** "error" also covers calls whose result never arrived (interrupted runs). */
  readonly status: "success" | "error";
  readonly input?: unknown;
  readonly output?: unknown;
  readonly createdAt: string;
}

/**
 * An extension's `pi.sendMessage({ customType, content, display: true })`, drawn the way
 * terminal pi draws it: the customType as a label over the markdown text.
 */
export interface SessionTranscriptCustomMessage {
  readonly kind: "custom";
  /** The pi session entry id, so live and reloaded rows share one identity. */
  readonly id: string;
  readonly createdAt: string;
  readonly customType: string;
  /** Markdown from the message's text parts. */
  readonly text: string;
}

export type ExtensionCardTone = "neutral" | "success" | "warning" | "error";

export interface ExtensionCardRow {
  readonly label: string;
  readonly value: string;
}

/** Opens `path` (relative to the thread's workspace) at `line` in the side panel. */
export interface ExtensionCardAction {
  readonly label: string;
  readonly path: string;
  readonly line?: number;
}

/**
 * A card an extension declares as data with `pi.appendEntry("pi-gui.card", card)`.
 * pi-gui draws it with its own component; there are no styling knobs.
 */
export interface ExtensionCard {
  readonly title: string;
  readonly subtitle?: string;
  readonly tone: ExtensionCardTone;
  readonly rows: readonly ExtensionCardRow[];
  readonly actions: readonly ExtensionCardAction[];
}

export interface SessionTranscriptCard {
  readonly kind: "card";
  /** The pi entry id, so the live row and the reopened row are the same item. */
  readonly id: string;
  readonly createdAt: string;
  readonly card: ExtensionCard;
}

export type SessionTranscriptItem =
  | SessionTranscriptMessage
  | SessionTranscriptToolCall
  | SessionTranscriptCustomMessage
  | SessionTranscriptCard;
