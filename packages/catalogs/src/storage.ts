import type {
  SessionCatalogEntry,
  SessionCatalogSnapshot,
  SessionRef,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
  WorkspaceId,
} from "./types.js";

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

export interface CatalogStorage {
  workspaces: WorkspaceCatalogStorage;
  sessions: SessionCatalogStorage;
}
