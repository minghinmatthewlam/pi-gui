import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonCatalogStore } from "../dist/node/index.js";

const timestamp = "2026-07-27T00:00:00.000Z";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-catalog-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

const validWorkspace = {
  workspaceId: "workspace",
  path: "/workspace",
  displayName: "Workspace",
  lastOpenedAt: timestamp,
  sortOrder: 0,
};
const validSession = {
  workspaceId: "workspace",
  sessionRef: { workspaceId: "workspace", sessionId: "session" },
  title: "Session",
  updatedAt: timestamp,
  status: "idle",
};
const validWorktree = {
  worktreeId: "worktree",
  workspaceId: "workspace",
  path: "/worktree",
  displayName: "Worktree",
  kind: "linked",
  status: "ready",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const validCatalog = {
  version: 2,
  workspaces: [validWorkspace],
  sessions: [validSession],
  worktrees: [validWorktree],
  sessionFiles: { "workspace:session": "/session.jsonl" },
};

await test("invalid catalog data rejects reads and writes without dropping any saved records", async (t) => {
  const cases: Record<string, unknown> = {
    "future version": { ...validCatalog, version: 3 },
    "null document": null,
    "array document": [],
    "missing v2 collection": { ...validCatalog, sessions: undefined },
    "wrong collection shape": { ...validCatalog, workspaces: {} },
    "null workspace among valid records": { ...validCatalog, workspaces: [validWorkspace, null] },
    "workspace timestamp": {
      ...validCatalog,
      workspaces: [{ ...validWorkspace, lastOpenedAt: 12 }],
    },
    "workspace sort order": {
      ...validCatalog,
      workspaces: [{ ...validWorkspace, sortOrder: "0" }],
    },
    "workspace pinned": { ...validCatalog, workspaces: [{ ...validWorkspace, pinned: "yes" }] },
    "session reference": { ...validCatalog, sessions: [{ ...validSession, sessionRef: {} }] },
    "session workspace mismatch": {
      ...validCatalog,
      sessions: [{ ...validSession, workspaceId: "other" }],
    },
    "session status": { ...validCatalog, sessions: [{ ...validSession, status: "unknown" }] },
    "session optional field": {
      ...validCatalog,
      sessions: [{ ...validSession, archivedAt: false }],
    },
    "worktree kind": { ...validCatalog, worktrees: [{ ...validWorktree, kind: "unknown" }] },
    "worktree status": { ...validCatalog, worktrees: [{ ...validWorktree, status: "unknown" }] },
    "worktree optional field": {
      ...validCatalog,
      worktrees: [{ ...validWorktree, branchName: [] }],
    },
    "file map array": { ...validCatalog, sessionFiles: [] },
    "file map value": { ...validCatalog, sessionFiles: { "workspace:session": null } },
    "legacy malformed collection": { version: 1, sessions: null },
  };
  for (const [name, contents] of Object.entries(cases)) {
    await t.test(name, async () => {
      await withTempDir(async (dir) => {
        const catalogFilePath = join(dir, "catalogs.json");
        const original = `${JSON.stringify(contents, null, 2)}\n`;
        await writeFile(catalogFilePath, original);
        const store = new JsonCatalogStore({ catalogFilePath });
        const error = /(?:Invalid catalog file contents|Unsupported catalog file format)/;
        await assert.rejects(store.workspaces.listWorkspaces(), error);
        await assert.rejects(store.sessions.listSessions(), error);
        await assert.rejects(store.worktrees.listWorktrees(), error);
        await assert.rejects(store.workspaces.deleteWorkspace("workspace"), error);
        await assert.rejects(store.setSessionFile(validSession.sessionRef, "/new.jsonl"), error);
        assert.equal(await readFile(catalogFilePath, "utf8"), original);
      });
    });
  }
});

await test("legacy catalogs retain records and upgrade only when a mutation succeeds", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const original = JSON.stringify({
      version: 1,
      workspaces: [validWorkspace],
      sessions: [validSession],
    });
    await writeFile(catalogFilePath, original);
    const store = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual((await store.sessions.listSessions()).sessions, [validSession]);
    assert.deepEqual((await store.worktrees.listWorktrees()).worktrees, []);
    assert.equal(await store.getSessionFile(validSession.sessionRef), undefined);
    assert.equal(await readFile(catalogFilePath, "utf8"), original);
    await store.setSessionFile(validSession.sessionRef, "/session.jsonl");
    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual((await reopened.workspaces.listWorkspaces()).workspaces, [validWorkspace]);
    assert.deepEqual((await reopened.sessions.listSessions()).sessions, [validSession]);
    assert.equal(await reopened.getSessionFile(validSession.sessionRef), "/session.jsonl");
  });
});

await test("a failed load can be retried after the original catalog is repaired", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    await writeFile(catalogFilePath, JSON.stringify({ ...validCatalog, sessions: [null] }));
    const store = new JsonCatalogStore({ catalogFilePath });
    await assert.rejects(store.sessions.listSessions(), /Invalid catalog file contents/);
    await writeFile(catalogFilePath, JSON.stringify(validCatalog));
    assert.deepEqual((await store.sessions.listSessions()).sessions, [validSession]);
  });
});
