const KEY_PREFIX = "pi-gui:reviewed-files:v1";

export function reviewedFilesKey(workspaceId: string, sessionId: string): string {
  return `${KEY_PREFIX}:${workspaceId}:${sessionId}`;
}

export function loadReviewed(workspaceId: string, sessionId: string): ReadonlySet<string> {
  const raw = readStorage(reviewedFilesKey(workspaceId, sessionId));
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
    }
  } catch {
    // fall through to empty set
  }
  return new Set();
}

export function saveReviewed(
  workspaceId: string,
  sessionId: string,
  reviewed: ReadonlySet<string>,
): void {
  const key = reviewedFilesKey(workspaceId, sessionId);
  if (reviewed.size === 0) {
    removeStorage(key);
    return;
  }
  writeStorage(key, JSON.stringify([...reviewed].sort()));
}

export function pruneReviewed(
  reviewed: ReadonlySet<string>,
  currentPaths: readonly string[],
): ReadonlySet<string> {
  const allowed = new Set(currentPaths);
  let changed = false;
  const next = new Set<string>();
  for (const path of reviewed) {
    if (allowed.has(path)) {
      next.add(path);
    } else {
      changed = true;
    }
  }
  return changed ? next : reviewed;
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // localStorage unavailable; skip persistence
  }
}

function removeStorage(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // localStorage unavailable; skip persistence
  }
}
