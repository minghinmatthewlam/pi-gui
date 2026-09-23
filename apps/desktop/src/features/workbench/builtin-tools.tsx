import type { ComponentType, ReactNode } from "react";
import { BUILTIN_TOOL_KINDS, type BuiltinToolKind } from "../../../contracts/workbench";
import { DiffIcon, FileIcon, TerminalIcon, WorktreeIcon } from "../../ui/icons";

interface BuiltinToolDefinition {
  readonly label: string;
  /** Shown in the tool chooser. */
  readonly description: string;
  readonly Icon: ComponentType;
}

/** Presentation for every built-in tool; a missing kind fails the build. */
export const BUILTIN_TOOLS = {
  files: { label: "Files", description: "Browse files in this checkout", Icon: FileIcon },
  changes: { label: "Changes", description: "Review uncommitted changes", Icon: DiffIcon },
  worktrees: {
    label: "Worktrees",
    description: "Open a task in another checkout",
    Icon: WorktreeIcon,
  },
  terminal: {
    label: "Terminal",
    description: "Run commands in this task's checkout",
    Icon: TerminalIcon,
  },
} as const satisfies Record<BuiltinToolKind, BuiltinToolDefinition>;

/** Chooser order follows the contract's kind list. */
export const BUILTIN_TOOL_ENTRIES = BUILTIN_TOOL_KINDS.map((kind) => ({
  kind,
  ...BUILTIN_TOOLS[kind],
}));

/** The composition root supplies one panel per built-in tool; rendered only while selected. */
type BuiltinToolPanels = Record<BuiltinToolKind, () => ReactNode>;

/** Requires a panel for every built-in kind, so a new tool cannot silently render nothing. */
export function renderBuiltinToolPanel(
  kind: BuiltinToolKind,
  panels: BuiltinToolPanels,
): ReactNode {
  return panels[kind]();
}
