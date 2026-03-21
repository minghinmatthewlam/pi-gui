import type { SessionRef, WorkspaceId } from "@pi-app/session-driver";

export type { SessionRef, WorkspaceId };

export interface WorkspaceCatalogEntry {
  workspaceId: WorkspaceId;
  path: string;
  displayName: string;
  lastOpenedAt: string;
  sortOrder: number;
  pinned?: boolean;
}

export type WorktreeId = string;
export type WorktreeKind = "primary" | "linked";
export type WorktreeStatus = "ready" | "missing" | "error";

export interface WorktreeCatalogEntry {
  worktreeId: WorktreeId;
  workspaceId: WorkspaceId;
  path: string;
  displayName: string;
  kind: WorktreeKind;
  status: WorktreeStatus;
  branchName?: string;
  headSha?: string;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeCatalogSnapshot {
  worktrees: WorktreeCatalogEntry[];
}

export type SessionStatus = "idle" | "running" | "failed";

export interface SessionCatalogEntry {
  sessionRef: SessionRef;
  workspaceId: WorkspaceId;
  title: string;
  updatedAt: string;
  archivedAt?: string;
  previewSnippet?: string;
  sessionFilePath?: string;
  status: SessionStatus;
}

export interface WorkspaceCatalogSnapshot {
  workspaces: WorkspaceCatalogEntry[];
}

export interface SessionCatalogSnapshot {
  sessions: SessionCatalogEntry[];
}
