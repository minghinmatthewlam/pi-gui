import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  changeGitReviewFileStage,
  checkGitReviewFileCurrent,
  createGitReview,
  readGitReviewFile,
  type GitReviewSnapshot,
} from "../../electron/platform/files/git-review";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }))
    .stdout;
}

async function repository(unborn = false): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gui-git-review-test-"));
  await git(cwd, "init", "-b", "trunk");
  await git(cwd, "config", "user.email", "review@example.invalid");
  await git(cwd, "config", "user.name", "Review fixture");
  if (!unborn) {
    await writeFile(join(cwd, "file.txt"), "base\n");
    await git(cwd, "add", "--", "file.txt");
    await git(cwd, "commit", "-m", "base");
  }
  return cwd;
}

async function uncommitted(cwd: string): Promise<GitReviewSnapshot> {
  const review = await createGitReview(cwd, { kind: "uncommitted" });
  expect(review.state).toBe("available");
  if (review.state !== "available") throw new Error(review.message);
  return review;
}

async function fileContent(review: GitReviewSnapshot, path: string) {
  const file = review.files.find((entry) => entry.path === path);
  expect(file).toBeDefined();
  const result = await readGitReviewFile(review, file!.id);
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error(result.message);
  return { file: file!, result };
}

test("retains staged and unstaged portions when they cancel in the working tree", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "file.txt"), "staged\n");
  await git(cwd, "add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "base\n");
  const review = await uncommitted(cwd);
  expect(review.files).toHaveLength(1);
  const { file, result } = await fileContent(review, "file.txt");
  expect(file).toMatchObject({ hasStagedChanges: true, hasUnstagedChanges: true });
  expect(result.sections.map((section) => section.kind)).toEqual([
    "combined",
    "staged",
    "unstaged",
  ]);
  expect(result.sections[0]!.patch).toBe("");
  expect(result.sections[1]!.patch).toContain("+staged");
  expect(result.sections[2]!.patch).toContain("-staged");
  expect(result.summary).toContain("cancel");
  expect(result.coverage.state).toBe("complete");
});

test("compares HEAD with actual bytes after a staged deletion is recreated untracked", async () => {
  const cwd = await repository();
  await git(cwd, "rm", "file.txt");
  await writeFile(join(cwd, "file.txt"), "recreated\n");
  const review = await uncommitted(cwd);
  expect(review.files).toHaveLength(1);
  const { result } = await fileContent(review, "file.txt");
  expect(result.sections[0]!.patch).toContain("-base");
  expect(result.sections[0]!.patch).toContain("+recreated");
  expect(result.sections[1]!.patch).toContain("deleted file mode");
  expect(result.sections[2]!.patch).toContain("+recreated");
});

test("detects same-status byte and executable-mode changes before reading or staging", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "file.txt"), "first edit\n");
  const first = await uncommitted(cwd);
  const file = first.files[0]!;
  const originalStatus = await git(cwd, "status", "--porcelain=v1");
  await writeFile(join(cwd, "file.txt"), "other edit\n");
  expect(await git(cwd, "status", "--porcelain=v1")).toBe(originalStatus);
  expect(await readGitReviewFile(first, file.id)).toMatchObject({ state: "stale" });
  expect(await changeGitReviewFileStage(first, file.id, "stage")).toMatchObject({ state: "stale" });
  expect(await git(cwd, "diff", "--cached")).toBe("");
  const second = await uncommitted(cwd);
  await chmod(join(cwd, "file.txt"), 0o755);
  expect(await checkGitReviewFileCurrent(second, second.files[0]!.id)).toMatchObject({
    state: "stale",
  });
});

test("stages and unstages exact pathological paths, rename pairs, and unborn additions", async () => {
  const cwd = await repository();
  const odd = ' :(glob)* spaced\t"quoted"\nname.txt';
  await writeFile(join(cwd, odd), "odd content\n");
  let review = await uncommitted(cwd);
  let file = review.files.find((entry) => entry.path === odd)!;
  expect((await fileContent(review, odd)).result.sections[0]!.patch).toContain("+odd content");
  expect(await changeGitReviewFileStage(review, file.id, "stage")).toEqual({ state: "applied" });
  expect(await git(cwd, "diff", "--cached", "--name-only", "-z")).toBe(`${odd}\0`);
  review = await uncommitted(cwd);
  file = review.files.find((entry) => entry.path === odd)!;
  expect(await changeGitReviewFileStage(review, file.id, "unstage")).toEqual({ state: "applied" });
  expect(await readFile(join(cwd, odd), "utf8")).toBe("odd content\n");
  await rename(join(cwd, "file.txt"), join(cwd, "renamed.txt"));
  await git(cwd, "add", "-A", "--", "file.txt", "renamed.txt");
  review = await uncommitted(cwd);
  const renamed = review.files.find((entry) => entry.path === "renamed.txt")!;
  expect(renamed).toMatchObject({ status: "renamed", previousPath: "file.txt" });
  expect(await changeGitReviewFileStage(review, renamed.id, "unstage")).toEqual({
    state: "applied",
  });
  expect(await git(cwd, "diff", "--cached")).toBe("");
  const fresh = await repository(true);
  await writeFile(join(fresh, "new.txt"), "first file\n");
  review = await uncommitted(fresh);
  expect(review.headOid).toBeNull();
  expect((await fileContent(review, "new.txt")).result.sections[0]!.patch).toContain("+first file");
  expect(await changeGitReviewFileStage(review, review.files[0]!.id, "stage")).toEqual({
    state: "applied",
  });
  review = await uncommitted(fresh);
  expect(await changeGitReviewFileStage(review, review.files[0]!.id, "unstage")).toEqual({
    state: "applied",
  });
  expect(await git(fresh, "ls-files")).toBe("");
  expect(await readFile(join(fresh, "new.txt"), "utf8")).toBe("first file\n");
});

test("stages unstaged edits on top of a staged rename", async () => {
  const cwd = await repository();
  await git(cwd, "mv", "--", "file.txt", "renamed.txt");
  await writeFile(join(cwd, "renamed.txt"), "base\nedited after rename\n");
  const review = await uncommitted(cwd);
  const renamed = review.files.find((entry) => entry.path === "renamed.txt")!;
  expect(renamed).toMatchObject({
    status: "renamed",
    previousPath: "file.txt",
    hasUnstagedChanges: true,
  });
  expect(await changeGitReviewFileStage(review, renamed.id, "stage")).toEqual({
    state: "applied",
  });
  expect(await git(cwd, "diff", "--name-only")).toBe("");
  expect(await git(cwd, "show", ":renamed.txt")).toBe("base\nedited after rename\n");
  expect(await git(cwd, "ls-files")).toBe("renamed.txt\n");
});

test("pins branch merge-base and HEAD while excluding staged, unstaged, and untracked edits", async () => {
  const cwd = await repository();
  await git(cwd, "switch", "-c", "feature");
  await writeFile(join(cwd, "file.txt"), "committed feature\n");
  await git(cwd, "commit", "-am", "feature");
  await writeFile(join(cwd, "file.txt"), "staged dirty\n");
  await git(cwd, "add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "unstaged dirty\n");
  await writeFile(join(cwd, "untracked.txt"), "untracked dirty\n");
  const review = await createGitReview(cwd, { kind: "branch", baseRef: "trunk" });
  expect(review.state).toBe("available");
  if (review.state !== "available") throw new Error(review.message);
  expect(review.files.map((file) => file.path)).toEqual(["file.txt"]);
  const patch = (await fileContent(review, "file.txt")).result.sections[0]!.patch;
  expect(patch).toContain("+committed feature");
  expect(patch).not.toContain("dirty");
  await git(cwd, "commit", "-am", "later commit");
  expect((await fileContent(review, "file.txt")).result.sections[0]!.patch).toBe(patch);
  expect(await changeGitReviewFileStage(review, review.files[0]!.id, "stage")).toMatchObject({
    state: "unavailable",
    code: "immutable-comparison",
  });
});

test("uses configured remote HEAD and reports missing or unrelated branch bases", async () => {
  const cwd = await repository();
  expect(await createGitReview(cwd, { kind: "branch" })).toMatchObject({
    state: "unavailable",
    code: "missing-base",
  });
  await git(cwd, "update-ref", "refs/remotes/upstream/trunk", "HEAD");
  await git(cwd, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk");
  const resolved = await createGitReview(cwd, { kind: "branch" });
  expect(resolved).toMatchObject({
    state: "available",
    scope: { kind: "branch", baseRef: "refs/remotes/upstream/trunk" },
  });
  expect(await createGitReview(cwd, { kind: "branch", baseRef: "does-not-exist" })).toMatchObject({
    state: "unavailable",
    code: "missing-base",
  });
  await git(cwd, "switch", "--orphan", "unrelated");
  await writeFile(join(cwd, "orphan.txt"), "orphan\n");
  await git(cwd, "add", "orphan.txt");
  await git(cwd, "commit", "-m", "unrelated");
  expect(await createGitReview(cwd, { kind: "branch", baseRef: "trunk" })).toMatchObject({
    state: "unavailable",
    code: "unrelated-base",
  });
});

test("makes binary, deleted, empty, conflict, and submodule coverage explicit", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "binary.dat"), Buffer.from([1, 0, 2]));
  await writeFile(join(cwd, "empty.txt"), "");
  await unlink(join(cwd, "file.txt"));
  let review = await uncommitted(cwd);
  const binary = (await fileContent(review, "binary.dat")).result;
  expect(binary.coverage).toMatchObject({ state: "partial" });
  expect(binary.coverage.notes.join(" ")).toContain("Binary");
  expect((await fileContent(review, "empty.txt")).result.sections[0]!.patch).toContain(
    "new file mode",
  );
  expect((await fileContent(review, "file.txt")).result.sections[0]!.patch).toContain(
    "deleted file mode",
  );
  const subOid = (await git(cwd, "rev-parse", "HEAD")).trim();
  await git(cwd, "update-index", "--add", "--cacheinfo", `160000,${subOid},nested`);
  await mkdir(join(cwd, "nested"));
  review = await uncommitted(cwd);
  const submodule = (await fileContent(review, "nested")).result;
  expect(submodule.coverage.state).toBe("partial");
  expect(submodule.coverage.notes.join(" ")).toContain("Submodule");
  const conflict = await repository();
  await git(conflict, "switch", "-c", "other");
  await writeFile(join(conflict, "file.txt"), "other\n");
  await git(conflict, "commit", "-am", "other");
  await git(conflict, "switch", "trunk");
  await writeFile(join(conflict, "file.txt"), "ours\n");
  await git(conflict, "commit", "-am", "ours");
  await git(conflict, "merge", "other").catch(() => undefined);
  review = await uncommitted(conflict);
  const unmerged = await fileContent(review, "file.txt");
  expect(unmerged.file.conflicted).toBe(true);
  expect(unmerged.result.summary).toMatch(/base .*ours .*theirs /);
  expect(unmerged.result.coverage.state).toBe("partial");
  expect(await changeGitReviewFileStage(review, unmerged.file.id, "stage")).toMatchObject({
    state: "unavailable",
  });
});

test("renders symlink text without following its target and reports oversized content", async () => {
  const cwd = await repository();
  const secret = join(await mkdtemp(join(tmpdir(), "pi-review-outside-")), "secret.txt");
  await writeFile(secret, "outside-content-must-not-be-read");
  await symlink(secret, join(cwd, "link"));
  await writeFile(join(cwd, "large.txt"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  const review = await uncommitted(cwd);
  const link = (await fileContent(review, "link")).result;
  expect(link.sections[0]!.patch).toContain(secret);
  expect(link.sections[0]!.patch).not.toContain("outside-content-must-not-be-read");
  const large = (await fileContent(review, "large.txt")).result;
  expect(large.coverage.state).toBe("partial");
  expect(large.coverage.notes.join(" ")).toContain("8 MiB");
});

test("reads captured trees from a separate bare repository", async () => {
  const cwd = await repository();
  const beforeTreeOid = (await git(cwd, "rev-parse", "HEAD^{tree}")).trim();
  await writeFile(join(cwd, "file.txt"), "captured after\n");
  await git(cwd, "commit", "-am", "after");
  const afterTreeOid = (await git(cwd, "rev-parse", "HEAD^{tree}")).trim();
  const directory = await mkdtemp(join(tmpdir(), "pi-review-capture-"));
  const bare = join(directory, "objects.git");
  await git(directory, "clone", "--bare", cwd, bare);
  const review = await createGitReview(bare, {
    kind: "turn",
    checkpointId: "capture-one",
    beforeTreeOid,
    afterTreeOid,
    coverage: { state: "partial", notes: ["Concurrent editor activity may be included."] },
  });
  expect(review.state).toBe("available");
  if (review.state !== "available") throw new Error(review.message);
  expect(review.scope).toEqual({ kind: "turn", checkpointId: "capture-one" });
  expect(review.coverage.state).toBe("partial");
  expect((await fileContent(review, "file.txt")).result.sections[0]!.patch).toContain(
    "+captured after",
  );
});

test("rejects nested workspace roots and labels raw-byte conversion coverage", async () => {
  const cwd = await repository();
  await mkdir(join(cwd, "subdirectory"));
  expect(await createGitReview(join(cwd, "subdirectory"), { kind: "uncommitted" })).toMatchObject({
    state: "unavailable",
    code: "nested-workspace",
  });
  expect(
    await createGitReview(join(cwd, "subdirectory"), { kind: "branch", baseRef: "trunk" }),
  ).toMatchObject({ state: "unavailable", code: "nested-workspace" });
  await writeFile(join(cwd, ".gitattributes"), "file.txt eol=crlf\n");
  await writeFile(join(cwd, "file.txt"), "raw converted file\r\n");
  const review = await uncommitted(cwd);
  expect(review.coverage.state).toBe("partial");
  expect(review.coverage.notes.join(" ")).toContain("raw working bytes");
});

test("bounds snapshot hashing and labels a truncated patch rather than a complete result", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "patch.txt"), "new line\n".repeat(140_000));
  let review = await uncommitted(cwd);
  const patch = (await fileContent(review, "patch.txt")).result;
  expect(patch.coverage.state).toBe("partial");
  expect(patch.coverage.notes.join(" ")).toContain("truncated");
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(cwd, `large-${index}.txt`), Buffer.alloc(8 * 1024 * 1024, 65));
  }
  review = await uncommitted(cwd);
  const omitted = review.files.find((file) => file.source.working?.note?.includes("budget"));
  expect(omitted).toBeDefined();
  expect(review.coverage.state).toBe("partial");
  expect(review.files.every((file) => file.source.working?.bytes === undefined)).toBe(true);
  const result = await readGitReviewFile(review, omitted!.id);
  expect(result).toMatchObject({ state: "available", coverage: { state: "partial" } });
  expect(await changeGitReviewFileStage(review, omitted!.id, "stage")).toMatchObject({
    state: "unavailable",
  });
});

async function inventory(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(directory, path));
    else if (entry.isFile()) {
      const metadata = await stat(join(directory, path));
      result[path] =
        `${metadata.mode}:${metadata.mtimeMs}:${(await readFile(join(directory, path))).toString("base64")}`;
    }
  }
  return result;
}

test("review creation and lazy reads do not mutate user Git files, objects, refs, or index", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "file.txt"), "staged\n");
  await git(cwd, "add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "working\n");
  const before = await inventory(join(cwd, ".git"));
  const worktreeBefore = await readFile(join(cwd, "file.txt"));
  const review = await uncommitted(cwd);
  await fileContent(review, "file.txt");
  expect(await inventory(join(cwd, ".git"))).toEqual(before);
  expect(await readFile(join(cwd, "file.txt"))).toEqual(worktreeBefore);
});

test("repository ignore rules exclude generated evidence and caches, preserving source and tracked files", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, ".gitignore"),
    await readFile(join(__dirname, "../../../..", ".gitignore")),
  );
  await mkdir(join(cwd, ".artifacts"));
  await mkdir(join(cwd, ".pnpm-store"));
  await writeFile(join(cwd, ".artifacts", "tracked.txt"), "baseline\n");
  await git(cwd, "add", ".gitignore");
  await git(cwd, "add", "--force", ".artifacts/tracked.txt");
  await git(cwd, "commit", "-m", "Tracked exception");
  await writeFile(join(cwd, ".artifacts", "backup.bin"), "generated backup");
  await writeFile(join(cwd, ".pnpm-store", "package.bin"), "generated cache");
  await writeFile(join(cwd, ".artifacts", "tracked.txt"), "changed tracked file\n");
  await writeFile(join(cwd, "new-source.ts"), "export const value = 1;\n");
  const review = await uncommitted(cwd);
  expect(review.files.map((file) => file.path).sort()).toEqual([
    ".artifacts/tracked.txt",
    "new-source.ts",
  ]);
  expect(review.coverage.state).toBe("complete");
});

test("inherited Git repository overrides cannot redirect review reads or staging", async () => {
  const cwd = await repository();
  const decoy = await repository();
  await writeFile(join(cwd, "file.txt"), "checkout change\n");
  await writeFile(join(decoy, "decoy.txt"), "decoy change\n");
  const overrides = {
    GIT_DIR: join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(decoy, ".git", "index"),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const review = await uncommitted(cwd);
    expect(review.files.map((file) => file.path)).toEqual(["file.txt"]);
    await expect(changeGitReviewFileStage(review, review.files[0]!.id, "stage")).resolves.toEqual({
      state: "applied",
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("file.txt\n");
  expect(await git(decoy, "diff", "--cached", "--name-only")).toBe("");
});
