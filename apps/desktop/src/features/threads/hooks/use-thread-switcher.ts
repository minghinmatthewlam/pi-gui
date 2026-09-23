import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadListEntry } from "../thread-groups";
import { dismissThreadShortcutHints } from "../thread-shortcut-hints";

/** A quick Ctrl-Tab tap swaps threads without flashing the overlay. */
export const THREAD_SWITCHER_OVERLAY_DELAY_MS = 150;

export interface ThreadSwitcherState {
  readonly entries: readonly ThreadListEntry[];
  readonly index: number;
  readonly overlayVisible: boolean;
}

export interface ThreadSwitcherSource {
  /** Threads most recently used first. */
  readonly entries: readonly ThreadListEntry[];
  /** Whether `entries[0]` is the thread on screen, so the previous one is preselected. */
  readonly firstIsCurrent: boolean;
}

interface UseThreadSwitcherOptions {
  readonly readSource: () => ThreadSwitcherSource;
  readonly onSelect: (entry: ThreadListEntry) => void;
}

/**
 * VS Code style Ctrl-Tab: hold Control, press Tab to step through threads in
 * most-recently-used order (Shift-Tab steps back), release Control to open the
 * selection. Ctrl-Tab stays Control on macOS, like VS Code and browsers.
 */
export function useThreadSwitcher(options: UseThreadSwitcherOptions) {
  const [state, setState] = useState<ThreadSwitcherState | null>(null);
  const stateRef = useRef<ThreadSwitcherState | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const overlayTimerRef = useRef<number | undefined>(undefined);

  const update = useCallback((next: ThreadSwitcherState | null) => {
    stateRef.current = next;
    setState(next);
    if (!next || next.overlayVisible) {
      window.clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = undefined;
    }
  }, []);

  const cancel = useCallback(() => update(null), [update]);

  const choose = useCallback(
    (index: number) => {
      const entry = stateRef.current?.entries[index];
      update(null);
      if (entry) optionsRef.current.onSelect(entry);
    },
    [update],
  );

  useEffect(() => {
    const step = (current: ThreadSwitcherState, delta: number) => {
      const count = current.entries.length;
      update({ ...current, index: (current.index + delta + count) % count, overlayVisible: true });
    };

    const open = (backward: boolean): boolean => {
      const source = optionsRef.current.readSource();
      const count = source.entries.length;
      const minimum = source.firstIsCurrent ? 2 : 1;
      if (count < minimum) return false;
      const index = backward ? count - 1 : source.firstIsCurrent ? 1 : 0;
      update({ entries: source.entries, index, overlayVisible: false });
      overlayTimerRef.current = window.setTimeout(() => {
        const current = stateRef.current;
        if (current && !current.overlayVisible) update({ ...current, overlayVisible: true });
      }, THREAD_SWITCHER_OVERLAY_DELAY_MS);
      return true;
    };

    const swallow = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    // Capture phase, so the composer, dialogs and the terminal never see the Tab.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const current = stateRef.current;
      const isSwitchChord = event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey;
      if (isSwitchChord) {
        if (current) {
          swallow(event);
          step(current, event.shiftKey ? -1 : 1);
          return;
        }
        // Leave modal dialogs and an in-progress thread or folder rename alone.
        if (document.querySelector("[aria-modal='true']")) return;
        if (event.target instanceof Element && event.target.closest(".workspace-rename")) return;
        if (open(event.shiftKey)) {
          swallow(event);
          // The swallowed Tab never reaches the hint listener, so end the Ctrl+1-9 badges here.
          dismissThreadShortcutHints();
        }
        return;
      }
      if (!current) return;
      if (event.key === "Control" || event.key === "Shift") return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        swallow(event);
        step(current, event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter") {
        swallow(event);
        choose(current.index);
        return;
      }
      if (event.key === "Escape") swallow(event);
      cancel();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const current = stateRef.current;
      if (current && (event.key === "Control" || !event.ctrlKey)) {
        choose(current.index);
      }
    };

    // A missed Control keyup (a native popup took it) must not leave the list open.
    const handlePointerDown = (event: PointerEvent) => {
      if (stateRef.current && !event.ctrlKey) cancel();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", cancel);
      window.clearTimeout(overlayTimerRef.current);
    };
  }, [cancel, choose, update]);

  return { state, choose, cancel };
}
