import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { TurnCaptureBoundary } from "@pi-gui/session-driver";
import {
  TurnCheckpointStore,
  type CheckpointCapture,
} from "../../electron/workbench/checkpoint-store";

async function git(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
  const workspace = join(directory, "source");
  const userData = join(directory, "app-data");
  await mkdir(workspace);
  await git(workspace, ["init", "--template=", "--initial-branch=main"]);
  await git(workspace, ["config", "user.name", "Checkpoint Test"]);
  await git(workspace, ["config", "user.email", "checkpoint@example.test"]);
  return {
    directory,
    workspace,
    userData,
    store: new TurnCheckpointStore(userData, { timeoutMs: 10_000 }),
  };
}

function available(
  capture: CheckpointCapture,
): asserts capture is Extract<CheckpointCapture, { state: "available" }> {
  expect(capture, JSON.stringify(capture)).toMatchObject({ state: "available" });
  if (capture.state !== "available") throw new Error(capture.message);
}

function boundary(
  workspace: string,
  checkpointId: string,
  phase: "opening" | "closing",
  overrides: Partial<TurnCaptureBoundary> = {},
): TurnCaptureBoundary {
  const anchor = { checkpointId, beforeEntryId: null, startedAt: "2026-09-22T12:00:00.000Z" };
  return {
    sessionRef: { workspaceId: "repo", sessionId: "task" },
    workspace: { workspaceId: "repo", path: workspace },
    runtimeGeneration: "generation-one",
    runId: "run-one",
    timestamp: phase === "opening" ? anchor.startedAt : "2026-09-22T12:00:01.000Z",
    ...(phase === "opening"
      ? { opening: anchor }
      : {
          closing: {
            ...anchor,
            userEntryIds: [`user-${checkpointId}`],
            assistantEntryIds: [`assistant-${checkpointId}`],
            lastEntryId: `assistant-${checkpointId}`,
            outcome: "completed" as const,
            reason: "settled" as const,
          },
        }),
    ...overrides,
  };
}

test("captures raw bytes, modes, symlink targets and deletions without changing source Git state", async () => {
  const { directory, workspace, store } = await fixture();
  await writeFile(join(workspace, "raw.txt"), "base\n");
  await writeFile(join(workspace, "deleted.txt"), "base\n");
  await writeFile(join(workspace, ".gitattributes"), "raw.txt filter=sentinel\n");
  await writeFile(join(workspace, ".gitignore"), "*.secret\n");
  await git(workspace, ["add", "."]);
  await git(workspace, ["commit", "-m", "baseline"]);
  await git(workspace, [
    "config",
    "filter.sentinel.clean",
    "sh -c 'echo invoked >> ../filter-log; cat'",
  ]);
  const excludes = join(directory, "excludes");
  await writeFile(excludes, "global-ignored.txt\n");
  await git(workspace, ["config", "core.excludesFile", excludes]);
  await writeFile(join(workspace, "global-ignored.txt"), "must not be captured");
  await writeFile(join(workspace, "private.secret"), "must not be captured");
  await writeFile(join(workspace, "raw.txt"), "raw\r\nbytes\r\n");
  await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 255, 10, 13, 0]));
  await writeFile(join(workspace, "script.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(workspace, "script.sh"), 0o755);
  await unlink(join(workspace, "deleted.txt"));
  const outside = join(directory, "outside-secret");
  await writeFile(outside, "external contents must never enter a snapshot");
  await symlink(outside, join(workspace, "external-link"));

  const indexBefore = await readFile(join(workspace, ".git", "index"));
  const headBefore = await readFile(join(workspace, ".git", "HEAD"));
  const refsBefore = await git(workspace, ["show-ref"]);
  const objectsBefore = await readdir(join(workspace, ".git", "objects"), { recursive: true });
  const capture = await store.capture(workspace);
  available(capture);

  expect(await git(store.repositoryPath, ["show", `${capture.treeOid}:raw.txt`])).toEqual(
    Buffer.from("raw\r\nbytes\r\n"),
  );
  expect(await git(store.repositoryPath, ["show", `${capture.treeOid}:binary.bin`])).toEqual(
    Buffer.from([0, 255, 10, 13, 0]),
  );
  expect(await git(store.repositoryPath, ["show", `${capture.treeOid}:external-link`])).toEqual(
    Buffer.from(outside),
  );
  const tree = (await git(store.repositoryPath, ["ls-tree", "-r", capture.treeOid])).toString();
  expect(tree).toContain("120000 blob");
  expect(tree).toMatch(/100755 blob [a-f0-9]+\tscript\.sh/);
  expect(tree).not.toContain("deleted.txt");
  expect(tree).not.toContain("private.secret");
  expect(tree).not.toContain("global-ignored.txt");
  expect((await git(store.repositoryPath, ["show-ref"])).toString()).toContain(capture.treeOid);
  expect(await readFile(join(workspace, ".git", "index"))).toEqual(indexBefore);
  expect(await readFile(join(workspace, ".git", "HEAD"))).toEqual(headBefore);
  expect(await git(workspace, ["show-ref"])).toEqual(refsBefore);
  expect(await readdir(join(workspace, ".git", "objects"), { recursive: true })).toEqual(
    objectsBefore,
  );
  await expect(readFile(join(directory, "filter-log"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a queued-input transition shares one capture and pins exact transcript entries on an unborn checkout", async () => {
  const { workspace, store, userData } = await fixture();
  await writeFile(join(workspace, "first.txt"), "before");
  const signal = new AbortController().signal;
  await store.recordBoundary(boundary(workspace, "first", "opening"), signal);
  await writeFile(join(workspace, "first.txt"), "after first");
  const closing = boundary(workspace, "first", "closing").closing!;
  const opening = boundary(workspace, "second", "opening").opening!;
  await store.recordBoundary(
    boundary(workspace, "second", "opening", { closing, opening }),
    signal,
  );
  const interim = await store.list({ workspaceId: "repo", sessionId: "task" });
  const first = interim.find((record) => record.checkpointId === "first")!;
  const second = interim.find((record) => record.checkpointId === "second")!;
  expect(first.after).toEqual(second.before);
  expect(first.overlaps).toEqual([]);
  await writeFile(join(workspace, "second.txt"), "after second");
  await store.recordBoundary(
    boundary(workspace, "second", "closing", { timestamp: "2026-09-22T12:00:02.000Z" }),
    signal,
  );
  const target = { workspaceId: "repo", sessionId: "task" };
  expect(
    (await store.listTurns(target)).map(({ checkpointId, entryIds }) => ({
      checkpointId,
      entryIds,
    })),
  ).toEqual([
    { checkpointId: "first", entryIds: ["user-first", "assistant-first"] },
    { checkpointId: "second", entryIds: ["user-second", "assistant-second"] },
  ]);
  expect(await store.resolve({ target, checkoutId: "repo" })).toMatchObject({
    state: "available",
    checkpointId: "second",
  });
  expect(
    await store.resolve({
      target: { ...target, sessionId: "other" },
      checkoutId: "repo",
      checkpointId: "first",
    }),
  ).toMatchObject({ state: "unavailable" });
  expect(await store.resolve({ target, checkoutId: "other", checkpointId: "first" })).toMatchObject(
    { state: "unavailable" },
  );
  const reopened = new TurnCheckpointStore(userData);
  expect(
    await reopened.resolve({ target, checkoutId: "repo", checkpointId: "first" }),
  ).toMatchObject({ state: "available", checkpointId: "first" });
});

test("linked worktree captures preserve the source pointer, per-worktree index and common objects", async () => {
  const { directory, workspace, store } = await fixture();
  await writeFile(join(workspace, "file.txt"), "base");
  await git(workspace, ["add", "."]);
  await git(workspace, ["commit", "-m", "baseline"]);
  const linked = join(directory, "linked");
  await git(workspace, ["worktree", "add", "-b", "linked-test", linked]);
  const linkedGitDir = (await git(linked, ["rev-parse", "--absolute-git-dir"])).toString().trim();
  await writeFile(join(linked, "file.txt"), "linked working contents");
  const pointerBefore = await readFile(join(linked, ".git"));
  const indexBefore = await readFile(join(linkedGitDir, "index"));
  const headBefore = await readFile(join(linkedGitDir, "HEAD"));
  const refsBefore = await git(workspace, ["show-ref"]);
  const objectsBefore = await readdir(join(workspace, ".git", "objects"), { recursive: true });
  const capture = await store.capture(linked);
  available(capture);
  expect(await git(store.repositoryPath, ["show", `${capture.treeOid}:file.txt`])).toEqual(
    Buffer.from("linked working contents"),
  );
  expect(await readFile(join(linked, ".git"))).toEqual(pointerBefore);
  expect(await readFile(join(linkedGitDir, "index"))).toEqual(indexBefore);
  expect(await readFile(join(linkedGitDir, "HEAD"))).toEqual(headBefore);
  expect(await git(workspace, ["show-ref"])).toEqual(refsBefore);
  expect(await readdir(join(workspace, ".git", "objects"), { recursive: true })).toEqual(
    objectsBefore,
  );
});

test("an untracked nested repository is skipped with a coverage note instead of failing capture", async () => {
  const { workspace, store } = await fixture();
  await writeFile(join(workspace, "tracked.txt"), "tracked\n");
  await git(workspace, ["add", "tracked.txt"]);
  await git(workspace, ["commit", "-m", "initial"]);
  const nested = join(workspace, "vendor-repo");
  await mkdir(nested);
  await git(nested, ["init", "--template=", "--initial-branch=main"]);
  await writeFile(join(nested, "inner.txt"), "inner\n");
  await writeFile(join(workspace, "loose.txt"), "loose\n");

  const capture = await store.capture(workspace);
  available(capture);
  expect(capture.fileCount).toBe(2);
  expect(capture.coverage.state).toBe("partial");
  expect(capture.coverage.notes.join(" ")).toMatch(/nested git repositories/i);
});

test("private batching handles spaces and newlines in storage roots and source filenames", async () => {
  const { directory, workspace } = await fixture();
  const userData = join(directory, 'app data\n"quoted"');
  const store = new TurnCheckpointStore(userData, { timeoutMs: 10_000 });
  const path = ' source\t"quoted"\nfile.txt';
  await writeFile(join(workspace, path), "raw content\r\n");
  const capture = await store.capture(workspace);
  available(capture);
  expect(await git(store.repositoryPath, ["show", `${capture.treeOid}:${path}`])).toEqual(
    Buffer.from("raw content\r\n"),
  );
  expect(
    (await readdir(join(userData, "turn-checkpoints"))).filter((name) =>
      name.startsWith("capture-"),
    ),
  ).toEqual([]);
});

test("marks both overlapping intervals even for different workspace IDs and reports stopped outcomes truthfully", async () => {
  const { workspace, store } = await fixture();
  await writeFile(join(workspace, "file.txt"), "before");
  const signal = new AbortController().signal;
  const firstTarget = { workspaceId: "repo", sessionId: "task" };
  const other = {
    sessionRef: { workspaceId: "same-checkout", sessionId: "other-task" },
    workspace: { workspaceId: "same-checkout", path: workspace },
    runId: "run-two",
  };
  await store.recordBoundary(boundary(workspace, "one", "opening"), signal);
  await store.recordBoundary(boundary(workspace, "two", "opening", other), signal);
  const closing = boundary(workspace, "one", "closing").closing!;
  await store.recordBoundary(
    boundary(workspace, "one", "closing", { closing: { ...closing, outcome: "stopped" } }),
    signal,
  );
  await store.recordBoundary(boundary(workspace, "two", "closing", other), signal);
  expect((await store.list(firstTarget))[0]!.overlaps).toEqual(["two"]);
  expect((await store.list(other.sessionRef))[0]!.overlaps).toEqual(["one"]);
  const resolved = await store.resolve({
    target: firstTarget,
    checkoutId: "repo",
    checkpointId: "one",
  });
  expect(resolved).toMatchObject({ state: "available", coverage: { state: "partial" } });
  if (resolved.state !== "available") throw new Error(resolved.message);
  expect(resolved.coverage.notes.join(" ")).toContain("stopped");
  expect(resolved.coverage.notes.join(" ")).toContain("overlapped");
});

test("relaunch marks unfinished intervals interrupted and a missing or aborted baseline stays unavailable", async () => {
  const { workspace, store, userData } = await fixture();
  await writeFile(join(workspace, "file.txt"), "before");
  const signal = new AbortController().signal;
  await store.recordBoundary(boundary(workspace, "unfinished", "opening"), signal);
  const reopened = new TurnCheckpointStore(userData, { timeoutMs: 10_000 });
  const target = { workspaceId: "repo", sessionId: "task" };
  expect((await reopened.list(target))[0]).toMatchObject({
    outcome: "interrupted",
    after: { state: "unavailable" },
  });
  expect(await reopened.resolve({ target, checkoutId: "repo" })).toMatchObject({
    state: "unavailable",
  });
  await reopened.recordBoundary(boundary(workspace, "missing", "closing"), signal);
  expect(
    await reopened.resolve({ target, checkoutId: "repo", checkpointId: "missing" }),
  ).toMatchObject({ state: "unavailable" });
  const aborted = new AbortController();
  aborted.abort();
  await reopened.recordBoundary(boundary(workspace, "aborted", "opening"), aborted.signal);
  await reopened.recordBoundary(boundary(workspace, "aborted", "closing"), signal);
  expect(
    await reopened.resolve({ target, checkoutId: "repo", checkpointId: "aborted" }),
  ).toMatchObject({ state: "unavailable" });
});

test("replayed boundaries cannot replace baselines, finalize twice, or repair aborted captures", async () => {
  const { workspace, store } = await fixture();
  const signal = new AbortController().signal;
  const target = { workspaceId: "repo", sessionId: "task" };
  await writeFile(join(workspace, "file.txt"), "original baseline");
  await store.recordBoundary(boundary(workspace, "one", "opening"), signal);
  const original = await store.list(target);
  await writeFile(join(workspace, "file.txt"), "later contents");
  await expect(store.recordBoundary(boundary(workspace, "one", "opening"), signal)).rejects.toThrow(
    /already used/,
  );
  expect(await store.list(target)).toEqual(original);
  await store.recordBoundary(boundary(workspace, "one", "closing"), signal);
  const finalized = await store.list(target);
  await writeFile(join(workspace, "file.txt"), "must not enter the finalized comparison");
  await expect(store.recordBoundary(boundary(workspace, "one", "closing"), signal)).rejects.toThrow(
    /already finalized/,
  );
  expect(await store.list(target)).toEqual(finalized);

  const aborted = new AbortController();
  aborted.abort();
  await store.recordBoundary(boundary(workspace, "aborted", "opening"), aborted.signal);
  await store.recordBoundary(boundary(workspace, "pending", "opening"), signal);
  const beforeInvalidTransition = await store.list(target);
  await expect(
    store.recordBoundary(
      boundary(workspace, "aborted", "opening", {
        closing: boundary(workspace, "pending", "closing").closing,
      }),
      signal,
    ),
  ).rejects.toThrow(/already used/);
  expect(await store.list(target)).toEqual(beforeInvalidTransition);
  await store.recordBoundary(boundary(workspace, "aborted", "closing"), signal);
  expect(
    await store.resolve({ target, checkoutId: "repo", checkpointId: "aborted" }),
  ).toMatchObject({ state: "unavailable" });
});

test("recovery does not promote an older interrupted interval above a newer completed turn", async () => {
  const { workspace, store, userData } = await fixture();
  const signal = new AbortController().signal;
  const target = { workspaceId: "repo", sessionId: "task" };
  await writeFile(join(workspace, "file.txt"), "original");
  const olderTimestamp = "2026-09-21T12:00:00.000Z";
  await store.recordBoundary(
    boundary(workspace, "older", "opening", { timestamp: olderTimestamp }),
    signal,
  );
  await store.recordBoundary(
    boundary(workspace, "newer", "opening", { runId: "newer-run" }),
    signal,
  );
  await writeFile(join(workspace, "file.txt"), "completed contents");
  await store.recordBoundary(
    boundary(workspace, "newer", "closing", { runId: "newer-run" }),
    signal,
  );
  const restarted = new TurnCheckpointStore(userData);
  expect(await restarted.resolve({ target, checkoutId: "repo" })).toMatchObject({
    state: "available",
    checkpointId: "newer",
  });
  expect(
    (await restarted.list(target)).find((record) => record.checkpointId === "older"),
  ).toMatchObject({ outcome: "interrupted", updatedAt: olderTimestamp });
});

test("size, file-count and cancellation limits cannot produce an apparently complete snapshot", async () => {
  const { workspace, userData } = await fixture();
  await writeFile(join(workspace, "one.txt"), "larger than four bytes");
  await writeFile(join(workspace, "two.txt"), "second");
  const byBytes = await new TurnCheckpointStore(userData, {
    timeoutMs: 10_000,
    maxFileBytes: 4,
  }).capture(workspace);
  expect(byBytes).toMatchObject({
    state: "unavailable",
    code: "byte-limit",
    coverage: { state: "partial" },
  });
  const byCount = await new TurnCheckpointStore(userData, {
    timeoutMs: 10_000,
    maxFiles: 1,
  }).capture(workspace);
  expect(byCount).toMatchObject({ state: "unavailable", code: "file-limit" });
  const controller = new AbortController();
  controller.abort();
  expect(
    await new TurnCheckpointStore(userData).capture(workspace, controller.signal),
  ).toMatchObject({ state: "unavailable", code: "capture-aborted" });
});

test("cancellation during first initialization does not poison subsequent captures", async () => {
  const { workspace, store } = await fixture();
  await writeFile(join(workspace, "file.txt"), "still capturable");
  const controller = new AbortController();
  const first = store.capture(workspace, controller.signal);
  // capture has entered prepareGit and yielded at mkdir; this is not a pre-aborted call.
  controller.abort();
  expect(await first).toMatchObject({ state: "unavailable", code: "capture-aborted" });
  available(await store.capture(workspace));
});

test("an interrupted repository initialization does not block a fresh attempt or erase its files", async () => {
  const { workspace, userData, store } = await fixture();
  const interrupted = join(userData, "turn-checkpoints", "objects.git.initializing.interrupted");
  await mkdir(join(interrupted, "objects"), { recursive: true });
  await writeFile(join(interrupted, "partial"), "retain failed initialization");
  await writeFile(join(workspace, "file.txt"), "still capturable");
  available(await store.capture(workspace));
  expect(await readFile(join(interrupted, "partial"), "utf8")).toBe("retain failed initialization");
});

test("invalid UTF-8 filenames cannot silently disappear from complete captures", async () => {
  test.skip(process.platform !== "linux", "APFS and Windows reject invalid UTF-8 path fixtures.");
  const { workspace, store } = await fixture();
  const path = Buffer.concat([Buffer.from(join(workspace, "invalid-")), Buffer.from([0xff])]);
  await writeFile(path, "must not silently disappear");
  expect(await store.capture(workspace)).toMatchObject({
    state: "unavailable",
    code: "inventory-encoding",
  });
});

test("submodules remain explicitly unavailable", async () => {
  const { workspace, store } = await fixture();
  await git(workspace, ["commit", "--allow-empty", "-m", "root"]);
  const commit = (await git(workspace, ["rev-parse", "HEAD"])).toString().trim();
  await git(workspace, ["update-index", "--add", "--cacheinfo", "160000", commit, "module"]);
  expect(await store.capture(workspace)).toMatchObject({ state: "unavailable", code: "submodule" });
});

test("sparse, conflicted and directory-symlink checkouts remain explicitly unavailable", async () => {
  const { directory, workspace, store } = await fixture();
  await mkdir(join(workspace, "nested"));
  await writeFile(join(workspace, "nested", "file.txt"), "base");
  await git(workspace, ["add", "."]);
  await git(workspace, ["update-index", "--skip-worktree", "nested/file.txt"]);
  expect(await store.capture(workspace)).toMatchObject({
    state: "unavailable",
    code: "sparse-checkout",
  });
  await git(workspace, ["update-index", "--no-skip-worktree", "nested/file.txt"]);
  const blob = (await git(workspace, ["rev-parse", ":nested/file.txt"])).toString().trim();
  await git(
    workspace,
    ["update-index", "--index-info"],
    `0 ${"0".repeat(40)}\tnested/file.txt\n100644 ${blob} 1\tnested/file.txt\n100644 ${blob} 2\tnested/file.txt\n`,
  );
  const conflictedIndex = await readFile(join(workspace, ".git", "index"));
  expect(await store.capture(workspace)).toMatchObject({
    state: "unavailable",
    code: "conflicted-checkout",
  });
  expect(await readFile(join(workspace, ".git", "index"))).toEqual(conflictedIndex);
  await git(workspace, ["add", "nested/file.txt"]);
  await rename(join(workspace, "nested"), join(directory, "outside"));
  await symlink(join(directory, "outside"), join(workspace, "nested"));
  expect(await store.capture(workspace)).toMatchObject({
    state: "unavailable",
    code: "unsafe-symlink",
  });
});

test("unknown metadata is rejected without replacement", async () => {
  const { workspace, userData, store } = await fixture();
  await mkdir(join(userData, "turn-checkpoints"), { recursive: true });
  const path = join(userData, "turn-checkpoints", "checkpoints.json");
  const original = '{ "version":99, "records":[], "future":"retain" }\n';
  await writeFile(path, original);
  await expect(
    store.recordBoundary(boundary(workspace, "one", "opening"), new AbortController().signal),
  ).rejects.toThrow(/metadata/);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("a failed metadata read is retried instead of disabling captures until restart", async () => {
  const { workspace, userData, store } = await fixture();
  await mkdir(join(userData, "turn-checkpoints"), { recursive: true });
  const path = join(userData, "turn-checkpoints", "checkpoints.json");
  await writeFile(path, '{ "version":99, "records":[] }\n');
  const signal = new AbortController().signal;
  await expect(store.recordBoundary(boundary(workspace, "one", "opening"), signal)).rejects.toThrow(
    /metadata/,
  );
  await unlink(path);
  await store.recordBoundary(boundary(workspace, "one", "opening"), signal);
  const saved = JSON.parse(await readFile(path, "utf8")) as { records: unknown[] };
  expect(saved.records).toHaveLength(1);
});

test("reports measured capture cost for a 500-file checkout", async () => {
  const { workspace, store } = await fixture();
  await Promise.all(
    Array.from({ length: 500 }, (_, index) =>
      writeFile(join(workspace, `source-${index}.txt`), `source ${index}\n`.repeat(10)),
    ),
  );
  const capture = await store.capture(workspace);
  available(capture);
  expect(capture.fileCount).toBe(500);
  expect(capture.byteCount).toBeGreaterThan(50_000);
  expect(capture.durationMs).toBeGreaterThan(0);
  console.info(
    `Checkpoint capture metrics: ${JSON.stringify({ durationMs: capture.durationMs, fileCount: capture.fileCount, bytes: capture.byteCount })}`,
  );
});

test("reports default and extended capture budgets on a 2,000-file checkout", async () => {
  const { workspace, userData } = await fixture();
  await Promise.all(
    Array.from({ length: 2_000 }, (_, index) =>
      writeFile(join(workspace, `source-${index}.txt`), `source ${index}\n`.repeat(10)),
    ),
  );
  const defaultCapture = await new TurnCheckpointStore(userData).capture(workspace);
  const extendedCapture = await new TurnCheckpointStore(userData, { timeoutMs: 10_000 }).capture(
    workspace,
  );
  available(extendedCapture);
  expect(extendedCapture.fileCount).toBe(2_000);
  if (defaultCapture.state === "unavailable") expect(defaultCapture.code).toBe("capture-aborted");
  console.info(
    `Large checkpoint capture metrics: ${JSON.stringify({
      default: {
        state: defaultCapture.state,
        durationMs: defaultCapture.durationMs,
        fileCount: defaultCapture.fileCount,
        bytes: defaultCapture.byteCount,
      },
      extended: {
        state: extendedCapture.state,
        durationMs: extendedCapture.durationMs,
        fileCount: extendedCapture.fileCount,
        bytes: extendedCapture.byteCount,
      },
    })}`,
  );
});

async function snapshotRefs(store: TurnCheckpointStore): Promise<string[]> {
  const output = await git(store.repositoryPath, [
    "for-each-ref",
    "--format=%(objectname)",
    "refs/pi-gui/",
  ]);
  return output.toString().split("\n").filter(Boolean);
}

/** Files changed within the store's racy window are reread; let fixture writes age past it. */
function ageFixtureFiles(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_100));
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate().catch(() => false))) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a boundary in one checkout does not wait for a slow capture in another checkout", async () => {
  test.skip(process.platform === "win32", "Uses a FIFO to hold a capture open.");
  const { directory, workspace, userData } = await fixture();
  const store = new TurnCheckpointStore(userData, { timeoutMs: 30_000 });
  await writeFile(join(workspace, "fast.txt"), "fast checkout");
  const slow = join(directory, "slow");
  await mkdir(slow);
  await git(slow, ["init", "--template=", "--initial-branch=main"]);
  await writeFile(join(slow, "slow.txt"), "slow checkout");
  // Git blocks opening this HEAD until a writer arrives, holding the slow capture open.
  const head = join(slow, ".git", "HEAD");
  const writer = join(directory, "head-writer");
  await rename(head, `${head}.real`);
  await new Promise<void>((resolve, reject) =>
    execFile("mkfifo", [head], (error) => (error ? reject(error) : resolve())),
  );
  await link(head, writer);
  const slowTarget = { workspaceId: "slow", sessionId: "slow-task" };
  const slowBoundary = store.recordBoundary(
    boundary(slow, "slow", "opening", {
      sessionRef: slowTarget,
      workspace: { workspaceId: "slow", path: slow },
    }),
    new AbortController().signal,
  );
  const fast = store.recordBoundary(
    boundary(workspace, "fast", "opening"),
    new AbortController().signal,
  );
  const finished = await Promise.race([
    fast.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  // Release the blocked reader, then let later Git calls read the real HEAD.
  await rename(`${head}.real`, head);
  await writeFile(writer, "ref: refs/heads/main\n");
  await slowBoundary;
  expect(finished, "the other checkout's boundary must not queue behind the slow one").toBe(true);
  expect((await store.list({ workspaceId: "repo", sessionId: "task" }))[0]).toMatchObject({
    checkpointId: "fast",
    before: { state: "available" },
  });
  expect((await store.list(slowTarget))[0]).toMatchObject({ before: { state: "available" } });
});

test("incremental captures reread only changed files and still see same-size rewrites", async () => {
  const { workspace, store } = await fixture();
  const old = new Date("2026-01-01T00:00:00.000Z");
  for (const name of ["keep.txt", "edit.txt", "remove.txt"]) {
    await writeFile(join(workspace, name), `${name} original`);
    await utimes(join(workspace, name), old, old);
  }
  await mkdir(join(workspace, "nested"));
  await writeFile(join(workspace, "nested", "deep.txt"), "deep");
  await utimes(join(workspace, "nested", "deep.txt"), old, old);
  await git(workspace, ["add", "."]);
  await ageFixtureFiles();
  const first = await store.capture(workspace);
  available(first);
  expect(await snapshotRefs(store)).toHaveLength(1);

  // Nothing changed: the stored inventory yields the identical tree without a new snapshot.
  const unchanged = await store.capture(workspace);
  available(unchanged);
  expect(unchanged.treeOid).toBe(first.treeOid);
  expect(unchanged.fileCount).toBe(4);
  expect(unchanged.byteCount).toBe(first.byteCount);
  expect(await snapshotRefs(store)).toHaveLength(1);

  // A just-written file is in the tree but not trusted for reuse; deleting it must not
  // let the previous tree stand in for the new one.
  await writeFile(join(workspace, "fresh.txt"), "fresh");
  const withFresh = await store.capture(workspace);
  available(withFresh);
  await unlink(join(workspace, "fresh.txt"));
  const withoutFresh = await store.capture(workspace);
  available(withoutFresh);
  expect(withoutFresh.treeOid).toBe(first.treeOid);

  // Same size and restored mtime: only the change time reveals the rewrite.
  await writeFile(join(workspace, "edit.txt"), "edit.txt rewrites");
  await utimes(join(workspace, "edit.txt"), old, old);
  await unlink(join(workspace, "remove.txt"));
  await writeFile(join(workspace, "nested", "added.txt"), "added");
  const changed = await store.capture(workspace);
  available(changed);
  const tree = (await git(store.repositoryPath, ["ls-tree", "-r", "--name-only", changed.treeOid]))
    .toString()
    .trim()
    .split("\n");
  expect(tree).toEqual(["edit.txt", "keep.txt", "nested/added.txt", "nested/deep.txt"]);
  expect(await git(store.repositoryPath, ["show", `${changed.treeOid}:edit.txt`])).toEqual(
    Buffer.from("edit.txt rewrites"),
  );
  expect(await git(store.repositoryPath, ["show", `${changed.treeOid}:keep.txt`])).toEqual(
    Buffer.from("keep.txt original"),
  );

  // A tracked directory replaced by a symlink is refused even though its file is unchanged.
  await rename(join(workspace, "nested"), join(workspace, "..", "moved-nested"));
  await symlink(join(workspace, "..", "moved-nested"), join(workspace, "nested"));
  expect(await store.capture(workspace)).toMatchObject({
    state: "unavailable",
    code: "unsafe-symlink",
  });
});

test("a checkout too slow for its first boundary builds its inventory in the background", async () => {
  const { workspace, store } = await fixture();
  await writeFile(join(workspace, "file.txt"), "contents");
  await ageFixtureFiles();
  const aborted = new AbortController();
  aborted.abort();
  await store.recordBoundary(boundary(workspace, "first", "opening"), aborted.signal);
  expect((await store.list({ workspaceId: "repo", sessionId: "task" }))[0]).toMatchObject({
    before: { state: "unavailable", code: "capture-aborted" },
  });
  await until(async () => (await snapshotRefs(store)).length === 1);
  const [warmed] = await snapshotRefs(store);
  await store.recordBoundary(
    boundary(workspace, "second", "opening"),
    new AbortController().signal,
  );
  const second = (await store.list({ workspaceId: "repo", sessionId: "task" })).find(
    (record) => record.checkpointId === "second",
  )!;
  expect(second.before).toMatchObject({ state: "available", treeOid: warmed });
  expect(await snapshotRefs(store)).toEqual([warmed]);
});

test("retention caps records, deletes unneeded refs and prunes their objects", async () => {
  const { workspace, userData } = await fixture();
  const store = new TurnCheckpointStore(
    userData,
    { timeoutMs: 10_000 },
    { maxRecordsPerTask: 2, maxRecords: 3, pruneGraceMs: 0 },
  );
  const signal = new AbortController().signal;
  const target = { workspaceId: "repo", sessionId: "task" };
  const other = {
    sessionRef: { workspaceId: "repo", sessionId: "other-task" },
  };
  const unique: string[] = [];
  for (let turn = 0; turn < 4; turn += 1) {
    const at = (second: number) => `2026-09-22T12:0${turn}:0${second}.000Z`;
    await store.recordBoundary(
      boundary(workspace, `turn-${turn}`, "opening", { timestamp: at(0) }),
      signal,
    );
    await writeFile(join(workspace, "file.txt"), `unique contents of turn ${turn}`);
    unique.push((await git(workspace, ["hash-object", "file.txt"])).toString().trim());
    await store.recordBoundary(
      boundary(workspace, `turn-${turn}`, "closing", { timestamp: at(1) }),
      signal,
    );
  }
  await store.recordBoundary(
    boundary(workspace, "other", "opening", { ...other, timestamp: "2026-09-22T12:09:00.000Z" }),
    signal,
  );
  await store.recordBoundary(
    boundary(workspace, "other", "closing", { ...other, timestamp: "2026-09-22T12:09:01.000Z" }),
    signal,
  );
  expect((await store.list(target)).map((record) => record.checkpointId).sort()).toEqual([
    "turn-2",
    "turn-3",
  ]);
  // Automatic maintenance waits an interval after startup; run it now. A zero grace period
  // is only safe here because no capture is in flight.
  await store.maintain();
  const records = [...(await store.list(target)), ...(await store.list(other.sessionRef))];
  const live = new Set(
    records.flatMap((record) =>
      [record.before, record.after].flatMap((capture) =>
        capture?.state === "available" ? [capture.treeOid] : [],
      ),
    ),
  );
  const refs = await snapshotRefs(store);
  expect(new Set(refs)).toEqual(live);
  expect(refs).toHaveLength(live.size);
  // Blobs that only dropped turns referenced are gone; retained ones remain readable.
  await expect(git(store.repositoryPath, ["cat-file", "-e", unique[0]!])).rejects.toThrow();
  await git(store.repositoryPath, ["cat-file", "-e", unique[3]!]);
  expect(await store.resolve({ target, checkoutId: "repo" })).toMatchObject({
    state: "available",
    checkpointId: "turn-3",
  });

  // Captures after maintenance cannot reuse pruned objects.
  const after = await store.capture(workspace);
  available(after);
  expect(await git(store.repositoryPath, ["show", `${after.treeOid}:file.txt`])).toEqual(
    Buffer.from("unique contents of turn 3"),
  );
});
