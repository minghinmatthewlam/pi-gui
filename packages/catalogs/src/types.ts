import type { SessionRef, SessionStatus, WorkspaceId } from "@pi-gui/session-driver";

export type { SessionRef, SessionStatus, WorkspaceId };

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

export interface SessionCatalogEntry {
  sessionRef: SessionRef;
  workspaceId: WorkspaceId;
  title: string;
  updatedAt: string;
  archivedAt?: string;
  previewSnippet?: string;
  sessionFilePath?: string;
  status: SessionStatus;
  /**
   * The last run was stopped (pi reported it aborted) while this reply entry was the newest
   * on its branch. Kept here because pi's session file does not record a Stop that left no
   * aborted reply. It only counts while that entry is still the newest reply. Written only
   * by setStoppedReplyId; reads attach it, and entry writes ignore it.
   */
  stoppedReplyId?: string;
}

export interface WorkspaceCatalogSnapshot {
  workspaces: WorkspaceCatalogEntry[];
}

export interface SessionCatalogSnapshot {
  sessions: SessionCatalogEntry[];
}
