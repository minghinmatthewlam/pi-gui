/** Where a message that another project's thread sent came from. */
export interface CrossProjectMessageOrigin {
  /** Display name of the sending project. */
  readonly project: string;
  /** Thread id the receiver can pass to send_message_to_thread to answer. */
  readonly threadId: string;
}

export interface CrossProjectMessage extends CrossProjectMessageOrigin {
  readonly body: string;
}

// The origin travels inside the prompt text: the receiving model sees where the work came
// from, and the timeline can label it again after a restart, when only the text survives.
// Same-project messages never carry it.
const HEADER =
  /^\[Message from project ("(?:[^"\\\n]|\\.)*") in thread ("(?:[^"\\\n]|\\.)*")\]\n\n/;

export function formatCrossProjectMessage(origin: CrossProjectMessageOrigin, body: string): string {
  return `[Message from project ${JSON.stringify(origin.project)} in thread ${JSON.stringify(origin.threadId)}]\n\n${body}`;
}

/** Reads the origin header of a user message; null when the message has none. */
export function parseCrossProjectMessage(text: string): CrossProjectMessage | null {
  const match = HEADER.exec(text);
  if (!match) return null;
  try {
    return {
      project: JSON.parse(match[1]!) as string,
      threadId: JSON.parse(match[2]!) as string,
      body: text.slice(match[0].length),
    };
  } catch {
    return null;
  }
}
