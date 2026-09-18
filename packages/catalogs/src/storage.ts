import type {
  SessionCatalogEntry,
  SessionCatalogSnapshot,
  SessionRef,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
  WorkspaceId,
  WorktreeCatalogEntry,
  WorktreeCatalogSnapshot,
  WorktreeId,
} from "./types.js";

export interface CatalogStorage {
  workspaces: {
    listWorkspaces(): Promise<WorkspaceCatalogSnapshot>;
    getWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceCatalogEntry | undefined>;
    upsertWorkspace(entry: WorkspaceCatalogEntry): Promise<void>;
    deleteWorkspace(workspaceId: WorkspaceId): Promise<void>;
  };
  sessions: {
    listSessions(workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot>;
    getSession(sessionRef: SessionRef): Promise<SessionCatalogEntry | undefined>;
    upsertSession(entry: SessionCatalogEntry): Promise<void>;
    deleteSession(sessionRef: SessionRef): Promise<void>;
  };
  worktrees: {
    listWorktrees(workspaceId?: WorkspaceId): Promise<WorktreeCatalogSnapshot>;
    getWorktree(worktreeId: WorktreeId): Promise<WorktreeCatalogEntry | undefined>;
    upsertWorktree(entry: WorktreeCatalogEntry): Promise<void>;
    deleteWorktree(worktreeId: WorktreeId): Promise<void>;
    replaceWorkspaceWorktrees(
      workspaceId: WorkspaceId,
      entries: readonly WorktreeCatalogEntry[],
    ): Promise<void>;
  };
}
