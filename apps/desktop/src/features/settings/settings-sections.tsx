import type { ReactNode } from "react";
import { translate, type Translate } from "../../i18n";
import {
  BellIcon,
  ExtensionIcon,
  KeyboardIcon,
  ModelIcon,
  PlugIcon,
  SettingsIcon,
  SkillIcon,
  SunIcon,
} from "../../ui/icons";

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
export const settingsSectionIds = [
  "general",
  "appearance",
  "notifications",
  "shortcuts",
  "providers",
  "models",
  "mcp",
] as const;

export type SettingsSection = (typeof settingsSectionIds)[number];

/** Skills and extensions live in the settings nav but are their own app views. */
export const CUSTOMIZE_SECTION_ID = "customize";

/** Titles and descriptions are copy, so they are built per locale rather than module-level. */
export function settingsSections(t: Translate): readonly SettingsSectionDefinition[] {
  return [
    {
      id: "general",
      title: t("settings.nav.general"),
      group: t("settings.group.app"),
      icon: <SettingsIcon />,
      keywords: ["model settings scope", "per repo", "skill slash commands", "terminal", "shell"],
      description: () => t("settings.section.general.description"),
      needsWorkspace: false,
    },
    {
      id: "appearance",
      title: t("settings.nav.appearance"),
      group: t("settings.group.app"),
      icon: <SunIcon />,
      keywords: ["theme", "light", "dark", "system", "preset", "colors", "transparency"],
      description: () => t("settings.section.appearance.description"),
      needsWorkspace: false,
    },
    {
      id: "notifications",
      title: t("settings.nav.notifications"),
      group: t("settings.group.app"),
      icon: <BellIcon />,
      keywords: ["alerts", "background", "completion", "failures", "approval", "macos"],
      description: () => t("settings.section.notifications.description"),
      needsWorkspace: false,
    },
    {
      id: "shortcuts",
      title: t("settings.nav.shortcuts"),
      group: t("settings.group.app"),
      icon: <KeyboardIcon />,
      keywords: ["keys", "hotkeys", "keybindings"],
      description: () => t("settings.section.shortcuts.description"),
      needsWorkspace: false,
    },
    {
      id: "providers",
      title: t("settings.nav.providers"),
      group: t("settings.group.agent"),
      icon: <PlugIcon />,
      keywords: ["login", "logout", "oauth", "api key", "auth", "custom endpoint"],
      description: (workspaceName) =>
        t("settings.section.providers.description", { workspace: workspaceName }),
      needsWorkspace: true,
    },
    {
      id: "models",
      title: t("settings.nav.models"),
      group: t("settings.group.agent"),
      icon: <ModelIcon />,
      keywords: ["default model", "reasoning", "thinking", "enabled models"],
      description: () => t("settings.section.models.description"),
      needsWorkspace: true,
    },
    {
      id: "mcp",
      title: t("settings.nav.mcp"),
      group: t("settings.group.agent"),
      icon: <ExtensionIcon />,
      keywords: ["mcp", "mcp.json", "model context protocol", "servers", "code mode", "codemode"],
      description: () => t("settings.section.mcp.description"),
      needsWorkspace: true,
    },
  ];
}

export function settingsNavItems(t: Translate) {
  return [
    ...settingsSections(t),
    {
      id: CUSTOMIZE_SECTION_ID,
      title: t("settings.nav.customize"),
      group: t("settings.group.customize"),
      icon: <SkillIcon />,
      keywords: ["skills", "extensions", "plugins", "slash commands", "tools"],
    },
  ];
}

export function settingsSectionDefinition(
  section: SettingsSection,
  t: Translate,
): SettingsSectionDefinition {
  const sections = settingsSections(t);
  return sections.find((definition) => definition.id === section) ?? sections[0]!;
}

/** English unless a locale is passed; the command palette builds labels outside React. */
export function sectionTitle(section: SettingsSection, t: Translate = translate): string {
  return settingsSectionDefinition(section, t).title;
}
