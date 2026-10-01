import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";

/** Tool name → the label its extension registered, for one folder's loaded extensions. */
export type ExtensionToolLabels = ReadonlyMap<string, string>;

const NO_LABELS: ExtensionToolLabels = new Map();

/**
 * Labels of the tools a folder's own extensions registered. pi-gui's built-in extensions are
 * skipped: their tools keep pi-gui's wording ("Started child thread", ...).
 */
export function extensionToolLabels(runtime: RuntimeSnapshot | undefined): ExtensionToolLabels {
  if (!runtime) {
    return NO_LABELS;
  }
  const labels = new Map<string, string>();
  for (const extension of runtime.extensions) {
    if (extension.sourceInfo.source === "builtin") {
      continue;
    }
    for (const tool of extension.tools) {
      const label = tool.label.trim();
      if (label && !labels.has(tool.name)) {
        labels.set(tool.name, label);
      }
    }
  }
  return labels;
}

/**
 * "Read GitHub issue or PR: pr 223": the extension's label, then the call's main argument, or
 * else its plain values in order, since an extension's parameters have no names pi-gui knows.
 */
export function extensionToolRowLabel(label: string, input: unknown): string {
  const detail = toolInputSummary(input) ?? scalarValues(input);
  return detail ? `${label}: ${detail}` : label;
}

function scalarValues(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const values = Object.values(input).filter(
    (value) =>
      (typeof value === "string" && value.trim()) ||
      typeof value === "number" ||
      typeof value === "boolean",
  );
  return values.length > 0 ? truncate(values.join(" "), 80) : undefined;
}

/** The call argument a person recognizes the call by (a path, query, command, ...), shortened. */
export function toolInputSummary(input: unknown): string | undefined {
  if (typeof input === "string") {
    return truncate(input, 80);
  }
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of INPUT_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(value, 80);
    }
  }
  return undefined;
}

const INPUT_SUMMARY_KEYS = [
  "path",
  "filePath",
  "query",
  "q",
  "url",
  "command",
  "text",
  "prompt",
  "title",
  "app",
] as const;

export function truncate(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}
