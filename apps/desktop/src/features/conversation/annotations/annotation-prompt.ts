/** A note the user attached to a span of one transcript message, waiting in the composer. */
export interface TranscriptAnnotation {
  readonly id: string;
  /** Timeline ids of the annotated message: its row id, and its saved id once it has one. */
  readonly messageIds: readonly string[];
  /** Offsets into the message's rendered text (its root element's textContent). */
  readonly start: number;
  readonly end: number;
  /** The text at those offsets when selected, to find it again if the markdown reflows. */
  readonly anchorText: string;
  /** The selected text as the user saw it, with line breaks. */
  readonly quote: string;
  /** Optional; empty when the user added the quote without a comment. */
  readonly note: string;
}

/** An annotation as it reads back from a sent user message. */
export interface SentAnnotation {
  readonly quote: string;
  readonly note: string;
}

export interface AnnotatedPrompt {
  readonly annotations: readonly SentAnnotation[];
  readonly body: string;
}

// A line of quoted text that reads exactly like one of the tags would end its block early,
// so such lines gain a leading backslash (and lose one when read back).
const TAG_LINE = /^(\\*)(<\/?(?:annotation|quote|note)>)$/gm;
const escapeTags = (text: string) => text.replace(TAG_LINE, "\\$1$2");
const unescapeTags = (text: string) =>
  text.replace(TAG_LINE, (line: string, slashes: string, tag: string) =>
    slashes ? `${slashes.slice(1)}${tag}` : line,
  );

/**
 * The text pi receives: each annotation as a quote followed by its note, before the typed
 * message. The tags keep it unambiguous for the model and let the transcript show the
 * quotes as blocks again after a restart, when only the text survives.
 */
export function formatAnnotatedPrompt(
  annotations: readonly Pick<TranscriptAnnotation, "quote" | "note">[],
  body: string,
): string {
  const blocks = annotations.map(({ quote, note }) => {
    const lines = ["<annotation>", "<quote>", escapeTags(quote), "</quote>"];
    if (note.trim()) lines.push("<note>", escapeTags(note.trim()), "</note>");
    lines.push("</annotation>");
    return lines.join("\n");
  });
  const trimmedBody = body.trim();
  return [...blocks, ...(trimmedBody ? [trimmedBody] : [])].join("\n\n");
}

const ANNOTATION_BLOCK =
  /^<annotation>\n<quote>\n([\s\S]*?)\n<\/quote>(?:\n<note>\n([\s\S]*?)\n<\/note>)?\n<\/annotation>(?:\n\n|$)/;

/** Reads the leading annotation blocks of a user message; null when it has none. */
export function parseAnnotatedPrompt(text: string): AnnotatedPrompt | null {
  const annotations: SentAnnotation[] = [];
  let rest = text;
  for (let match = ANNOTATION_BLOCK.exec(rest); match; match = ANNOTATION_BLOCK.exec(rest)) {
    annotations.push({ quote: unescapeTags(match[1] ?? ""), note: unescapeTags(match[2] ?? "") });
    rest = rest.slice(match[0].length);
  }
  return annotations.length > 0 ? { annotations, body: rest } : null;
}
