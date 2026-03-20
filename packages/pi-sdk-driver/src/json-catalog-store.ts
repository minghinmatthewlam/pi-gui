import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  CatalogStorage,
  SessionCatalogEntry,
  SessionCatalogSnapshot,
  SessionRef,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
  WorkspaceId,
} from "@pi-app/catalogs";

type CatalogFileState = {
  version: 1;
  workspaces: WorkspaceCatalogEntry[];
  sessions: SessionCatalogEntry[];
  sessionFiles: Record<string, string>;
};

export interface JsonCatalogStoreOptions {
  readonly catalogFilePath?: string;
}

export class JsonCatalogStore implements CatalogStorage {
  private readonly filePath: string;
  private state: CatalogFileState | undefined;
  private loadPromise: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonCatalogStoreOptions = {}) {
    this.filePath = options.catalogFilePath ? resolve(options.catalogFilePath) : defaultCatalogFilePath();
  }

  readonly workspaces = {
    listWorkspaces: async (): Promise<WorkspaceCatalogSnapshot> => {
      const state = await this.getState();
      return {
        workspaces: [...state.workspaces].sort(compareWorkspaceEntries).map(cloneWorkspaceEntry),
      };
    },
    getWorkspace: async (workspaceId: WorkspaceId): Promise<WorkspaceCatalogEntry | undefined> => {
      const state = await this.getState();
      const entry = state.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
      return entry ? cloneWorkspaceEntry(entry) : undefined;
    },
    upsertWorkspace: async (entry: WorkspaceCatalogEntry): Promise<void> => {
      await this.mutateState((state) => {
        const index = state.workspaces.findIndex((workspace) => workspace.workspaceId === entry.workspaceId);
        const next = cloneWorkspaceEntry(entry);
        if (index >= 0) {
          state.workspaces[index] = next;
        } else {
          state.workspaces.push(next);
        }
      });
    },
    deleteWorkspace: async (workspaceId: WorkspaceId): Promise<void> => {
      await this.mutateState((state) => {
        state.workspaces = state.workspaces.filter((workspace) => workspace.workspaceId !== workspaceId);
        state.sessions = state.sessions.filter((session) => session.workspaceId !== workspaceId);
        for (const key of Object.keys(state.sessionFiles)) {
          if (key.startsWith(`${workspaceId}:`)) {
            delete state.sessionFiles[key];
          }
        }
      });
    },
  };

  readonly sessions = {
    listSessions: async (workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot> => {
      const state = await this.getState();
      const sessions = state.sessions
        .filter((entry) => (workspaceId ? entry.workspaceId === workspaceId : true))
        .sort(compareSessionEntries)
        .map(cloneSessionEntry);
      return { sessions };
    },
    getSession: async (sessionRef: SessionRef): Promise<SessionCatalogEntry | undefined> => {
      const state = await this.getState();
      const entry = state.sessions.find((session) => sessionRefKey(session.sessionRef) === sessionRefKey(sessionRef));
      return entry ? cloneSessionEntry(entry) : undefined;
    },
    upsertSession: async (entry: SessionCatalogEntry): Promise<void> => {
      await this.mutateState((state) => {
        const index = state.sessions.findIndex((session) => sessionRefKey(session.sessionRef) === sessionRefKey(entry.sessionRef));
        const next = cloneSessionEntry(entry);
        if (index >= 0) {
          state.sessions[index] = next;
        } else {
          state.sessions.push(next);
        }
      });
    },
    deleteSession: async (sessionRef: SessionRef): Promise<void> => {
      await this.mutateState((state) => {
        const key = sessionRefKey(sessionRef);
        state.sessions = state.sessions.filter((session) => sessionRefKey(session.sessionRef) !== key);
        delete state.sessionFiles[key];
      });
    },
  };

  async getSessionFile(sessionRef: SessionRef): Promise<string | undefined> {
    const state = await this.getState();
    return state.sessionFiles[sessionRefKey(sessionRef)];
  }

  async setSessionFile(sessionRef: SessionRef, sessionFile: string): Promise<void> {
    await this.mutateState((state) => {
      state.sessionFiles[sessionRefKey(sessionRef)] = sessionFile;
    });
  }

  async deleteSessionFile(sessionRef: SessionRef): Promise<void> {
    await this.mutateState((state) => {
      delete state.sessionFiles[sessionRefKey(sessionRef)];
    });
  }

  private async getState(): Promise<CatalogFileState> {
    if (this.state) {
      return this.state;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loadState();
    }
    await this.loadPromise;
    if (!this.state) {
      this.state = createEmptyState();
    }
    return this.state;
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = parseState(raw, this.filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        this.state = createEmptyState();
        return;
      }
      throw error;
    }
  }

  private async mutateState(mutator: (state: CatalogFileState) => void): Promise<void> {
    const state = await this.getState();
    mutator(state);
    await this.persistState(state);
  }

  private async persistState(state: CatalogFileState): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const payload = `${JSON.stringify(state, null, 2)}\n`;
      await writeFile(tmpPath, payload, "utf8");
      try {
        await unlink(this.filePath);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      await rename(tmpPath, this.filePath);
    });

    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    await operation;
  }
}

function defaultCatalogFilePath(): string {
  return join(homedir(), ".pi-app", "catalogs.json");
}

function createEmptyState(): CatalogFileState {
  return {
    version: 1,
    workspaces: [],
    sessions: [],
    sessionFiles: {},
  };
}

function parseState(raw: string, filePath: string): CatalogFileState {
  const parsed = JSON.parse(raw) as Partial<CatalogFileState> | undefined;
  if (!parsed || parsed.version !== 1) {
    throw new Error(`Unsupported catalog file format in ${filePath}.`);
  }

  return {
    version: 1,
    workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.map(cloneWorkspaceEntry) : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(cloneSessionEntry) : [],
    sessionFiles: isRecord(parsed.sessionFiles) ? { ...parsed.sessionFiles } : {},
  };
}

function sessionRefKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

function compareWorkspaceEntries(left: WorkspaceCatalogEntry, right: WorkspaceCatalogEntry): number {
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
}

function compareSessionEntries(left: SessionCatalogEntry, right: SessionCatalogEntry): number {
  const statusRank = rankSessionStatus(left.status) - rankSessionStatus(right.status);
  if (statusRank !== 0) return statusRank;
  return right.updatedAt.localeCompare(left.updatedAt);
}

function rankSessionStatus(status: SessionCatalogEntry["status"]): number {
  if (status === "running") return 0;
  if (status === "idle") return 1;
  return 2;
}

function cloneWorkspaceEntry(entry: WorkspaceCatalogEntry): WorkspaceCatalogEntry {
  return { ...entry };
}

function cloneSessionEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
  return {
    ...entry,
    sessionRef: { ...entry.sessionRef },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
