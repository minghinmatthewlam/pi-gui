import type { WorkspaceCatalogEntry, SessionCatalogEntry, WorktreeCatalogEntry } from "../types.js";

export type CatalogFileState = {
  version: 2;
  workspaces: WorkspaceCatalogEntry[];
  sessions: SessionCatalogEntry[];
  worktrees: WorktreeCatalogEntry[];
  sessionFiles: Record<string, string>;
};

export function createEmptyState(): CatalogFileState {
  return {
    version: 2,
    workspaces: [],
    sessions: [],
    worktrees: [],
    sessionFiles: {},
  };
}

export function parseState(raw: string, filePath: string): CatalogFileState {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2)) {
    throw new Error(`Unsupported catalog file format in ${filePath}.`);
  }

  // Version 1 predates worktrees; omitted collections were historically empty.
  // Never recover a malformed collection by dropping entries: callers use the
  // catalog to decide which session attachments are still referenced.
  const workspaces =
    parsed.version === 1 && parsed.workspaces === undefined ? [] : parsed.workspaces;
  const sessions = parsed.version === 1 && parsed.sessions === undefined ? [] : parsed.sessions;
  const worktrees = parsed.version === 1 && parsed.worktrees === undefined ? [] : parsed.worktrees;
  const sessionFiles =
    parsed.version === 1 && parsed.sessionFiles === undefined ? {} : parsed.sessionFiles;
  if (
    !isEntryArray(workspaces, isWorkspaceEntry) ||
    !isEntryArray(sessions, isSessionEntry) ||
    !isEntryArray(worktrees, isWorktreeEntry) ||
    !isStringRecord(sessionFiles)
  ) {
    throw new Error(
      `Invalid catalog file contents in ${filePath}; original file was left unchanged.`,
    );
  }

  return {
    version: 2,
    workspaces: workspaces.map(cloneWorkspaceEntry),
    sessions: sessions.map(cloneSessionEntry),
    worktrees: worktrees.map(cloneWorktreeEntry),
    sessionFiles: { ...sessionFiles },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isEntryArray<T>(value: unknown, check: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every(check);
}

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

function hasOptionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === "string");
}

function isWorkspaceEntry(value: unknown): value is WorkspaceCatalogEntry {
  return (
    isRecord(value) &&
    hasStrings(value, ["workspaceId", "path", "displayName", "lastOpenedAt"]) &&
    typeof value.sortOrder === "number" &&
    Number.isFinite(value.sortOrder) &&
    (value.pinned === undefined || typeof value.pinned === "boolean")
  );
}

function isSessionEntry(value: unknown): value is SessionCatalogEntry {
  return (
    isRecord(value) &&
    hasStrings(value, ["workspaceId", "title", "updatedAt"]) &&
    hasOptionalStrings(value, ["archivedAt", "previewSnippet", "sessionFilePath"]) &&
    isRecord(value.sessionRef) &&
    hasStrings(value.sessionRef, ["workspaceId", "sessionId"]) &&
    value.sessionRef.workspaceId === value.workspaceId &&
    (value.status === "idle" || value.status === "running" || value.status === "failed")
  );
}

function isWorktreeEntry(value: unknown): value is WorktreeCatalogEntry {
  return (
    isRecord(value) &&
    hasStrings(value, [
      "worktreeId",
      "workspaceId",
      "path",
      "displayName",
      "createdAt",
      "updatedAt",
    ]) &&
    hasOptionalStrings(value, ["branchName", "headSha"]) &&
    (value.pinned === undefined || typeof value.pinned === "boolean") &&
    (value.kind === "primary" || value.kind === "linked") &&
    (value.status === "ready" || value.status === "missing" || value.status === "error")
  );
}

export function cloneWorkspaceEntry(entry: WorkspaceCatalogEntry): WorkspaceCatalogEntry {
  return { ...entry };
}

export function cloneSessionEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
  return {
    ...entry,
    sessionRef: { ...entry.sessionRef },
  };
}

export function cloneWorktreeEntry(entry: WorktreeCatalogEntry): WorktreeCatalogEntry {
  return { ...entry };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
