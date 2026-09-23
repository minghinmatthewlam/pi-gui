import type { ReactNode } from "react";
import { BellIcon, KeyboardIcon, ModelIcon, PlugIcon, SettingsIcon, SunIcon } from "../../ui/icons";

export interface SettingsSectionDefinition {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly icon: ReactNode;
  /** Words people search for that are not in the title, such as the page's row titles. */
  readonly keywords: readonly string[];
  readonly description: (workspaceName: string) => string;
  /** Pages that read or write one workspace's runtime. */
  readonly needsWorkspace: boolean;
}

/** Nav order: grouped the way Codex groups its settings, one entry per page. */
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    title: "General",
    group: "App",
    icon: <SettingsIcon />,
    keywords: ["model settings scope", "per repo", "skill slash commands", "terminal", "shell"],
    description: () => "App and runtime defaults.",
    needsWorkspace: false,
  },
  {
    id: "appearance",
    title: "Appearance",
    group: "App",
    icon: <SunIcon />,
    keywords: ["theme", "light", "dark", "system", "preset", "colors", "transparency"],
    description: () => "Choose light, dark or system mode and a color preset.",
    needsWorkspace: false,
  },
  {
    id: "notifications",
    title: "Notifications",
    group: "App",
    icon: <BellIcon />,
    keywords: ["alerts", "background", "completion", "failures", "approval", "macos"],
    description: () => "Choose which background events alert you.",
    needsWorkspace: false,
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    group: "App",
    icon: <KeyboardIcon />,
    keywords: ["keys", "hotkeys", "keybindings"],
    description: () => "Shortcuts available across the app.",
    needsWorkspace: false,
  },
  {
    id: "providers",
    title: "Providers",
    group: "Agent",
    icon: <PlugIcon />,
    keywords: ["login", "logout", "oauth", "api key", "auth", "custom endpoint"],
    description: (workspaceName) => `Connect providers and manage auth for ${workspaceName}.`,
    needsWorkspace: true,
  },
  {
    id: "models",
    title: "Models",
    group: "Agent",
    icon: <ModelIcon />,
    keywords: ["default model", "reasoning", "thinking", "enabled models"],
    description: () => "Choose the default model and which models appear in pickers.",
    needsWorkspace: true,
  },
] as const satisfies readonly SettingsSectionDefinition[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function settingsSectionDefinition(section: SettingsSection): SettingsSectionDefinition {
  return SETTINGS_SECTIONS.find((definition) => definition.id === section) ?? SETTINGS_SECTIONS[0];
}

export function sectionTitle(section: SettingsSection): string {
  return settingsSectionDefinition(section).title;
}
