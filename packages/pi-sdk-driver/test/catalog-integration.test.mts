import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionSupervisor } from "../dist/index.js";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import type {
  SessionCatalogEntry,
  SessionFileCatalogStorage,
  SessionRef,
  WorkspaceCatalogEntry,
  WorkspaceId,
} from "@pi-gui/catalogs";

const timestamp = "2026-07-27T00:00:00.000Z";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface WorkspaceUpsertBlock {
  readonly entered: Deferred;
  readonly release: Deferred;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function withBlockingWorkspaceUpserts(store: SessionFileCatalogStorage): {
  readonly catalog: SessionFileCatalogStorage;
  blockNextUpsert(): WorkspaceUpsertBlock;
  blockNextSessionReplacement(): WorkspaceUpsertBlock;
} {
  let nextBlock: WorkspaceUpsertBlock | undefined;
  let nextSessionReplacementBlock: WorkspaceUpsertBlock | undefined;
  return {
    catalog: {
      workspaces: {
        ...store.workspaces,
        upsertWorkspace: async (entry: WorkspaceCatalogEntry): Promise<void> => {
          const block = nextBlock;
          nextBlock = undefined;
          if (block) {
            block.entered.resolve();
            await block.release.promise;
          }
          await store.workspaces.upsertWorkspace(entry);
        },
      },
      sessions: store.sessions,
      worktrees: store.worktrees,
      getSessionFile: (sessionRef: SessionRef): Promise<string | undefined> =>
        store.getSessionFile(sessionRef),
      setSessionFile: (sessionRef: SessionRef, sessionFile: string): Promise<void> =>
        store.setSessionFile(sessionRef, sessionFile),
      deleteSessionFile: (sessionRef: SessionRef): Promise<void> =>
        store.deleteSessionFile(sessionRef),
      replaceWorkspaceSessions: async (
        workspaceId: WorkspaceId,
        entries: readonly SessionCatalogEntry[],
        sessionFiles: Readonly<Record<string, string>>,
      ): Promise<void> => {
        const block = nextSessionReplacementBlock;
        nextSessionReplacementBlock = undefined;
        if (block) {
          block.entered.resolve();
          await block.release.promise;
        }
        await store.replaceWorkspaceSessions(workspaceId, entries, sessionFiles);
      },
    },
    blockNextUpsert() {
      const block = { entered: deferred(), release: deferred() };
      nextBlock = block;
      return block;
    },
    blockNextSessionReplacement() {
      const block = { entered: deferred(), release: deferred() };
      nextSessionReplacementBlock = block;
      return block;
    },
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-catalog-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await test("desktop and driver catalog owners preserve each other's records", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);

    const desktopCatalog = new JsonCatalogStore({ catalogFilePath });
    await desktopCatalog.worktrees.listWorktrees();

    const supervisor = new SessionSupervisor({
      catalogFilePath,
      catalogStorage: desktopCatalog,
    });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");
    await desktopCatalog.worktrees.upsertWorktree({
      worktreeId: join(dir, "worktree"),
      workspaceId: workspace.workspaceId,
      path: join(dir, "worktree"),
      displayName: "Worktree",
      kind: "linked",
      status: "ready",
      branchName: "pi/worktree",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const persisted = JSON.parse(await readFile(catalogFilePath, "utf8")) as {
      workspaces: Array<{ workspaceId: string }>;
      worktrees: Array<{ worktreeId: string }>;
    };
    assert.deepEqual(
      persisted.workspaces.map((entry) => entry.workspaceId),
      [workspace.workspaceId],
    );
    assert.deepEqual(
      persisted.worktrees.map((entry) => entry.worktreeId),
      [join(dir, "worktree")],
    );
  });
});

await test("workspace removal wins over a touch that was already in flight", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const store = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
    const controlled = withBlockingWorkspaceUpserts(store);
    const supervisor = new SessionSupervisor({ catalogStorage: controlled.catalog });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");

    const block = controlled.blockNextUpsert();
    const staleTouch = supervisor.registerWorkspace(workspacePath, "Stale workspace");
    await block.entered.promise;
    const removal = supervisor.removeWorkspace(workspace.workspaceId);
    block.release.resolve();
    await Promise.all([staleTouch, removal]);

    assert.equal(await store.workspaces.getWorkspace(workspace.workspaceId), undefined);
  });
});

await test("workspace rename wins over an older metadata touch", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const store = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
    const controlled = withBlockingWorkspaceUpserts(store);
    const supervisor = new SessionSupervisor({ catalogStorage: controlled.catalog });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");

    const block = controlled.blockNextUpsert();
    const staleTouch = supervisor.registerWorkspace(workspacePath, "Stale workspace");
    await block.entered.promise;
    const rename = supervisor.renameWorkspace(workspace.workspaceId, "Renamed workspace");
    block.release.resolve();
    await Promise.all([staleTouch, rename]);

    const persisted = await store.workspaces.getWorkspace(workspace.workspaceId);
    assert.equal(persisted?.displayName, "Renamed workspace");
  });
});

await test("a metadata touch that reaches the queue after removal cannot re-add the workspace", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const store = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
    const supervisor = new SessionSupervisor({ catalogStorage: store });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");

    await supervisor.removeWorkspace(workspace.workspaceId);
    const metadataTouchSupervisor = supervisor as unknown as {
      touchWorkspace(workspaceId: WorkspaceId): Promise<void>;
    };
    await metadataTouchSupervisor.touchWorkspace(workspace.workspaceId);

    assert.equal(await store.workspaces.getWorkspace(workspace.workspaceId), undefined);
  });
});

await test("a metadata touch that reaches the queue after rename preserves the accepted name", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const store = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
    const supervisor = new SessionSupervisor({ catalogStorage: store });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");

    await supervisor.renameWorkspace(workspace.workspaceId, "Renamed workspace");
    const metadataTouchSupervisor = supervisor as unknown as {
      touchWorkspace(workspaceId: WorkspaceId): Promise<void>;
    };
    await metadataTouchSupervisor.touchWorkspace(workspace.workspaceId);

    const persisted = await store.workspaces.getWorkspace(workspace.workspaceId);
    assert.equal(persisted?.displayName, "Renamed workspace");
  });
});

await test("explicit registration can add a workspace again after removal", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const store = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
    const supervisor = new SessionSupervisor({ catalogStorage: store });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");

    await supervisor.removeWorkspace(workspace.workspaceId);
    await supervisor.registerWorkspace(workspacePath, "Registered again");

    const persisted = await store.workspaces.getWorkspace(workspace.workspaceId);
    assert.equal(persisted?.displayName, "Registered again");
  });
});

await test("reconcile preserves the persisted workspace display name", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const store = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
    const supervisor = new SessionSupervisor({ catalogStorage: store });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");
    await supervisor.renameWorkspace(workspace.workspaceId, "Renamed workspace");

    const reconciled = await supervisor.reconcileWorkspace(workspace.workspaceId);

    assert.equal(reconciled?.workspace.displayName, "Renamed workspace");
    assert.equal(
      (await store.workspaces.getWorkspace(workspace.workspaceId))?.displayName,
      "Renamed workspace",
    );
  });
});

await test("reconcile does not register a workspace that was already removed", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const store = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
    const supervisor = new SessionSupervisor({ catalogStorage: store });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");
    await supervisor.removeWorkspace(workspace.workspaceId);

    assert.equal(await supervisor.reconcileWorkspace(workspace.workspaceId), undefined);
    assert.equal(await store.workspaces.getWorkspace(workspace.workspaceId), undefined);
  });
});

await test("workspace removal waits for an older full sync transaction", async () => {
  await withTempDir(async (dir) => {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const store = new JsonCatalogStore({ catalogFilePath: join(dir, "catalogs.json") });
    const controlled = withBlockingWorkspaceUpserts(store);
    const supervisor = new SessionSupervisor({ catalogStorage: controlled.catalog });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");
    const sessionFile = join(dir, "preserved-session.jsonl");
    await writeFile(sessionFile, "");
    const sessionRef = { workspaceId: workspace.workspaceId, sessionId: "preserved-session" };
    await store.sessions.upsertSession({
      sessionRef,
      workspaceId: workspace.workspaceId,
      title: "Preserved session",
      updatedAt: timestamp,
      sessionFilePath: sessionFile,
      status: "idle",
    });
    await store.setSessionFile(sessionRef, sessionFile);

    const block = controlled.blockNextSessionReplacement();
    const sync = supervisor.syncWorkspace(workspacePath);
    await block.entered.promise;
    const removal = supervisor.removeWorkspace(workspace.workspaceId);
    // Before the full sync was serialized, removal could finish here and the
    // blocked replacement would then recreate an orphan session row.
    await delay(50);
    block.release.resolve();
    await Promise.all([sync, removal]);

    assert.equal(await store.workspaces.getWorkspace(workspace.workspaceId), undefined);
    assert.deepEqual((await store.sessions.listSessions(workspace.workspaceId)).sessions, []);
  });
});
