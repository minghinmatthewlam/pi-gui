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
  | ({ readonly type: "prepareTaskDraft" } & DesktopTaskDraft)
  | { readonly type: "openUrl"; readonly url: string }
  | { readonly type: "openThread"; readonly sessionId: string };

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
    /** Opens an https link in the user's browser. */
    openUrl(url: string): Promise<void>;
    /** Opens another thread of this folder or its pi-gui worktrees, by pi session id. */
    openThread(sessionId: string): Promise<void>;
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
  if (value.type === "openUrl") {
    assertKeys(value, ["type", "url"], []);
    // Main opens https links only; this checks the shape before anything leaves the frame.
    // The limits match session-driver's `parseExtensionAction`, which main applies again.
    if (typeof value.url !== "string" || !value.url || value.url.length > 2048) {
      throw new TypeError("Invalid link");
    }
    return { type: "openUrl", url: value.url };
  }
  if (value.type === "openThread") {
    assertKeys(value, ["type", "sessionId"], []);
    if (typeof value.sessionId !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(value.sessionId)) {
      throw new TypeError("Invalid thread id");
    }
    return { type: "openThread", sessionId: value.sessionId };
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
