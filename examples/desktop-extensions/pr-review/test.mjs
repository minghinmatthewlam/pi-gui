import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import "./integration.test.mjs";

const temporary = await mkdtemp(join(tmpdir(), "pi-pr-review-example-"));
const directory = fileURLToPath(new URL(".", import.meta.url));
await build({
  absWorkingDir: directory,
  entryPoints: ["review.ts", "repository.ts", "contract.ts"],
  outdir: temporary,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const domain = await import(pathToFileURL(join(temporary, "review.mjs")).href);
const { staleReason } = await import(pathToFileURL(join(temporary, "contract.mjs")).href);
const { ReviewRepository } = await import(pathToFileURL(join(temporary, "repository.mjs")).href);
const target = {
  checkout: "/project",
  repository: "github.com/example/project",
  number: 42,
  url: "https://github.com/example/project/pull/42",
  title: "Change",
  branch: "feature",
  base: "a".repeat(40),
  head: "b".repeat(40),
  mergeBase: "a".repeat(40),
  localHead: "b".repeat(40),
  dirty: false,
  files: ["src/search.ts"],
};
const running = () => ({ ...domain.requestRecord(target, "request-1"), status: "running" });
const input = {
  reviewId: "request-1",
  head: target.head,
  summary: "One concrete bug.",
  findings: [
    {
      priority: "P1",
      title: "Handle an empty index",
      body: "An empty index currently throws before the query returns.",
      path: "src/search.ts",
      line: 2,
    },
  ],
};

test("only the active revision can record findings; arbitrary paths and malformed locations fail", () => {
  assert.throws(
    () => domain.recordFindings(running(), { ...input, head: "c".repeat(40) }),
    /revision/,
  );
  for (const patch of [
    { path: "../secret" },
    { path: "elsewhere.ts" },
    { line: 0 },
    { priority: "P0" },
  ])
    assert.throws(
      () =>
        domain.recordFindings(running(), {
          ...input,
          findings: [{ ...input.findings[0], ...patch }],
        }),
      /invalid/,
    );
  const recorded = domain.recordFindings(running(), input);
  assert.equal(recorded.status, "running");
  assert.equal(recorded.findings.length, 1);
  assert.equal(domain.finishReview(recorded, "completed").status, "completed");
  assert.equal(domain.finishReview(recorded, "aborted").status, "aborted");
  assert.equal(domain.finishReview(running(), "completed").status, "incomplete");
});

test("fix drafts retain source provenance and reject a changed PR, checkout, or incomplete review", () => {
  const record = domain.finishReview(domain.recordFindings(running(), input), "completed");
  const draft = domain.prepareFix(record, target, record.findings[0].id);
  assert.match(draft.prompt, new RegExp(target.head));
  assert.match(draft.prompt, /request-1/);
  assert.deepEqual(draft.files, [{ path: "src/search.ts", line: 2 }]);
  for (const changed of [
    { ...target, head: "c".repeat(40) },
    { ...target, base: "d".repeat(40) },
    { ...target, localHead: "c".repeat(40) },
    { ...target, number: 43 },
    null,
  ]) {
    assert.ok(staleReason(record, changed));
    assert.throws(() => domain.prepareFix(record, changed, record.findings[0].id));
  }
});

test("branch restoration ignores unrelated/malformed entries and never claims an orphaned run completed", () => {
  const record = running();
  const entries = [
    { type: "custom", customType: domain.ENTRY, data: record },
    { type: "custom", customType: domain.ENTRY, data: { version: 1 } },
  ];
  assert.equal(domain.restoreRecord(entries).status, "interrupted");
  assert.equal(record.status, "running");
  assert.equal(domain.restoreRecord([]), null);
});

test("Git reads the captured commit, including its diff, after the working file changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-pr-review-git-"));
  const execute = promisify(execFile);
  const git = async (...args) =>
    (await execute("git", args, { cwd, encoding: "utf8" })).stdout.trim();
  await git("init", "-q");
  await writeFile(join(cwd, "search.ts"), "export const limit = 10;\n");
  await git("add", "search.ts");
  await git(
    "-c",
    "user.name=Example Test",
    "-c",
    "user.email=example@localhost",
    "commit",
    "-qm",
    "base",
  );
  const base = await git("rev-parse", "HEAD");
  await writeFile(join(cwd, "search.ts"), "export const limit = 20;\n");
  await git("add", "search.ts");
  await git(
    "-c",
    "user.name=Example Test",
    "-c",
    "user.email=example@localhost",
    "commit",
    "-qm",
    "head",
  );
  const head = await git("rev-parse", "HEAD");
  await writeFile(join(cwd, "search.ts"), "uncommitted text\n");
  const repository = new ReviewRepository(cwd, new AbortController().signal);
  const identity = {
    ...target,
    checkout: cwd,
    base,
    mergeBase: base,
    head,
    localHead: head,
    files: ["search.ts"],
  };
  assert.equal(await repository.read(identity, "file", "search.ts"), "export const limit = 20;\n");
  assert.match(await repository.read(identity, "diff", "search.ts"), /\+export const limit = 20/);
  const nested = join(cwd, "packages", "app");
  await mkdir(nested, { recursive: true });
  const nestedRepository = new ReviewRepository(nested, new AbortController().signal);
  assert.match(
    await nestedRepository.read(identity, "diff", "search.ts"),
    /\+export const limit = 20/,
  );
  await assert.rejects(repository.read(identity, "file", "../outside"), /repository-relative/);
});
