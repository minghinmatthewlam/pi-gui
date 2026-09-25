import type {
  RuntimeExtensionRecord,
  RuntimeSourceScope,
} from "@pi-gui/session-driver/runtime-types";

export function extensionSourceSummary(extension: RuntimeExtensionRecord): string {
  return `${extensionScopeLabel(extension)} · ${extension.sourceInfo.origin}`;
}

export const PI_GUI_TOOLS_LABEL = "pi-gui tools";

/** Extensions pi-gui itself adds to every session; switched on and off app-wide. */
export function isPiGuiBuiltinExtension(extension: RuntimeExtensionRecord): boolean {
  return extension.sourceInfo.source === "builtin" && extension.sourceInfo.origin === "top-level";
}

export function extensionScopeLabel(extension: RuntimeExtensionRecord): string {
  return isPiGuiBuiltinExtension(extension) ? PI_GUI_TOOLS_LABEL : extension.sourceInfo.scope;
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
  return isPiGuiBuiltinExtension(extension)
    ? PI_GUI_TOOLS_LABEL
    : sourceScopeGroupLabel(extension.sourceInfo.scope);
}
