import { translate, type Translate } from "../../i18n";
import type { ComponentType, ReactNode } from "react";
import { BUILTIN_TOOL_KINDS, type BuiltinToolKind } from "../../../contracts/workbench";
import { DiffIcon, FileIcon, TerminalIcon } from "../../ui/icons";

interface BuiltinToolDefinition {
  readonly label: string;
  /** Shown in the tool chooser. */
  readonly description: string;
  readonly Icon: ComponentType;
  /** Key that toggles the tool with the platform modifier, when it has one. */
  readonly shortcutKey?: string;
}

/** Presentation for every built-in tool; a missing kind fails the build. */
export function builtinTools(t: Translate = translate) {
  return {
    files: { label: t("ui.files"), description: t("workbench.browseFiles"), Icon: FileIcon },
    changes: {
      label: t("ui.review"),
      description: t("workbench.reviewDescription"),
      Icon: DiffIcon,
      shortcutKey: "R",
    },
    terminal: {
      label: t("settings.general.groupTerminal"),
      description: t("workbench.terminalDescription"),
      Icon: TerminalIcon,
      shortcutKey: "J",
    },
  } as const satisfies Record<BuiltinToolKind, BuiltinToolDefinition>;
}
export const BUILTIN_TOOLS = builtinTools();

/** Chooser order follows the contract's kind list. */
export function builtinToolEntries(t: Translate = translate) {
  const tools = builtinTools(t);
  return BUILTIN_TOOL_KINDS.map(
    (kind): BuiltinToolDefinition & { readonly kind: BuiltinToolKind } => ({
      kind,
      ...tools[kind],
    }),
  );
}
export const BUILTIN_TOOL_ENTRIES = builtinToolEntries();

/** The composition root supplies one panel per built-in tool; rendered only while selected. */
type BuiltinToolPanels = Record<BuiltinToolKind, () => ReactNode>;

/** Requires a panel for every built-in kind, so a new tool cannot silently render nothing. */
export function renderBuiltinToolPanel(
  kind: BuiltinToolKind,
  panels: BuiltinToolPanels,
): ReactNode {
  return panels[kind]();
}
