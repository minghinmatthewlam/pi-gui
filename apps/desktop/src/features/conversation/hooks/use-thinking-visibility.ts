import { useMemo, useSyncExternalStore } from "react";

/**
 * Which replies show their model reasoning, as one renderer-wide view state:
 * Cmd/Ctrl+T (terminal pi's thinking toggle) opens or closes every section at once,
 * and it stays that way across threads. Opening or closing a single reply records an
 * exception for just that reply; the next Cmd/Ctrl+T clears them. Reasoning is closed
 * by default so the reply stays the thing you read.
 */
interface ThinkingState {
  readonly showAll: boolean;
  readonly exceptions: ReadonlySet<string>;
}

let state: ThinkingState = { showAll: false, exceptions: new Set() };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function replace(next: ThinkingState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Opens or closes every reasoning section in the transcripts of this window. */
export function toggleThinkingVisibility(): void {
  replace({ showAll: !state.showAll, exceptions: new Set() });
}

/** Flips one reply, leaving every other reply on the global setting. */
export function toggleThinkingRow(messageId: string): void {
  const exceptions = new Set(state.exceptions);
  if (exceptions.has(messageId)) exceptions.delete(messageId);
  else exceptions.add(messageId);
  replace({ showAll: state.showAll, exceptions });
}

export function isThinkingOpen(messageId: string): boolean {
  return state.exceptions.has(messageId) ? !state.showAll : state.showAll;
}

export interface ThinkingVisibility {
  readonly isOpen: (messageId: string) => boolean;
  readonly toggleRow: (messageId: string) => void;
}

/** Reads the shared state so a transcript redraws when the chord flips it. */
export function useThinkingVisibility(): ThinkingVisibility {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  return useMemo(() => ({ isOpen: isThinkingOpen, toggleRow: toggleThinkingRow }), [current]);
}
