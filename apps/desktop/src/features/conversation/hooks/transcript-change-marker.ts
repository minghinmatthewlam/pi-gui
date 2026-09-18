import type { TranscriptMessage } from "../../../../contracts/desktop-state";

const LAST_TEXT_FINGERPRINT_CHARS = 24;

/**
 * Cheap identity for “did the timeline change?”. Must not stringify the growing
 * last message — that re-serialized the whole answer on every token.
 */
export function buildTranscriptChangeMarker(
  sessionKey: string,
  transcript: readonly TranscriptMessage[],
): string {
  const lastItem = transcript.at(-1);
  return `${sessionKey}:${transcript.length}:${lastTranscriptItemMarker(lastItem)}`;
}

export function lastTranscriptItemMarker(item: TranscriptMessage | undefined): string {
  if (!item) {
    return "";
  }
  switch (item.kind) {
    case "message":
      return [
        "message",
        item.id,
        item.role,
        String(item.text.length),
        item.text.slice(-LAST_TEXT_FINGERPRINT_CHARS),
        String(item.attachments?.length ?? 0),
      ].join(":");
    case "tool":
      return `tool:${item.callId}:${item.status}:${item.label.length}:${item.detail?.length ?? 0}`;
    case "activity":
      return `activity:${item.id}:${item.label.length}:${item.detail?.length ?? 0}`;
    case "summary":
      return `summary:${item.id}:${item.label.length}:${item.presentation}`;
    default: {
      const unexpected: never = item;
      return (unexpected as TranscriptMessage).id;
    }
  }
}
