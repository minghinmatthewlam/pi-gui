import { sessionThreadKey, type ThreadListEntry } from "./thread-groups";

// Renderer-local view state, shared by every window through localStorage.
const STORAGE_KEY = "pi-gui:thread-switcher-order:v1";
export const THREAD_SWITCHER_ORDER_LIMIT = 100;

/** Moves `threadKey` to the front: opening a thread (and sending in it) counts as use. */
export function touchThreadSwitcherOrder(
  order: readonly string[],
  threadKey: string,
): readonly string[] {
  if (order[0] === threadKey) return order;
  return [threadKey, ...order.filter((key) => key !== threadKey)].slice(
    0,
    THREAD_SWITCHER_ORDER_LIMIT,
  );
}

/**
 * Lists non-archived threads most recently used first. Threads never opened
 * since tracking began follow in sidebar recency order. Archived and deleted
 * threads are absent from `recencyOrder`, so their stale keys drop out here;
 * an unarchived thread returns at its old position.
 */
export function orderThreadSwitcherEntries(
  recencyOrder: readonly ThreadListEntry[],
  order: readonly string[],
): readonly ThreadListEntry[] {
  const rank = new Map(order.map((key, index) => [key, index] as const));
  const used: ThreadListEntry[] = [];
  const unused: ThreadListEntry[] = [];
  for (const entry of recencyOrder) {
    (rank.has(sessionThreadKey(entry)) ? used : unused).push(entry);
  }
  used.sort(
    (left, right) =>
      (rank.get(sessionThreadKey(left)) ?? 0) - (rank.get(sessionThreadKey(right)) ?? 0),
  );
  return [...used, ...unused];
}

export function loadThreadSwitcherOrder(): readonly string[] {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, THREAD_SWITCHER_ORDER_LIMIT);
    }
  } catch {
    // fall through to an empty order
  }
  return [];
}

export function saveThreadSwitcherOrder(order: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // localStorage unavailable; skip persistence
  }
}
