import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { CoreProcess } from "../../core-process/launch";
import {
  gitReviewClient,
  type GitReview,
  type GitReviewScope,
} from "../../electron/platform/files/git-review";
import {
  workspaceFilesClient,
  type WorkspaceFiles,
} from "../../electron/platform/files/workspace-files";
import { startTestCore } from "../helpers/rust-core";
import * as typescriptFiles from "./oracles/app-store-files";
import * as typescriptReview from "./oracles/git-review";

/**
 * The Rust core replaced the TypeScript review and file-listing code, so the two run side by
 * side on the same checkouts and must give the same answers. Fingerprints must match exactly:
 * reviewed marks saved by earlier versions are keyed by them.
 */

const execute = promisify(execFile);
let core: CoreProcess;
let rust: { review: GitReview; files: WorkspaceFiles };
let dir: string;

test.beforeAll(async () => {
  core = await startTestCore(await mkdtemp(join(tmpdir(), "pi-gui-core-git-")));
  rust = { review: gitReviewClient(core.peer), files: workspaceFilesClient(core.peer) };
});

test.afterAll(async () => {
  await core.stop(1_000);
});

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-gui-core-git-fixture-"));
});

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }))
    .stdout;
}

/** A checkout with every kind of change the review distinguishes. */
async function busyCheckout(): Promise<string> {
  const cwd = join(dir, "checkout");
  await mkdir(join(cwd, "nested", "deeper"), { recursive: true });
  await git(cwd, "init", "-b", "trunk");
  await git(cwd, "config", "user.email", "review@example.invalid");
  await git(cwd, "config", "user.name", "Review fixture");
  const files: Record<string, string> = {
    "file.txt": "base\n",
    "staged.txt": "one\ntwo\n",
    "both.txt": "a\nb\nc\n",
    "gone.txt": "deleted later\n",
    "renamed-from.txt": "rename me\n".repeat(20),
    "nested/deeper/inner.md": "# inner\n",
    "ünïcödé name.txt": "unicode\n",
    "tool.sh": "#!/bin/sh\n",
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(cwd, path), content);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "base");
  await git(cwd, "switch", "-c", "feature");
  await writeFile(join(cwd, "file.txt"), "base\ncommitted on feature\n");
  await writeFile(join(cwd, "feature-only.txt"), "feature\n");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "feature");

  await writeFile(join(cwd, "file.txt"), "base\ncommitted on feature\nworking edit\n");
  await writeFile(join(cwd, "staged.txt"), "one\ntwo\nstaged\n");
  await git(cwd, "add", "staged.txt");
  await writeFile(join(cwd, "both.txt"), "a\nB\nc\n");
  await git(cwd, "add", "both.txt");
  await writeFile(join(cwd, "both.txt"), "a\nB\nc\nd\n");
  await rm(join(cwd, "gone.txt"));
  await git(cwd, "mv", "renamed-from.txt", "renamed-to.txt");
  await writeFile(join(cwd, "untracked.txt"), "new\nfile");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([1, 0, 2, 3]));
  await writeFile(join(cwd, "empty.txt"), "");
  await writeFile(join(cwd, "bom.txt"), "﻿with a byte order mark\n");
  await writeFile(join(cwd, 'odd :(glob)* "name"\twith tab.txt'), "odd\n");
  await writeFile(join(cwd, "nested", "deeper", "inner.md"), "# inner\nedited\n");
  await chmod(join(cwd, "tool.sh"), 0o755);
  await symlink("file.txt", join(cwd, "link"));
  await writeFile(join(cwd, "large.txt"), Buffer.alloc(8 * 1024 * 1024 + 1, 66));
  return cwd;
}

/** Strips `undefined` fields, as the trip through JSON does. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function compareReviews(cwd: string, scope: GitReviewScope) {
  const expected = await typescriptReview.createGitReview(cwd, scope);
  const actual = await rust.review.createGitReview(cwd, scope);
  expect(actual, `${scope.kind} snapshot`).toEqual(plain(expected));
  if (expected.state !== "available") return;
  for (const file of expected.files) {
    expect(
      await rust.review.readGitReviewFile(expected, file.id),
      `${scope.kind} ${file.path}`,
    ).toEqual(plain(await typescriptReview.readGitReviewFile(expected, file.id)));
    expect(await rust.review.checkGitReviewFileCurrent(expected, file.id)).toEqual(
      await typescriptReview.checkGitReviewFileCurrent(expected, file.id),
    );
  }
  return expected;
}

test("every working scope gives the same snapshot, fingerprints, patches and checks", async () => {
  const cwd = await busyCheckout();
  for (const kind of ["uncommitted", "staged", "unstaged"] as const) {
    const review = await compareReviews(cwd, { kind });
    expect(review?.files.length).toBeGreaterThanOrEqual(3);
  }
  // A stale snapshot is reported the same way.
  const review = await typescriptReview.createGitReview(cwd, { kind: "uncommitted" });
  if (review.state !== "available") throw new Error(review.message);
  await writeFile(join(cwd, "file.txt"), "changed after the review\n");
  const file = review.files.find((entry) => entry.path === "file.txt")!;
  expect(await rust.review.checkGitReviewFileCurrent(review, file.id)).toEqual(
    await typescriptReview.checkGitReviewFileCurrent(review, file.id),
  );
  expect(await rust.review.changeGitReviewFileStage(review, file.id, "stage")).toEqual(
    await typescriptReview.changeGitReviewFileStage(review, file.id, "stage"),
  );
});

test("branch, turn and unborn comparisons agree, including their issues", async () => {
  const cwd = await busyCheckout();
  await compareReviews(cwd, { kind: "branch", baseRef: "trunk" });
  await compareReviews(cwd, { kind: "branch" });
  await compareReviews(cwd, { kind: "branch", baseRef: "no-such-ref" });
  await compareReviews(join(cwd, "nested"), { kind: "uncommitted" });
  const beforeTreeOid = (await git(cwd, "rev-parse", "trunk^{tree}")).trim();
  const afterTreeOid = (await git(cwd, "rev-parse", "feature^{tree}")).trim();
  await compareReviews(cwd, {
    kind: "turn",
    checkpointId: "turn-1",
    beforeTreeOid,
    afterTreeOid,
    coverage: { state: "partial", notes: ["Concurrent editor activity may be included."] },
  });
  expect(await rust.review.summarizeGitTreeChanges(cwd, beforeTreeOid, afterTreeOid)).toEqual(
    plain(await typescriptReview.summarizeGitTreeChanges(cwd, beforeTreeOid, afterTreeOid)),
  );

  const unborn = join(dir, "unborn");
  await mkdir(unborn);
  await git(unborn, "init", "-b", "trunk");
  await writeFile(join(unborn, "first.txt"), "a\nb\n");
  await writeFile(join(unborn, "second.txt"), "c\n");
  await git(unborn, "add", "first.txt");
  for (const kind of ["uncommitted", "staged", "unstaged"] as const) {
    await compareReviews(unborn, { kind });
  }
  await compareReviews(unborn, { kind: "branch", baseRef: "trunk" });
});

test("file lists and previews agree for checkouts and plain folders", async () => {
  const cwd = await busyCheckout();
  await writeFile(join(cwd, ".gitignore"), "ignored/\n*.log\n");
  await mkdir(join(cwd, "ignored"));
  await writeFile(join(cwd, "ignored", "x.txt"), "x\n");
  await writeFile(join(cwd, "debug.log"), "log\n");
  const plainFolder = join(dir, "plain");
  for (const path of ["b/z.txt", "a/y.txt", "A/x.txt", "build/out.js", "keep/build/in.ts"]) {
    await mkdir(join(plainFolder, path, ".."), { recursive: true });
    await writeFile(join(plainFolder, path), "x\n");
  }
  await writeFile(join(plainFolder, "Zed.md"), "z\n");
  await writeFile(join(plainFolder, "éclair.md"), "e\n");
  await writeFile(join(plainFolder, ".gitignore"), "/build/\n!keep/build/\n*.tmp\n");
  await writeFile(join(plainFolder, "skip.tmp"), "t\n");
  await mkdir(join(plainFolder, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(plainFolder, "node_modules", "pkg", "index.js"), "x\n");

  for (const folder of [cwd, plainFolder, join(dir, "missing")]) {
    for (const maxFiles of [undefined, 3]) {
      const options = { force: true, ...(maxFiles ? { maxFiles } : {}) };
      expect(await rust.files.listWorkspaceFiles(folder, options), `${folder} ${maxFiles}`).toEqual(
        await typescriptFiles.listWorkspaceFiles(folder, options),
      );
    }
  }

  await writeFile(join(cwd, "big.txt"), "x".repeat(300 * 1024));
  await writeFile(join(cwd, "broken.txt"), Buffer.from([0x61, 0xff, 0xfe, 0x62, 0xe2, 0x82]));
  for (const path of [
    "file.txt",
    "bom.txt",
    "binary.dat",
    "big.txt",
    "broken.txt",
    "nested",
    "link",
    "ünïcödé name.txt",
  ]) {
    expect(await rust.files.readWorkspaceFile(cwd, path), path).toEqual(
      await typescriptFiles.readWorkspaceFile(cwd, path),
    );
  }
  for (const path of ["../outside.txt", "missing.txt"]) {
    const expected = await typescriptFiles
      .readWorkspaceFile(cwd, path)
      .catch((error: unknown) => error);
    const actual = await rust.files.readWorkspaceFile(cwd, path).catch((error: unknown) => error);
    expect(actual).toBeInstanceOf(Error);
    expect((actual as Error).message).toBe((expected as Error).message);
  }
});
