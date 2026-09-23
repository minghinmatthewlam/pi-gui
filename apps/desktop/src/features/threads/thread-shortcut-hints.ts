import { useEffect, useSyncExternalStore } from "react";

type HintKeyEvent = Pick<KeyboardEvent, "type" | "key" | "shiftKey" | "altKey">;

/**
 * Cmd+1-9 hints show from a press of the platform modifier (Command on macOS,
 * Control elsewhere) until it is released. Any other key ends them until the
 * modifier is pressed again: a chord was used, and macOS can drop the modifier
 * keyup after a chord the main process consumed.
 */
export function nextThreadShortcutHintsVisible(
  current: boolean,
  event: HintKeyEvent,
  platform: NodeJS.Platform,
): boolean {
  const modifierKey = platform === "darwin" ? "Meta" : "Control";
  if (event.key === modifierKey) {
    return event.type === "keydown" && !event.shiftKey && !event.altKey;
  }
  return event.type === "keydown" ? false : current;
}

let visible = false;
const listeners = new Set<() => void>();

function setVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Main-process shortcuts never reach the renderer as keydown; end hints on them. */
export function dismissThreadShortcutHints(): void {
  setVisible(false);
}

export function useThreadShortcutHintsVisible(platform: NodeJS.Platform): boolean {
  useEffect(() => {
    const sync = (event: KeyboardEvent) => {
      setVisible(nextThreadShortcutHintsVisible(visible, event, platform));
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", dismissThreadShortcutHints);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", dismissThreadShortcutHints);
      dismissThreadShortcutHints();
    };
  }, [platform]);
  return useSyncExternalStore(subscribe, () => visible);
}
