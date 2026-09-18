import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonCatalogStore, SessionSupervisor } from "../dist/index.js";

const timestamp = "2026-07-27T00:00:00.000Z";

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

await test("same-path stores serialize concurrent workspace, session, and worktree mutations", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const workspaceWriter = new JsonCatalogStore({ catalogFilePath });
    const sessionWriter = new JsonCatalogStore({ catalogFilePath });
    const worktreeWriter = new JsonCatalogStore({ catalogFilePath });
    await Promise.all([
      workspaceWriter.workspaces.listWorkspaces(),
      sessionWriter.sessions.listSessions(),
      worktreeWriter.worktrees.listWorktrees(),
    ]);

    const writes = Array.from({ length: 12 }, (_, index) => {
      const workspaceId = `workspace-${index}`;
      return Promise.all([
        workspaceWriter.workspaces.upsertWorkspace({
          workspaceId,
          path: join(dir, workspaceId),
          displayName: `Workspace ${index}`,
          lastOpenedAt: timestamp,
          sortOrder: index,
        }),
        sessionWriter.sessions.upsertSession({
          sessionRef: { workspaceId, sessionId: `session-${index}` },
          workspaceId,
          title: `Session ${index}`,
          updatedAt: timestamp,
          status: "idle",
        }),
        worktreeWriter.worktrees.upsertWorktree({
          worktreeId: join(dir, `worktree-${index}`),
          workspaceId,
          path: join(dir, `worktree-${index}`),
          displayName: `Worktree ${index}`,
          kind: "linked",
          status: "ready",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ]);
    });
    await Promise.all(writes);

    const persisted = JSON.parse(await readFile(catalogFilePath, "utf8")) as {
      workspaces: unknown[];
      sessions: unknown[];
      worktrees: unknown[];
    };
    assert.equal(persisted.workspaces.length, 12);
    assert.equal(persisted.sessions.length, 12);
    assert.equal(persisted.worktrees.length, 12);

    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.equal((await reopened.workspaces.listWorkspaces()).workspaces.length, 12);
    assert.equal((await reopened.sessions.listSessions()).sessions.length, 12);
    assert.equal((await reopened.worktrees.listWorktrees()).worktrees.length, 12);
  });
});

await test("new stores reload an externally replaced catalog and preserve it on mutation", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const firstStore = new JsonCatalogStore({ catalogFilePath });
    await firstStore.workspaces.upsertWorkspace({
      workspaceId: "stale-workspace",
      path: join(dir, "stale-workspace"),
      displayName: "Stale workspace",
      lastOpenedAt: timestamp,
      sortOrder: 0,
    });

    const replacementPath = `${catalogFilePath}.external-replacement`;
    await writeFile(
      replacementPath,
      `${JSON.stringify(
        {
          version: 2,
          workspaces: [
            {
              workspaceId: "repaired-workspace",
              path: join(dir, "repaired-workspace"),
              displayName: "Repaired workspace",
              lastOpenedAt: timestamp,
              sortOrder: 0,
            },
          ],
          sessions: [],
          worktrees: [],
          sessionFiles: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rename(replacementPath, catalogFilePath);

    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual(
      (await reopened.workspaces.listWorkspaces()).workspaces.map((entry) => entry.workspaceId),
      ["repaired-workspace"],
    );

    await reopened.workspaces.upsertWorkspace({
      workspaceId: "new-workspace",
      path: join(dir, "new-workspace"),
      displayName: "New workspace",
      lastOpenedAt: timestamp,
      sortOrder: 1,
    });

    const persisted = JSON.parse(await readFile(catalogFilePath, "utf8")) as {
      workspaces: Array<{ workspaceId: string }>;
    };
    assert.deepEqual(persisted.workspaces.map((entry) => entry.workspaceId).sort(), [
      "new-workspace",
      "repaired-workspace",
    ]);
    assert.deepEqual(
      (await firstStore.workspaces.listWorkspaces()).workspaces
        .map((entry) => entry.workspaceId)
        .sort(),
      ["new-workspace", "repaired-workspace"],
    );
  });
});

await test("an interrupted temp write leaves the last committed catalog readable", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const catalog = new JsonCatalogStore({ catalogFilePath });
    await catalog.workspaces.upsertWorkspace({
      workspaceId: "workspace",
      path: join(dir, "workspace"),
      displayName: "Workspace",
      lastOpenedAt: timestamp,
      sortOrder: 0,
    });

    await writeFile(`${catalogFilePath}.interrupted.tmp`, '{"version":2,"workspaces":[', "utf8");

    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual(
      (await reopened.workspaces.listWorkspaces()).workspaces.map((entry) => entry.workspaceId),
      ["workspace"],
    );
    const persisted = JSON.parse(await readFile(catalogFilePath, "utf8")) as {
      workspaces: unknown[];
    };
    assert.equal(persisted.workspaces.length, 1);
  });
});
