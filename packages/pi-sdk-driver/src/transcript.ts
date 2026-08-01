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

export type SessionTranscriptAttachment = SessionTranscriptImageAttachment | SessionTranscriptFileAttachment;

export type SessionTranscriptRole = "user" | "assistant" | "branchSummary" | "compactionSummary";

export interface SessionTranscriptMessage {
  readonly kind: "message";
  readonly role: SessionTranscriptRole;
  readonly text: string;
  readonly attachments?: readonly SessionTranscriptAttachment[];
  readonly createdAt: string;
  readonly id: string;
  /** Total tokens (prompt + completion) reported for the turn that produced this
   * assistant message — i.e. the context occupancy after that turn. */
  readonly contextTokens?: number;
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

export type SessionTranscriptItem = SessionTranscriptMessage | SessionTranscriptToolCall;
