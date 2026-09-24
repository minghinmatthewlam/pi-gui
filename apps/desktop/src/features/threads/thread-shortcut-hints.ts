import { getDesktopCommandFromShortcut, isRecentThreadCommand } from "../../../contracts/ipc";
import { createModifierHints } from "../../ui/modifier-hints";

/**
 * Cmd+1-9 hints on thread rows, from a press of the platform modifier (Command
 * on macOS, Control elsewhere) until it is released. A 1-9 thread switch keeps
 * them up while the modifier stays held. The terminal keeps Ctrl+1-9 for the
 * shell, so they never switch threads there.
 */
const threadShortcutHints = createModifierHints({
  modifierKey: (platform) => (platform === "darwin" ? "Meta" : "Control"),
  held: (event, platform) =>
    (platform === "darwin" ? event.metaKey : event.ctrlKey) && !event.altKey,
  keepsHints: (event) =>
    !event.inTerminal &&
    isRecentThreadCommand(
      getDesktopCommandFromShortcut({
        modifier: true,
        alt: event.altKey,
        shift: event.shiftKey,
        key: event.key,
        code: event.code,
      }),
    ),
});

export const nextThreadShortcutHintsVisible = threadShortcutHints.next;
export const dismissThreadShortcutHints = threadShortcutHints.dismiss;
export const useThreadShortcutHintsVisible = threadShortcutHints.useVisible;
