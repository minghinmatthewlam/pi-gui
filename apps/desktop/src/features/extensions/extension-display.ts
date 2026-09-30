import type {
  RuntimeExtensionRecord,
  RuntimeSourceScope,
} from "@pi-gui/session-driver/runtime-types";

export function extensionSourceSummary(extension: RuntimeExtensionRecord): string {
  return `${extensionScopeLabel(extension)} · ${extension.sourceInfo.origin}`;
}

export const PI_GUI_TOOLS_LABEL = "pi-gui tools";
export const PI_ADDONS_LABEL = "Built into pi";

/** Extensions pi-gui itself adds to every session; switched on and off app-wide. */
export function isPiGuiBuiltinExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    extension.sourceInfo.source === "builtin" &&
    extension.sourceInfo.origin === "top-level" &&
    extension.sourceInfo.scope === "temporary"
  );
}

/**
 * pi's own add-ons (MCP, code mode, tool search), named `builtin:<name>`. Their switch writes
 * pi's `extensions` setting, so terminal pi follows it too.
 */
export function isPiAddonExtension(extension: RuntimeExtensionRecord): boolean {
  return extension.sourceInfo.source === "builtin" && extension.path.startsWith("builtin:");
}

export function extensionScopeLabel(extension: RuntimeExtensionRecord): string {
  if (isPiGuiBuiltinExtension(extension)) return PI_GUI_TOOLS_LABEL;
  if (isPiAddonExtension(extension)) return PI_ADDONS_LABEL;
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
  if (isPiGuiBuiltinExtension(extension)) return PI_GUI_TOOLS_LABEL;
  if (isPiAddonExtension(extension)) return PI_ADDONS_LABEL;
  return sourceScopeGroupLabel(extension.sourceInfo.scope);
}
