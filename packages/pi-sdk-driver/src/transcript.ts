export interface SessionTranscriptAttachment {
  readonly kind: "image";
  readonly mimeType: string;
  readonly data: string;
  readonly name?: string;
}

export type SessionTranscriptRole = "user" | "assistant";

export interface SessionTranscriptMessage {
  readonly kind: "message";
  readonly role: SessionTranscriptRole;
  readonly text: string;
  readonly attachments?: readonly SessionTranscriptAttachment[];
  readonly createdAt: string;
  readonly id: string;
}
