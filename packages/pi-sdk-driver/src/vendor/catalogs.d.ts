declare module "@pi-app/catalogs" {
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

  export interface WorkspaceCatalogStorage {
    listWorkspaces(): Promise<WorkspaceCatalogSnapshot>;
    getWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceCatalogEntry | undefined>;
    upsertWorkspace(entry: WorkspaceCatalogEntry): Promise<void>;
    deleteWorkspace(workspaceId: WorkspaceId): Promise<void>;
  }

  export interface SessionCatalogStorage {
    listSessions(workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot>;
    getSession(sessionRef: SessionRef): Promise<SessionCatalogEntry | undefined>;
    upsertSession(entry: SessionCatalogEntry): Promise<void>;
    deleteSession(sessionRef: SessionRef): Promise<void>;
  }

  export interface WorktreeCatalogStorage {
    listWorktrees(workspaceId?: WorkspaceId): Promise<WorktreeCatalogSnapshot>;
    getWorktree(worktreeId: WorktreeId): Promise<WorktreeCatalogEntry | undefined>;
    upsertWorktree(entry: WorktreeCatalogEntry): Promise<void>;
    deleteWorktree(worktreeId: WorktreeId): Promise<void>;
    replaceWorkspaceWorktrees(workspaceId: WorkspaceId, entries: readonly WorktreeCatalogEntry[]): Promise<void>;
  }

  export interface CatalogStorage {
    workspaces: WorkspaceCatalogStorage;
    sessions: SessionCatalogStorage;
    worktrees: WorktreeCatalogStorage;
  }
}
