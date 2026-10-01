import type { ExtensionAction } from "./extension-actions.js";

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

/** The custom entry type an extension writes with `pi.appendEntry` to show a card in pi-gui. */
export const EXTENSION_CARD_CUSTOM_TYPE = "pi-gui.card";

export type ExtensionCardTone = "neutral" | "success" | "warning" | "error";

export interface ExtensionCardRow {
  readonly label: string;
  readonly value: string;
}

/**
 * A card an extension declares as data with `pi.appendEntry("pi-gui.card", card)`.
 * pi-gui draws it with its own component; there are no styling knobs.
 */
export interface ExtensionCard {
  /**
   * Writing another card with the same key updates this one where it first appeared,
   * instead of adding a new row.
   */
  readonly key?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly tone: ExtensionCardTone;
  readonly rows: readonly ExtensionCardRow[];
  readonly actions: readonly ExtensionAction[];
}

export interface SessionTranscriptCard {
  readonly kind: "card";
  /**
   * `card:<key>` for a keyed card, else the pi entry id, so the live row and the reopened
   * row are the same item.
   */
  readonly id: string;
  readonly createdAt: string;
  readonly card: ExtensionCard;
}

/**
 * The custom entry type an extension writes with `pi.appendEntry` to pin a card above the
 * composer: the card fields with a required key, or `{ key, remove: true }` to unpin it.
 */
export const EXTENSION_PIN_CUSTOM_TYPE = "pi-gui.pin";

/**
 * The latest write of one pinned card on the active branch. Pins are reduced over the whole
 * branch, not the compaction range, so a pin outlives the turns it was written in. Its place in
 * the transcript means nothing: the app draws pins above the composer, never in the timeline.
 */
export interface SessionTranscriptPin {
  readonly kind: "pin";
  /** `pin:<key>`, so each write replaces the one before. */
  readonly id: string;
  /** The latest write's time, so a write after the user hid the pin shows it again. */
  readonly createdAt: string;
  /** Null once the extension removed it, so the live update can replace it in place. */
  readonly card: ExtensionCard | null;
}

export type SessionTranscriptItem =
  | SessionTranscriptMessage
  | SessionTranscriptToolCall
  | SessionTranscriptCustomMessage
  | SessionTranscriptCard
  | SessionTranscriptPin;

/**
 * A card, or the row that says why a `pi-gui.card` or `pi-gui.pin` entry could not be drawn.
 * These sit in the transcript where their entry is in the session file.
 */
export function isCardEntryItem(item: SessionTranscriptItem): boolean {
  return (
    item.kind === "card" ||
    (item.kind === "custom" &&
      (item.customType === EXTENSION_CARD_CUSTOM_TYPE ||
        item.customType === EXTENSION_PIN_CUSTOM_TYPE))
  );
}
