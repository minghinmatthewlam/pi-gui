import type { RuntimeExtensionRecord } from "@pi-gui/session-driver/runtime-types";

export function extensionSourceSummary(extension: RuntimeExtensionRecord): string {
  return `${extensionScopeLabel(extension)} · ${extension.sourceInfo.origin}`;
}

export function extensionScopeLabel(extension: RuntimeExtensionRecord): string {
  if (extension.sourceInfo.source === "builtin" && extension.sourceInfo.origin === "top-level") {
    return "Built-in";
  }
  return extension.sourceInfo.scope;
}
