import type { ReactNode } from "react";
import type { BuiltinToolKind } from "../../../contracts/workbench";
import { BUILTIN_TOOL_ENTRIES } from "../workbench/builtin-tools";
import type { SettingsSection } from "../settings/settings-view";
import { sectionTitle } from "../settings/settings-sections";
import {
  ArchiveIcon,
  ClockIcon,
  ExtensionIcon,
  FileIcon,
  FolderIcon,
  ModelIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarToggleIcon,
  SidePanelIcon,
  SkillIcon,
} from "../../ui/icons";

export type PaletteMode = "commands" | "files" | "models";

/** Palette shortcut hints for the tools that have one. */
const TOOL_SHORTCUT_KEYS: Partial<Record<BuiltinToolKind, string>> = {
  changes: "D",
  terminal: "J",
};

export interface PaletteAction {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly hint?: string;
  /** Actions that open another palette list keep the palette open. */
  readonly keepsOpen?: boolean;
  readonly run: () => void;
}

/** "Settings" itself opens General. */
const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "appearance",
  "notifications",
  "shortcuts",
  "providers",
  "models",
];

export function formatShortcut(
  platform: NodeJS.Platform,
  key: string,
  modifiers: { readonly shift?: boolean; readonly alt?: boolean } = {},
): string {
  if (platform === "darwin") {
    return `${modifiers.alt ? "⌥" : ""}${modifiers.shift ? "⇧" : ""}⌘${key.toUpperCase()}`;
  }
  return `Ctrl+${modifiers.alt ? "Alt+" : ""}${modifiers.shift ? "Shift+" : ""}${key.toUpperCase()}`;
}

/** What the app can do right now; an action is listed only when it would work. */
export interface PaletteActionContext {
  readonly platform: NodeJS.Platform;
  readonly hasWorkspace: boolean;
  /** A thread is open in the main pane. */
  readonly thread?: { readonly pinned: boolean; readonly canSwitchModel: boolean };
  readonly canToggleSidebar: boolean;
  readonly newThread: () => void;
  readonly openFolder: () => void;
  readonly openSettings: (section: SettingsSection) => void;
  readonly openSkills: () => void;
  readonly openExtensions: () => void;
  readonly openScheduledTasks: () => void;
  readonly toggleSidebar: () => void;
  /** Shows the tool in the side panel, or hides the panel when that tool is already showing. */
  readonly toggleTool: (kind: BuiltinToolKind) => void;
  readonly toggleSidePanel: () => void;
  /** Extension views the side panel can open for this thread. */
  readonly extensionViews: readonly {
    readonly id: string;
    readonly title: string;
    readonly open: () => void;
  }[];
  readonly findInThread: () => void;
  readonly setThreadPinned: (pinned: boolean) => void;
  readonly archiveThread: () => void;
  readonly openPaletteMode: (mode: PaletteMode) => void;
}

export function buildPaletteActions(context: PaletteActionContext): readonly PaletteAction[] {
  const { platform, thread } = context;
  const actions: PaletteAction[] = [];
  if (context.hasWorkspace) {
    actions.push({
      id: "new-thread",
      title: "New thread",
      icon: <PlusIcon />,
      hint: formatShortcut(platform, "O", { shift: true }),
      run: context.newThread,
    });
  }
  actions.push({
    id: "open-folder",
    title: "Open folder…",
    icon: <FolderIcon />,
    run: context.openFolder,
  });
  if (thread) {
    actions.push(
      {
        id: "go-to-file",
        title: "Go to file…",
        icon: <FileIcon />,
        hint: formatShortcut(platform, "P"),
        keepsOpen: true,
        run: () => context.openPaletteMode("files"),
      },
      {
        id: "find-in-thread",
        title: "Find in thread",
        icon: <SearchIcon />,
        hint: formatShortcut(platform, "F"),
        run: context.findInThread,
      },
    );
    if (thread.canSwitchModel) {
      actions.push({
        id: "switch-model",
        title: "Switch model…",
        icon: <ModelIcon />,
        keepsOpen: true,
        run: () => context.openPaletteMode("models"),
      });
    }
    for (const { kind, label, Icon } of BUILTIN_TOOL_ENTRIES) {
      const key = TOOL_SHORTCUT_KEYS[kind];
      actions.push({
        id: `toggle-${kind}`,
        title: `Toggle ${label.toLowerCase()}`,
        icon: <Icon />,
        hint: key ? formatShortcut(platform, key) : undefined,
        run: () => context.toggleTool(kind),
      });
    }
    actions.push({
      id: "toggle-side-panel",
      title: "Toggle side panel",
      icon: <SidePanelIcon />,
      hint: formatShortcut(platform, "B", { alt: true }),
      run: context.toggleSidePanel,
    });
    for (const view of context.extensionViews) {
      actions.push({
        id: `extension-view:${view.id}`,
        title: `Open ${view.title}`,
        icon: <ExtensionIcon />,
        run: view.open,
      });
    }
    actions.push(
      {
        id: "pin-thread",
        title: thread.pinned ? "Unpin thread" : "Pin thread",
        icon: <PinIcon filled={thread.pinned} />,
        run: () => context.setThreadPinned(!thread.pinned),
      },
      {
        id: "archive-thread",
        title: "Archive thread",
        icon: <ArchiveIcon />,
        run: context.archiveThread,
      },
    );
  }
  if (context.canToggleSidebar) {
    actions.push({
      id: "toggle-sidebar",
      title: "Toggle sidebar",
      icon: <SidebarToggleIcon />,
      hint: formatShortcut(platform, "B"),
      run: context.toggleSidebar,
    });
  }
  actions.push({
    id: "scheduled-tasks",
    title: "Scheduled tasks",
    icon: <ClockIcon />,
    run: context.openScheduledTasks,
  });
  if (context.hasWorkspace) {
    actions.push(
      { id: "skills", title: "Skills", icon: <SkillIcon />, run: context.openSkills },
      {
        id: "extensions",
        title: "Extensions",
        icon: <ExtensionIcon />,
        run: context.openExtensions,
      },
    );
  }
  actions.push({
    id: "settings",
    title: "Settings",
    icon: <SettingsIcon />,
    hint: formatShortcut(platform, ","),
    run: () => context.openSettings("general"),
  });
  for (const section of SETTINGS_SECTIONS) {
    actions.push({
      id: `settings-${section}`,
      title: `Settings: ${sectionTitle(section)}`,
      icon: <SettingsIcon />,
      run: () => context.openSettings(section),
    });
  }
  return actions;
}
