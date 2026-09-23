import type {
  RuntimeExtensionRecord,
  RuntimeSourceScope,
} from "@pi-gui/session-driver/runtime-types";

export function extensionSourceSummary(extension: RuntimeExtensionRecord): string {
  return `${extensionScopeLabel(extension)} · ${extension.sourceInfo.origin}`;
}

export function extensionScopeLabel(extension: RuntimeExtensionRecord): string {
  if (extension.sourceInfo.source === "builtin" && extension.sourceInfo.origin === "top-level") {
    return "Built-in";
  }
  return extension.sourceInfo.scope;
}

/** Group heading for where a skill or extension was discovered. */
export function sourceScopeGroupLabel(scope: RuntimeSourceScope): string {
  switch (scope) {
    case "project":
      return "Workspace";
    case "user":
      return "User";
    case "temporary":
      return "This session";
  }
}

export function extensionGroupLabel(extension: RuntimeExtensionRecord): string {
  return extensionScopeLabel(extension) === "Built-in"
    ? "Built-in"
    : sourceScopeGroupLabel(extension.sourceInfo.scope);
}
