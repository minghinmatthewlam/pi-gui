/**
 * Suggested next-prompt (ghost text) helpers.
 *
 * After a run completes, pi-gui asks a cheap model for one follow-up prompt
 * and shows it as grey composer placeholder text. Tab accepts it into the
 * draft. These pure helpers build the model input and sanitize its output;
 * the actual model call lives on RuntimeSupervisor, which owns ModelRuntime.
 */

export interface SuggestionSourceMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const MAX_EXCERPT_CHARS = 3000;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 600;
const MAX_SUGGESTION_CHARS = 220;

export const SUGGESTION_SYSTEM_PROMPT =
  "You suggest the single most useful next prompt the user could send to continue this coding session. " +
  "Reply with ONLY that prompt: one or two sentences, no quotes, no bullets, no preamble, no explanation.";

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Render recent transcript messages as compact `Role: text` lines for the
 * suggester model, newest-relevant last, capped by message and total length.
 */
export function buildSuggestionExcerpt(messages: readonly SuggestionSourceMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  const recent = messages.filter((message) => message.text.trim().length > 0).slice(-MAX_MESSAGES);
  for (const message of recent) {
    const text = truncate(message.text.trim(), MAX_MESSAGE_CHARS);
    const line = `${message.role === "assistant" ? "Assistant" : "User"}: ${text}`;
    if (total + line.length > MAX_EXCERPT_CHARS) {
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n\n");
}

/** Normalize a model reply into a one-shot composer prompt, or undefined when unusable. */
export function sanitizeSuggestedPrompt(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  const stripped = collapsed
    .replace(/^["'“”‘’`]+/, "")
    .replace(/["'“”‘’`]+$/, "")
    .replace(/^[-*•\d.)\s]+/, "")
    .trim();
  if (!stripped) {
    return undefined;
  }
  return truncate(stripped, MAX_SUGGESTION_CHARS);
}
