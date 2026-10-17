import { SettingsGroup, SettingsRow } from "./settings-utils";
import { t, useLocale } from "../../lib/i18n";

/**
 * "Mod" is Cmd on macOS and Ctrl elsewhere; "Ctrl" is Control on every platform.
 * "TabMod" is Control on macOS and Alt elsewhere, the side panel tab modifier.
 */
type KeyModifier = "Ctrl" | "Alt" | "Shift" | "Mod";
type Modifier = KeyModifier | "TabMod";

interface Shortcut {
  readonly titleKey: string;
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

// Mirrors getDesktopCommandFromShortcut in contracts/ipc.ts and the keys the renderer handles
// itself (find, thread switcher, composer, terminal tabs).
const SHORTCUT_GROUPS: readonly {
  readonly titleKey: string;
  readonly shortcuts: readonly Shortcut[];
}[] = [
  {
    titleKey: "settings.shortcuts.group.app",
    shortcuts: [
      { titleKey: "settings.shortcuts.command_palette", modifiers: ["Mod"], key: "K" },
      { titleKey: "settings.shortcuts.go_to_file", modifiers: ["Mod"], key: "P" },
      { titleKey: "settings.shortcuts.open_settings", modifiers: ["Mod"], key: "," },
      { titleKey: "settings.shortcuts.toggle_sidebar", modifiers: ["Mod"], key: "B" },
      { titleKey: "settings.shortcuts.toggle_side_panel", modifiers: ["Mod", "Alt"], key: "B" },
      { titleKey: "settings.shortcuts.new_window", modifiers: ["Mod", "Shift"], key: "N" },
    ],
  },
  {
    titleKey: "settings.shortcuts.group.threads",
    shortcuts: [
      { titleKey: "settings.shortcuts.new_thread", modifiers: ["Mod"], key: "N" },
      { titleKey: "settings.shortcuts.switch_recent_thread", modifiers: ["Mod"], key: "1–9" },
      { titleKey: "settings.shortcuts.cycle_threads", modifiers: ["Ctrl"], key: "Tab" },
      { titleKey: "settings.shortcuts.find_in_thread", modifiers: ["Mod"], key: "F" },
    ],
  },
  {
    titleKey: "settings.shortcuts.group.composer",
    shortcuts: [
      { titleKey: "settings.shortcuts.send_message", modifiers: [], key: "Enter" },
      { titleKey: "settings.shortcuts.steer_running_agent", modifiers: ["Mod"], key: "Enter" },
      { titleKey: "settings.shortcuts.new_line", modifiers: ["Shift"], key: "Enter" },
    ],
  },
  {
    titleKey: "settings.shortcuts.group.workbench",
    shortcuts: [
      { titleKey: "settings.shortcuts.toggle_terminal", modifiers: ["Mod"], key: "J" },
      { titleKey: "settings.shortcuts.new_terminal_tab", modifiers: ["Mod"], key: "T" },
      { titleKey: "settings.shortcuts.toggle_review", modifiers: ["Mod"], key: "R" },
      { titleKey: "settings.shortcuts.switch_side_panel_tab", modifiers: ["TabMod"], key: "1–9" },
      { titleKey: "settings.shortcuts.close_workbench_tab", modifiers: ["Mod"], key: "W" },
    ],
  },
];

// Apple's modifier order is ⌃⌥⇧⌘, matching the menu bar and the command palette hints.
const MAC_MODIFIERS: readonly (readonly [KeyModifier, string])[] = [
  ["Ctrl", "⌃"],
  ["Alt", "⌥"],
  ["Shift", "⇧"],
  ["Mod", "⌘"],
];

function shortcutKeys(platform: NodeJS.Platform, shortcut: Shortcut): readonly string[] {
  const held = shortcut.modifiers.map((modifier): KeyModifier =>
    modifier === "TabMod" ? (platform === "darwin" ? "Ctrl" : "Alt") : modifier,
  );
  if (platform === "darwin") {
    const modifiers = MAC_MODIFIERS.filter(([modifier]) => held.includes(modifier)).map(
      ([, symbol]) => symbol,
    );
    return [...modifiers, shortcut.key === "Enter" ? "↩" : shortcut.key];
  }
  const modifiers = (["Ctrl", "Alt", "Shift"] as const).filter(
    (modifier) => held.includes(modifier) || (modifier === "Ctrl" && held.includes("Mod")),
  );
  return [...modifiers, shortcut.key];
}

export function SettingsShortcutsSection({ platform }: { readonly platform: NodeJS.Platform }) {
  // Subscribing makes the section re-render when the user picks a new locale.
  useLocale();
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => (
        <SettingsGroup key={group.titleKey} title={t(group.titleKey)}>
          {group.shortcuts.map((shortcut) => (
            <SettingsRow key={shortcut.titleKey} title={t(shortcut.titleKey)}>
              <span className="settings-keys">
                {shortcutKeys(platform, shortcut).map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}
    </>
  );
}
