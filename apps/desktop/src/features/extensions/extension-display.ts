import { translate, type Translate } from "../../i18n";
import type {
  RuntimeExtensionRecord,
  RuntimeSourceScope,
} from "@pi-gui/session-driver/runtime-types";

export function extensionSourceSummary(
  extension: RuntimeExtensionRecord,
  t: Translate = translate,
): string {
  return `${extensionGroupLabel(extension, t)} · ${extension.sourceInfo.origin}`;
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
export function sourceScopeGroupLabel(scope: RuntimeSourceScope, t: Translate = translate): string {
  switch (scope) {
    case "project":
      return t("sidebar.grouping.workspace");
    case "user":
      return t("resources.user");
    case "temporary":
      return t("resources.session");
  }
}

export function extensionGroupLabel(
  extension: RuntimeExtensionRecord,
  t: Translate = translate,
): string {
  if (isPiGuiBuiltinExtension(extension)) return t("resources.builtinGui");
  if (isPiAddonExtension(extension)) return t("resources.builtinPi");
  return sourceScopeGroupLabel(extension.sourceInfo.scope, t);
}
