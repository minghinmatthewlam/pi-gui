/**
 * What a button an extension drew in pi-gui can ask the app to do. The list is closed: an
 * extension's UI has no other way to make pi-gui act, and main checks each one again when
 * it is clicked (`apps/desktop/electron/extensions/app-operations.ts`).
 */
export type ExtensionAction =
  /** Opens a file in the thread's checkout in the side panel, at `line` when given. */
  | {
      readonly type: "openFile";
      readonly label: string;
      readonly path: string;
      readonly line?: number;
    }
  /** Adds text to the composer. Nothing is sent: the user reads it and sends it. */
  | { readonly type: "composer"; readonly label: string; readonly text: string }
  /** Opens an https link in the browser. */
  | { readonly type: "url"; readonly label: string; readonly url: string }
  /** Runs one of the thread's extension commands, such as "/ci rerun". Never starts a model turn. */
  | { readonly type: "command"; readonly label: string; readonly command: string };

export type ExtensionActionType = ExtensionAction["type"];

const MAX_LABEL_LENGTH = 80;
const MAX_TEXT_LENGTH = 10_000;
const MAX_COMMAND_LENGTH = 1_000;
const MAX_URL_LENGTH = 2_048;

/**
 * The only place untrusted data becomes an `ExtensionAction`: extension records in the pi
 * adapter, and the renderer's request in main. Returns undefined for anything malformed or
 * unknown, so a newer action kind is skipped rather than drawn wrong.
 */
export function parseExtensionAction(value: unknown): ExtensionAction | undefined {
  if (!isRecord(value)) return undefined;
  const label = boundedText(value.label, MAX_LABEL_LENGTH);
  if (!label) return undefined;
  switch (value.type) {
    case "openFile": {
      const path = boundedText(value.path, MAX_URL_LENGTH);
      if (!path) return undefined;
      const line =
        Number.isSafeInteger(value.line) && (value.line as number) > 0
          ? (value.line as number)
          : undefined;
      return { type: "openFile", label, path, ...(line ? { line } : {}) };
    }
    case "composer": {
      const text = boundedText(value.text, MAX_TEXT_LENGTH);
      return text ? { type: "composer", label, text } : undefined;
    }
    case "url": {
      const url = typeof value.url === "string" ? parseExtensionUrl(value.url) : undefined;
      return url ? { type: "url", label, url } : undefined;
    }
    case "command": {
      const command = boundedText(value.command, MAX_COMMAND_LENGTH);
      return command && /^\/\S/.test(command) && !/[\r\n]/.test(command)
        ? { type: "command", label, command }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** An https URL without credentials, normalized, or undefined. */
export function parseExtensionUrl(value: string): string | undefined {
  if (value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
