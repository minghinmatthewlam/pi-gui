import { useEffect, useSyncExternalStore } from "react";
import { getDesktopCommandFromShortcut, isRecentThreadCommand } from "../../../contracts/ipc";

type ModifierState = Pick<KeyboardEvent, "metaKey" | "ctrlKey">;
type HintKeyEvent = ModifierState &
  Pick<KeyboardEvent, "type" | "key" | "code" | "shiftKey" | "altKey"> & {
    /** The terminal keeps Ctrl+1-9 for the shell, so they never switch threads there. */
    readonly inTerminal: boolean;
  };

function modifierHeld(event: ModifierState, platform: NodeJS.Platform): boolean {
  return platform === "darwin" ? event.metaKey : event.ctrlKey;
}

/**
 * Cmd+1-9 hints show from a press of the platform modifier (Command on macOS,
 * Control elsewhere) until it is released. A 1-9 thread switch keeps them up
 * while the modifier stays held. Any other key ends them until the modifier is
 * pressed again. A key or pointer event reporting the modifier up also ends
 * them, because macOS can drop the modifier keyup after a chord the main
 * process consumed; until such an event or a window blur, they stay up.
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
  const held = modifierHeld(event, platform);
  if (!current || !held) return false;
  if (event.type !== "keydown") return true;
  return (
    !event.inTerminal &&
    isRecentThreadCommand(
      getDesktopCommandFromShortcut({
        modifier: held,
        alt: event.altKey,
        shift: event.shiftKey,
        key: event.key,
        code: event.code,
      }),
    )
  );
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
    const syncKey = (event: KeyboardEvent) => {
      // KeyboardEvent fields are prototype getters, so copy them rather than spread.
      const { type, key, code, metaKey, ctrlKey, shiftKey, altKey, target } = event;
      const inTerminal = target instanceof Element && target.closest("[data-pi-terminal]") !== null;
      setVisible(
        nextThreadShortcutHintsVisible(
          visible,
          { type, key, code, metaKey, ctrlKey, shiftKey, altKey, inTerminal },
          platform,
        ),
      );
    };
    const syncPointer = (event: PointerEvent) => {
      if (visible && !modifierHeld(event, platform)) dismissThreadShortcutHints();
    };
    window.addEventListener("keydown", syncKey);
    window.addEventListener("keyup", syncKey);
    window.addEventListener("pointermove", syncPointer);
    window.addEventListener("pointerdown", syncPointer);
    window.addEventListener("blur", dismissThreadShortcutHints);
    return () => {
      window.removeEventListener("keydown", syncKey);
      window.removeEventListener("keyup", syncKey);
      window.removeEventListener("pointermove", syncPointer);
      window.removeEventListener("pointerdown", syncPointer);
      window.removeEventListener("blur", dismissThreadShortcutHints);
      dismissThreadShortcutHints();
    };
  }, [platform]);
  return useSyncExternalStore(subscribe, () => visible);
}
