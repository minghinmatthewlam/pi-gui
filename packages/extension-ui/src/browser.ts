import { isJsonValue, type RemoteServiceSource } from "@earendil-works/chord";

export interface DesktopFileTarget {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export interface DesktopTaskDraft {
  readonly title: string;
  readonly prompt: string;
  readonly files?: readonly { readonly path: string; readonly line?: number }[];
}

export type DesktopHostAction =
  | ({ readonly type: "openFile" } & DesktopFileTarget)
  | ({ readonly type: "prepareTaskDraft" } & DesktopTaskDraft);

export interface DesktopViewContext {
  readonly services: RemoteServiceSource;
  /** Aborted when this mount loses its connection, including reload and task closure. */
  readonly signal: AbortSignal;
  readonly theme: {
    readonly mode: "light" | "dark";
    readonly background: string;
    readonly foreground: string;
    readonly accent: string;
  };
  readonly actions: {
    openFile(target: DesktopFileTarget): Promise<void>;
    prepareTaskDraft(draft: DesktopTaskDraft): Promise<void>;
  };
}

export type DesktopViewMount = (
  root: HTMLElement,
  host: DesktopViewContext,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

/** Validate the untrusted action payload before binding it to the initiating task/window. */
export function parseDesktopHostAction(value: unknown): DesktopHostAction {
  if (!isJsonValue(value) || !isRecord(value)) throw new TypeError("Invalid desktop host action");
  if (value.type === "openFile") {
    assertKeys(value, ["type", "path"], ["line", "column"]);
    assertPath(value.path);
    assertLine(value.line);
    assertLine(value.column);
    return {
      type: "openFile",
      path: value.path,
      ...(typeof value.line === "number" ? { line: value.line } : {}),
      ...(typeof value.column === "number" ? { column: value.column } : {}),
    };
  }
  if (value.type === "prepareTaskDraft") {
    assertKeys(value, ["type", "title", "prompt"], ["files"]);
    if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 240) {
      throw new TypeError("Task draft title must contain 1 to 240 characters");
    }
    if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 100_000) {
      throw new TypeError("Task draft prompt must contain 1 to 100000 characters");
    }
    let files: { path: string; line?: number }[] | undefined;
    if (value.files !== undefined) {
      if (!Array.isArray(value.files) || value.files.length > 100) {
        throw new TypeError("Task draft files must be a list of at most 100 targets");
      }
      files = value.files.map((file: unknown) => {
        if (!isRecord(file)) throw new TypeError("Invalid task draft file");
        assertKeys(file, ["path"], ["line"]);
        assertPath(file.path);
        assertLine(file.line);
        return { path: file.path, ...(typeof file.line === "number" ? { line: file.line } : {}) };
      });
    }
    return {
      type: "prepareTaskDraft",
      title: value.title,
      prompt: value.prompt,
      ...(files ? { files } : {}),
    };
  }
  throw new TypeError("Unknown desktop host action");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) {
    throw new TypeError("Invalid file path");
  }
}

function assertLine(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError("File line and column must be positive integers");
  }
}

function assertKeys(value: Record<string, unknown>, required: string[], optional: string[]): void {
  const keys = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.has(key))
  ) {
    throw new TypeError("Unexpected desktop host action fields");
  }
}
