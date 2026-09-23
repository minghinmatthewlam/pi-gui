import type { SessionRef } from "@pi-gui/session-driver/types";
import { decodeReviewScope, type ReviewScope } from "./review";

export const MAX_WORKBENCH_FILE_TABS = 100;
export const MAX_WORKBENCH_TOOLS = 32;

/** Every built-in tool; its presentation table must cover each kind. */
export const BUILTIN_TOOL_KINDS = ["files", "changes", "worktrees", "terminal"] as const;
export type BuiltinToolKind = (typeof BUILTIN_TOOL_KINDS)[number];

export function isBuiltinToolKind(value: unknown): value is BuiltinToolKind {
  return (BUILTIN_TOOL_KINDS as readonly unknown[]).includes(value);
}

export type ToolRef =
  | { readonly kind: BuiltinToolKind }
  | { readonly kind: "extension"; readonly extensionId: string; readonly viewId: string };

export type ToolSelection =
  { readonly kind: "chooser" } | { readonly kind: "tool"; readonly toolId: string };

/** References and small view preferences only; never file, diff, terminal or extension content. */
export interface TaskWorkbenchTemplate {
  readonly visibility: "visible" | "hidden";
  readonly tools: readonly ToolRef[];
  readonly selection: ToolSelection;
  readonly files: {
    readonly workspaceId: string;
    readonly tabs: {
      readonly tabs: readonly string[];
      readonly active: string | null;
      readonly line: { readonly start: number; readonly end: number } | null;
      readonly lineNonce: number;
      readonly retained: readonly string[];
    };
  };
  readonly changes: {
    readonly workspaceId: string;
    readonly selectedPath: string | null;
    readonly scope: ReviewScope;
  };
}

export interface SaveTaskWorkbenchTemplateInput {
  readonly target: SessionRef;
  readonly template: TaskWorkbenchTemplate;
  /** Strictly increasing across this renderer's saves, including task switches. */
  readonly sequence: number;
}

export function toolRefId(tool: ToolRef): string {
  return tool.kind === "extension"
    ? JSON.stringify(["extension", tool.extensionId, tool.viewId])
    : tool.kind;
}

/** Shared by the disk reader and IPC boundary so neither can accept a wider schema. */
export function decodeTaskWorkbenchTemplate(value: unknown): TaskWorkbenchTemplate {
  const root = record(value, ["visibility", "tools", "selection", "files", "changes"]);
  if (root.visibility !== "visible" && root.visibility !== "hidden") fail("visibility");
  if (!Array.isArray(root.tools) || root.tools.length > MAX_WORKBENCH_TOOLS) fail("tools");
  const tools: ToolRef[] = root.tools.map((value: unknown) => {
    const tool = record(value, ["kind", "extensionId", "viewId"]);
    if (tool.kind === "extension") {
      return {
        kind: "extension",
        extensionId: text(tool.extensionId, 256),
        viewId: text(tool.viewId, 256),
      };
    }
    if (!isBuiltinToolKind(tool.kind)) fail("tool kind");
    if (tool.extensionId !== undefined || tool.viewId !== undefined) fail("builtin tool fields");
    return { kind: tool.kind };
  });
  const identities = new Set(tools.map(toolRefId));
  if (identities.size !== tools.length) fail("duplicate tool");
  const selected = record(root.selection, ["kind", "toolId"]);
  let selection: ToolSelection;
  if (selected.kind === "chooser" && selected.toolId === undefined) {
    selection = { kind: "chooser" };
  } else if (
    selected.kind === "tool" &&
    typeof selected.toolId === "string" &&
    identities.has(selected.toolId)
  ) {
    selection = { kind: "tool", toolId: selected.toolId };
  } else {
    fail("selection");
  }
  const files = record(root.files, ["workspaceId", "tabs"]);
  const tabs = record(files.tabs, ["tabs", "active", "line", "lineNonce", "retained"]);
  const paths = pathsList(tabs.tabs);
  const retained = pathsList(tabs.retained);
  const active = tabs.active === null ? null : text(tabs.active);
  if (active !== null && !paths.includes(active)) fail("active file");
  if (retained.some((path) => !paths.includes(path))) fail("retained file");
  let line: { start: number; end: number } | null = null;
  if (tabs.line !== null) {
    const mark = record(tabs.line, ["start", "end"]);
    const start = integer(mark.start, 1);
    const end = integer(mark.end, start);
    if (active === null) fail("line without active file");
    line = { start, end };
  }
  const changes = record(root.changes, ["workspaceId", "selectedPath", "scope"]);
  return {
    visibility: root.visibility,
    tools,
    selection,
    files: {
      workspaceId: text(files.workspaceId),
      tabs: { tabs: paths, active, line, lineNonce: integer(tabs.lineNonce), retained },
    },
    changes: {
      workspaceId: text(changes.workspaceId),
      selectedPath: changes.selectedPath === null ? null : text(changes.selectedPath),
      scope:
        changes.scope === undefined ? { kind: "uncommitted" } : decodeReviewScope(changes.scope),
    },
  };
}

function fail(field: string): never {
  throw new Error(`Invalid workbench template: ${field}`);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) fail("unsupported field");
  return result;
}

function text(value: unknown, limit = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) {
    fail("invalid or oversized reference");
  }
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("integer");
  return value;
}

function pathsList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_WORKBENCH_FILE_TABS) fail("file references");
  const result = value.map((path: unknown) => text(path));
  if (new Set(result).size !== result.length) fail("duplicate file reference");
  return result;
}
