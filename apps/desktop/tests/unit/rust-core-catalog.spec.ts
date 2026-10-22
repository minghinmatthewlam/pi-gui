import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type {
  SessionCatalogEntry,
  SessionFileCatalogStorage,
  WorkspaceCatalogEntry,
  WorktreeCatalogEntry,
} from "@pi-gui/catalogs";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import { startCore, type CoreProcess } from "../../core-process/launch";
import { coreMethods } from "../../core-process/protocol";
import { remoteCatalogStorage } from "../../pi-host/remote-catalog";

/**
 * The Rust catalog replaces `JsonCatalogStore`, so the two are run side by side on the same
 * operations and must answer every read the same way and leave the same file behind.
 * Needs `pnpm --filter @pi-gui/desktop run build:core` first (part of `pnpm build`).
 */

const binaryPath = join(
  __dirname,
  "..",
  "..",
  "build",
  "native",
  process.platform === "win32" ? "pi-gui-core.exe" : "pi-gui-core",
);

let dir: string;
let core: CoreProcess;

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-gui-core-catalog-"));
});

test.afterEach(async () => {
  await core?.stop(1_000);
  await rm(dir, { recursive: true, force: true });
});

async function stores(seed?: string) {
  const typescriptDir = join(dir, "typescript");
  const rustDir = join(dir, "rust");
  if (seed !== undefined) {
    for (const folder of [typescriptDir, rustDir]) {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "catalogs.json"), seed);
    }
  }
  core = await startCore({
    binaryPath,
    initialize: { userDataDir: rustDir },
    onUnexpectedExit: (detail) => {
      throw new Error(`pi-gui-core exited: ${detail}`);
    },
  });
  return {
    typescript: new JsonCatalogStore({ catalogFilePath: join(typescriptDir, "catalogs.json") }),
    rust: remoteCatalogStorage(core.peer, coreMethods.catalogCall),
    files: [join(typescriptDir, "catalogs.json"), join(rustDir, "catalogs.json")] as const,
  };
}

/** A small deterministic random source so a failure always replays the same way. */
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  return { next, pick };
}

const WORKSPACES = ["w1", "w2", "w3"];
const SESSIONS = ["s1", "s2", "s3", "s4"];
const TIMES = ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"];
const NAMES = ["alpha", "Alpha", "beta", "Beta", "b_x", "b-x", "b1", "éa", "fa"];

function operations(seed: number, count: number) {
  const { next, pick } = random(seed);
  const workspace = (): WorkspaceCatalogEntry => ({
    workspaceId: pick(WORKSPACES),
    path: `/repo/${pick(NAMES)}`,
    displayName: pick(NAMES),
    lastOpenedAt: pick(TIMES),
    sortOrder: pick([0, 1, 2, 1.5]),
    ...(next() < 0.3 ? { pinned: next() < 0.5 } : {}),
  });
  const session = (workspaceId = pick(WORKSPACES)): SessionCatalogEntry => ({
    sessionRef: { workspaceId, sessionId: pick(SESSIONS) },
    workspaceId,
    title: pick(NAMES),
    updatedAt: pick(TIMES),
    status: pick(["idle", "running", "failed"] as const),
    ...(next() < 0.3 ? { archivedAt: pick(TIMES) } : {}),
    ...(next() < 0.3 ? { previewSnippet: pick(NAMES) } : {}),
  });
  const worktree = (workspaceId = pick(WORKSPACES)): WorktreeCatalogEntry => ({
    worktreeId: `/wt/${pick(NAMES)}`,
    workspaceId,
    path: `/wt/${pick(NAMES)}`,
    displayName: pick(NAMES),
    kind: pick(["primary", "linked"] as const),
    status: pick(["ready", "missing", "error"] as const),
    ...(next() < 0.5 ? { branchName: pick(NAMES) } : {}),
    ...(next() < 0.3 ? { pinned: next() < 0.5 } : {}),
    createdAt: pick(TIMES),
    updatedAt: pick(TIMES),
  });
  const ref = () => ({ workspaceId: pick(WORKSPACES), sessionId: pick(SESSIONS) });

  const steps: Array<(store: SessionFileCatalogStorage) => Promise<unknown>> = [];
  for (let index = 0; index < count; index++) {
    const choice = Math.floor(next() * 11);
    if (choice === 0) {
      const entry = workspace();
      steps.push((store) => store.workspaces.upsertWorkspace(entry));
    } else if (choice === 1 && next() < 0.3) {
      const id = pick(WORKSPACES);
      steps.push((store) => store.workspaces.deleteWorkspace(id));
    } else if (choice <= 3) {
      const entry = session();
      steps.push((store) => store.sessions.upsertSession(entry));
    } else if (choice === 4) {
      const target = ref();
      steps.push((store) => store.sessions.deleteSession(target));
    } else if (choice === 5) {
      const target = ref();
      const file = `/sessions/${pick(NAMES)}.jsonl`;
      steps.push((store) => store.setSessionFile(target, file));
    } else if (choice === 6) {
      const target = ref();
      steps.push((store) => store.deleteSessionFile(target));
    } else if (choice === 7) {
      const entry = worktree();
      steps.push((store) => store.worktrees.upsertWorktree(entry));
    } else if (choice === 8) {
      const id = `/wt/${pick(NAMES)}`;
      steps.push((store) => store.worktrees.deleteWorktree(id));
    } else if (choice === 9) {
      const id = pick(WORKSPACES);
      const entries = Array.from({ length: Math.floor(next() * 3) }, () => worktree(id));
      steps.push((store) => store.worktrees.replaceWorkspaceWorktrees(id, entries));
    } else {
      const id = pick(WORKSPACES);
      const entries = Array.from({ length: Math.floor(next() * 3) }, () => session(id));
      const files = Object.fromEntries(
        entries.map((entry) => [
          `${id}:${entry.sessionRef.sessionId}`,
          `/sessions/${entry.sessionRef.sessionId}.jsonl`,
        ]),
      );
      steps.push((store) => store.replaceWorkspaceSessions(id, entries, files));
    }
  }
  return steps;
}

async function readEverything(store: SessionFileCatalogStorage) {
  return {
    workspaces: await store.workspaces.listWorkspaces(),
    sessions: await store.sessions.listSessions(),
    worktrees: await store.worktrees.listWorktrees(),
    byWorkspace: await Promise.all(
      WORKSPACES.map(async (id) => ({
        workspace: await store.workspaces.getWorkspace(id),
        sessions: await store.sessions.listSessions(id),
        worktrees: await store.worktrees.listWorktrees(id),
      })),
    ),
    bySession: await Promise.all(
      WORKSPACES.flatMap((workspaceId) =>
        SESSIONS.map(async (sessionId) => ({
          session: await store.sessions.getSession({ workspaceId, sessionId }),
          file: await store.getSessionFile({ workspaceId, sessionId }),
        })),
      ),
    ),
    worktree: await store.worktrees.getWorktree(`/wt/${NAMES[0]}`),
  };
}

for (const seed of [1, 2, 3, 4]) {
  test(`Rust and TypeScript catalogs agree on a random run (seed ${seed})`, async () => {
    const { typescript, rust, files } = await stores();
    for (const [index, step] of operations(seed, 120).entries()) {
      await step(typescript);
      await step(rust);
      if (index % 10 === 9) {
        expect(await readEverything(rust), `after step ${index + 1}`).toEqual(
          await readEverything(typescript),
        );
      }
    }
    expect(await readEverything(rust)).toEqual(await readEverything(typescript));
    const [typescriptFile, rustFile] = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as unknown),
    );
    expect(rustFile).toEqual(typescriptFile);
  });
}

test("both catalogs refuse an invalid file the same way and leave it alone", async () => {
  const original = JSON.stringify({
    version: 2,
    workspaces: [],
    sessions: [null],
    worktrees: [],
    sessionFiles: {},
  });
  const { typescript, rust, files } = await stores(original);
  const typescriptError = await typescript.sessions.listSessions().catch((error: Error) => error);
  const rustError = await rust.sessions.listSessions().catch((error: Error) => error);
  expect(rustError).toBeInstanceOf(Error);
  expect((rustError as Error).message.replace(files[1], "<file>")).toBe(
    (typescriptError as Error).message.replace(files[0], "<file>"),
  );
  await expect(
    rust.sessions.upsertSession({
      sessionRef: { workspaceId: "w", sessionId: "s" },
      workspaceId: "w",
      title: "t",
      updatedAt: TIMES[0]!,
      status: "idle",
    }),
  ).rejects.toThrow(/Invalid catalog file contents/);
  expect(await readFile(files[1], "utf8")).toBe(original);
});

test("half an emoji cut off by a length limit loads, and saves as a replacement character", async () => {
  const halfEmoji = "cut \ud83d";
  const seed = JSON.stringify({
    version: 2,
    workspaces: [],
    sessions: [
      {
        sessionRef: { workspaceId: "w", sessionId: "s" },
        workspaceId: "w",
        title: halfEmoji,
        updatedAt: TIMES[0],
        status: "idle",
      },
    ],
    worktrees: [],
    sessionFiles: {},
  });
  const { typescript, rust } = await stores(seed);
  const wellFormed = (text: string) =>
    text.replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      "\ufffd",
    );
  const [fromTypescript] = (await typescript.sessions.listSessions()).sessions;
  const [fromRust] = (await rust.sessions.listSessions()).sessions;
  expect(fromRust?.title).toBe(wellFormed(fromTypescript!.title));
  // A new half emoji sent by pi is saved instead of leaving the call unanswered.
  await rust.sessions.upsertSession({ ...fromTypescript!, previewSnippet: "more \ude00" });
  expect(
    (await rust.sessions.getSession({ workspaceId: "w", sessionId: "s" }))?.previewSnippet,
  ).toBe("more \ufffd");
});

test("an explicit null in an optional field is refused like before", async () => {
  const original = JSON.stringify({
    version: 2,
    workspaces: [],
    sessions: [
      {
        sessionRef: { workspaceId: "w", sessionId: "s" },
        workspaceId: "w",
        title: "t",
        updatedAt: TIMES[0],
        archivedAt: null,
        status: "idle",
      },
    ],
    worktrees: [],
    sessionFiles: {},
  });
  const { typescript, rust } = await stores(original);
  await expect(typescript.sessions.listSessions()).rejects.toThrow(/Invalid catalog file contents/);
  await expect(rust.sessions.listSessions()).rejects.toThrow(/Invalid catalog file contents/);
});

test("the app's method list matches the Rust core's", async () => {
  const lib = await readFile(join(__dirname, "../../../../crates/pi-gui-core/src/lib.rs"), "utf8");
  const rustMethods = [...lib.matchAll(/pub const [A-Z_]+: &str = "([^"]+)";/g)].map(
    (match) => match[1],
  );
  expect(rustMethods.sort()).toEqual(Object.values(coreMethods).sort());
});
