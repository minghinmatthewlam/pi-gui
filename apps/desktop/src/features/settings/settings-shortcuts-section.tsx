import { useTranslation, type MessageKey } from "../../i18n";
import { SettingsGroup, SettingsRow } from "./settings-utils";

/**
 * "Mod" is Cmd on macOS and Ctrl elsewhere; "Ctrl" is Control on every platform.
 * "TabMod" is Control on macOS and Alt elsewhere, the side panel tab modifier.
 */
type KeyModifier = "Ctrl" | "Alt" | "Shift" | "Mod";
type Modifier = KeyModifier | "TabMod";

interface Shortcut {
  readonly titleKey: MessageKey;
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

interface ShortcutGroup {
  readonly titleKey: MessageKey;
  readonly shortcuts: readonly Shortcut[];
}

// Mirrors getDesktopCommandFromShortcut in contracts/ipc.ts and the keys the renderer handles
// itself (find, thread switcher, composer, terminal tabs).
const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    titleKey: "settings.shortcuts.groupApp",
    shortcuts: [
      { titleKey: "settings.shortcuts.commandPalette", modifiers: ["Mod"], key: "K" },
      { titleKey: "settings.shortcuts.goToFile", modifiers: ["Mod"], key: "P" },
      { titleKey: "settings.shortcuts.openSettings", modifiers: ["Mod"], key: "," },
      { titleKey: "settings.shortcuts.toggleSidebar", modifiers: ["Mod"], key: "B" },
      { titleKey: "settings.shortcuts.toggleSidePanel", modifiers: ["Mod", "Alt"], key: "B" },
      { titleKey: "settings.shortcuts.newWindow", modifiers: ["Mod", "Shift"], key: "N" },
    ],
  },
  {
    titleKey: "settings.shortcuts.groupThreads",
    shortcuts: [
      { titleKey: "settings.shortcuts.newThread", modifiers: ["Mod"], key: "N" },
      { titleKey: "settings.shortcuts.switchRecent", modifiers: ["Mod"], key: "1–9" },
      { titleKey: "settings.shortcuts.cycleThreads", modifiers: ["Ctrl"], key: "Tab" },
      { titleKey: "settings.shortcuts.findInThread", modifiers: ["Mod"], key: "F" },
    ],
  },
  {
    titleKey: "settings.shortcuts.groupComposer",
    shortcuts: [
      { titleKey: "settings.shortcuts.send", modifiers: [], key: "Enter" },
      { titleKey: "settings.shortcuts.steer", modifiers: ["Mod"], key: "Enter" },
      { titleKey: "settings.shortcuts.newLine", modifiers: ["Shift"], key: "Enter" },
    ],
  },
  {
    titleKey: "settings.shortcuts.groupWorkbench",
    shortcuts: [
      { titleKey: "settings.shortcuts.toggleTerminal", modifiers: ["Mod"], key: "J" },
      { titleKey: "settings.shortcuts.newTerminalTab", modifiers: ["Mod"], key: "T" },
      { titleKey: "settings.shortcuts.toggleReview", modifiers: ["Mod"], key: "R" },
      { titleKey: "settings.shortcuts.switchSidePanelTab", modifiers: ["TabMod"], key: "1–9" },
      { titleKey: "settings.shortcuts.closeWorkbenchTab", modifiers: ["Mod"], key: "W" },
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
  const { t } = useTranslation();
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
