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
    /** Writes the entry; its stoppedReplyId is ignored, the stored one is kept. */
    upsertSession(entry: SessionCatalogEntry): Promise<void>;
    /**
     * The only writer of stoppedReplyId: sets it, or clears it with undefined. It is kept
     * apart from the entry, so it holds before the entry exists and through any entry
     * rewrite; only deleting the session removes it.
     */
    setStoppedReplyId(sessionRef: SessionRef, replyId: string | undefined): Promise<void>;
    /**
     * Sets archivedAt in one serialized step with reading the session's stopped-run mark, and
     * refuses (resolves false, writing nothing) when the mark is on `newestReplyId`, the
     * reply the caller is about to count as completed, or when the session has no entry.
     */
    archiveSessionUnlessStopped(
      sessionRef: SessionRef,
      archivedAt: string,
      newestReplyId: string | undefined,
    ): Promise<boolean>;
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

export interface SessionFileCatalogStorage extends CatalogStorage {
  getSessionFile(sessionRef: SessionRef): Promise<string | undefined>;
  setSessionFile(sessionRef: SessionRef, sessionFile: string): Promise<void>;
  deleteSessionFile(sessionRef: SessionRef): Promise<void>;
  /** Replaces the workspace's entries; stoppedReplyId marks are not touched. */
  replaceWorkspaceSessions(
    workspaceId: WorkspaceId,
    entries: readonly SessionCatalogEntry[],
    sessionFiles: Readonly<Record<string, string>>,
  ): Promise<void>;
}
