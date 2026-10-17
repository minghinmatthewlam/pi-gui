import type { ReactNode } from "react";
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
import { t } from "../../lib/i18n";

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

/**
 * Build the static nav entries. The titles, descriptions and search keywords
 * come from the locale dictionaries; only the icons and the `id` /
 * `needsWorkspace` shape are renderer-side. Calling this on every render lets
 * the user switch language and have the nav refresh instantly.
 */
function makeSections(): readonly SettingsSectionDefinition[] {
  return [
    {
      id: "general",
      title: t("settings.section.general.title"),
      group: t("settings.section.general.group"),
      icon: <SettingsIcon />,
      keywords: t("settings.section.general.keywords").split(", "),
      description: () => t("settings.section.general.description"),
      needsWorkspace: false,
    },
    {
      id: "appearance",
      title: t("settings.section.appearance.title"),
      group: t("settings.section.appearance.group"),
      icon: <SunIcon />,
      keywords: t("settings.section.appearance.keywords").split(", "),
      description: () => t("settings.section.appearance.description"),
      needsWorkspace: false,
    },
    {
      id: "notifications",
      title: t("settings.section.notifications.title"),
      group: t("settings.section.notifications.group"),
      icon: <BellIcon />,
      keywords: t("settings.section.notifications.keywords").split(", "),
      description: () => t("settings.section.notifications.description"),
      needsWorkspace: false,
    },
    {
      id: "shortcuts",
      title: t("settings.section.shortcuts.title"),
      group: t("settings.section.shortcuts.group"),
      icon: <KeyboardIcon />,
      keywords: t("settings.section.shortcuts.keywords").split(", "),
      description: () => t("settings.section.shortcuts.description"),
      needsWorkspace: false,
    },
    {
      id: "providers",
      title: t("settings.section.providers.title"),
      group: t("settings.section.providers.group"),
      icon: <PlugIcon />,
      keywords: t("settings.section.providers.keywords").split(", "),
      description: (workspaceName) =>
        t("settings.section.providers.description", { workspace: workspaceName }),
      needsWorkspace: true,
    },
    {
      id: "models",
      title: t("settings.section.models.title"),
      group: t("settings.section.models.group"),
      icon: <ModelIcon />,
      keywords: t("settings.section.models.keywords").split(", "),
      description: () => t("settings.section.models.description"),
      needsWorkspace: true,
    },
    {
      id: "mcp",
      title: t("settings.section.mcp.title"),
      group: t("settings.section.mcp.group"),
      icon: <ExtensionIcon />,
      keywords: t("settings.section.mcp.keywords").split(", "),
      description: () => t("settings.section.mcp.description"),
      needsWorkspace: true,
    },
  ];
}

/** Build a fresh list at call time so a locale change refreshes the nav. */
export function settingsSections(): readonly SettingsSectionDefinition[] {
  return makeSections();
}

/**
 * Initial section list. Consumers that need a stable reference (e.g. nav id
 * type unions) use `settingsSections()`; this constant keeps the inferred
 * `SettingsSection` type narrowing working without re-resolving.
 */
export const SETTINGS_SECTIONS = makeSections();

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Skills and extensions live in the settings nav but are their own app views. */
export const CUSTOMIZE_SECTION_ID = "customize";

export function settingsNavItems(): readonly SettingsSectionDefinition[] {
  const base = makeSections();
  return [
    ...base,
    {
      id: CUSTOMIZE_SECTION_ID,
      title: t("settings.section.customize.title"),
      group: t("settings.section.customize.group"),
      icon: <SkillIcon />,
      keywords: t("settings.section.customize.keywords").split(", "),
      description: () => "",
      needsWorkspace: false,
    },
  ];
}

/** Back-compat: callers that read the static nav before first render. */
export const SETTINGS_NAV_ITEMS = settingsNavItems();

export function settingsSectionDefinition(section: SettingsSection): SettingsSectionDefinition {
  const list = makeSections();
  return list.find((definition) => definition.id === section) ?? list[0]!;
}

export function sectionTitle(section: SettingsSection): string {
  return settingsSectionDefinition(section).title;
}
