import { SettingsGroup, SettingsRow } from "./settings-utils";

interface Shortcut {
  readonly title: string;
  /** Keys pressed together; "Mod" is Cmd on macOS and Ctrl elsewhere. */
  readonly keys: readonly string[];
}

// Mirrors getDesktopCommandFromShortcut in contracts/ipc.ts and the renderer-owned keys.
const SHORTCUT_GROUPS: readonly {
  readonly title: string;
  readonly shortcuts: readonly Shortcut[];
}[] = [
  {
    title: "App",
    shortcuts: [
      { title: "Command palette", keys: ["Mod", "K"] },
      { title: "Go to file", keys: ["Mod", "P"] },
      { title: "Open settings", keys: ["Mod", ","] },
      { title: "Toggle sidebar", keys: ["Mod", "B"] },
      { title: "Toggle side panel", keys: ["Mod", "Alt", "B"] },
    ],
  },
  {
    title: "Threads",
    shortcuts: [
      { title: "New thread", keys: ["Mod", "Shift", "O"] },
      { title: "Switch to recent thread", keys: ["Mod", "1–9"] },
      { title: "Send message", keys: ["Enter"] },
      { title: "New line", keys: ["Shift", "Enter"] },
    ],
  },
  {
    title: "Workbench",
    shortcuts: [
      { title: "Toggle terminal", keys: ["Mod", "J"] },
      { title: "New terminal tab", keys: ["Mod", "T"] },
      { title: "Toggle changes", keys: ["Mod", "D"] },
      { title: "Close workbench tab", keys: ["Mod", "W"] },
    ],
  },
];

const MAC_KEY_LABELS: Record<string, string> = {
  Mod: "⌘",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↩",
};

function keyLabel(platform: NodeJS.Platform, key: string): string {
  if (platform === "darwin") {
    return MAC_KEY_LABELS[key] ?? key;
  }
  return key === "Mod" ? "Ctrl" : key;
}

export function SettingsShortcutsSection({ platform }: { readonly platform: NodeJS.Platform }) {
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.shortcuts.map((shortcut) => (
            <SettingsRow key={shortcut.title} title={shortcut.title}>
              <span className="settings-keys">
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{keyLabel(platform, key)}</kbd>
                ))}
              </span>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}
    </>
  );
}
