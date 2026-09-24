import { SettingsGroup, SettingsRow } from "./settings-utils";

/**
 * "Mod" is Cmd on macOS and Ctrl elsewhere; "Ctrl" is Control on every platform.
 * "TabMod" is Control on macOS and Alt elsewhere, the side panel tab modifier.
 */
type KeyModifier = "Ctrl" | "Alt" | "Shift" | "Mod";
type Modifier = KeyModifier | "TabMod";

interface Shortcut {
  readonly title: string;
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

// Mirrors getDesktopCommandFromShortcut in contracts/ipc.ts and the keys the renderer handles
// itself (find, thread switcher, composer, terminal tabs).
const SHORTCUT_GROUPS: readonly {
  readonly title: string;
  readonly shortcuts: readonly Shortcut[];
}[] = [
  {
    title: "App",
    shortcuts: [
      { title: "Command palette", modifiers: ["Mod"], key: "K" },
      { title: "Go to file", modifiers: ["Mod"], key: "P" },
      { title: "Open settings", modifiers: ["Mod"], key: "," },
      { title: "Toggle sidebar", modifiers: ["Mod"], key: "B" },
      { title: "Toggle side panel", modifiers: ["Mod", "Alt"], key: "B" },
      { title: "New window", modifiers: ["Mod", "Shift"], key: "N" },
    ],
  },
  {
    title: "Threads",
    shortcuts: [
      { title: "New thread", modifiers: ["Mod"], key: "N" },
      { title: "Switch to recent thread", modifiers: ["Mod"], key: "1–9" },
      { title: "Cycle through threads", modifiers: ["Ctrl"], key: "Tab" },
      { title: "Find in thread", modifiers: ["Mod"], key: "F" },
    ],
  },
  {
    title: "Composer",
    shortcuts: [
      { title: "Send message, or queue it during a run", modifiers: [], key: "Enter" },
      { title: "Steer the running agent", modifiers: ["Mod"], key: "Enter" },
      { title: "New line", modifiers: ["Shift"], key: "Enter" },
    ],
  },
  {
    title: "Workbench",
    shortcuts: [
      { title: "Toggle terminal", modifiers: ["Mod"], key: "J" },
      { title: "New terminal tab", modifiers: ["Mod"], key: "T" },
      { title: "Toggle review", modifiers: ["Mod"], key: "R" },
      { title: "Switch to side panel tab", modifiers: ["TabMod"], key: "1–9" },
      { title: "Close workbench tab", modifiers: ["Mod"], key: "W" },
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
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.shortcuts.map((shortcut) => (
            <SettingsRow key={shortcut.title} title={shortcut.title}>
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
