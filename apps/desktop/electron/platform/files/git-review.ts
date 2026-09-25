import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ChangeReviewFileStageResult,
  ReviewCoverage,
  ReviewFileEntry,
  ReviewFileStatus,
  ReviewIssue,
  ReviewLineCounts,
  ReviewScope,
  TurnChangedFile,
} from "../../../contracts/review";
import { isWorkingReviewScope } from "../../../contracts/review";
import { isolatedGitEnvironment } from "./git-environment";

const MAX_FILES = 2_000;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_GIT_BYTES = 32 * 1024 * 1024;
const MAX_PREPARATION_BYTES = 32 * 1024 * 1024;
const PREPARATION_MS = 10_000;
/** Pathspec bytes per Git call, well below Windows' 32K command-line limit. */
const MAX_PATHSPEC_BYTES = 24_000;
const COMPLETE: ReviewCoverage = { state: "complete", notes: [] };

export interface GitReviewLimits {
  /** Output cap for one Git listing; larger output makes the review unavailable. */
  readonly maxGitBytes: number;
}

export type GitReviewScope =
  | Exclude<ReviewScope, { readonly kind: "turn" }>
  | {
      readonly kind: "turn";
      readonly checkpointId: string;
      readonly beforeTreeOid: string;
      readonly afterTreeOid: string;
      readonly coverage?: ReviewCoverage;
    };

interface BlobRef {
  readonly mode: string;
  readonly oid: string;
  readonly stage?: number;
}

interface WorkingFile {
  readonly mode: string;
  readonly digest: string;
  readonly bytes?: Buffer;
  readonly note?: string;
}

interface FileSource {
  readonly base?: BlobRef;
  readonly index: readonly BlobRef[];
  readonly head?: BlobRef;
  readonly working?: WorkingFile;
  readonly statusRecords: readonly string[];
}

export interface GitReviewFile extends Omit<ReviewFileEntry, "reviewed"> {
  /** Everything the comparison read, including the index; any change makes actions stale. */
  readonly fingerprint: string;
  /** The reviewed content only. Staging moves it into the index without changing it. */
  readonly contentFingerprint: string;
  readonly source: FileSource;
}

export interface GitReviewSnapshot {
  readonly state: "available";
  readonly checkoutPath: string;
  readonly scope: ReviewScope;
  readonly baseLabel: string;
  readonly headOid: string | null;
  readonly baseOid: string | null;
  readonly coverage: ReviewCoverage;
  readonly files: readonly GitReviewFile[];
}

export interface GitReviewFileContent {
  readonly state: "available";
  readonly patch: string;
  readonly coverage: ReviewCoverage;
  readonly summary?: string;
}

interface GitResult {
  readonly stdout: Buffer;
  readonly code: number;
  readonly truncated: boolean;
}

function git(cwd: string, args: readonly string[], maxBuffer = MAX_GIT_BYTES): Promise<GitResult> {
  return new Promise((done, reject) => {
    execFile(
      "git",
      ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer,
        timeout: 15_000,
        env: isolatedGitEnvironment(),
      },
      (error, stdout, stderr) => {
        if (error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          done({ stdout, code: 1, truncated: true });
        } else if (error && typeof error.code !== "number") {
          reject(error);
        } else {
          const code = typeof error?.code === "number" ? error.code : 0;
          if (code > 1) reject(new Error(stderr.toString("utf8").trim() || "Git command failed."));
          else done({ stdout, code, truncated: false });
        }
      },
    );
  });
}

async function gitText(
  cwd: string,
  args: readonly string[],
  maxBuffer = MAX_GIT_BYTES,
): Promise<string> {
  const result = await git(cwd, args, maxBuffer);
  if (result.code !== 0 || result.truncated)
    throw new Error("Git review data is unavailable or exceeds its size limit.");
  return result.stdout.toString("utf8");
}

async function resolveRevision(cwd: string, ref: string, type: "commit" | "tree" = "commit") {
  try {
    return (
      await gitText(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{${type}}`])
    ).trim();
  } catch {
    return null;
  }
}

function issue(state: ReviewIssue["state"], code: string, message: string): ReviewIssue {
  return { state, code, message };
}

function partial(...notes: string[]): ReviewCoverage {
  return { state: "partial", notes: [...new Set(notes)] };
}

function combineCoverage(coverages: readonly ReviewCoverage[]): ReviewCoverage {
  const notes = coverages.flatMap((coverage) => coverage.notes);
  return coverages.some((coverage) => coverage.state === "partial") ? partial(...notes) : COMPLETE;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safePath(root: string, path: string): string {
  const target = resolve(root, path);
  const fromRoot = relative(resolve(root), target);
  if (
    !path ||
    isAbsolute(path) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot) ||
    path.includes("\0")
  ) {
    throw new Error("Invalid Git file path.");
  }
  return target;
}

async function readWorkingFile(
  root: string,
  path: string,
  maxBytes = MAX_CONTENT_BYTES,
): Promise<WorkingFile> {
  const absolute = safePath(root, path);
  // A replaced ancestor must not redirect a review read outside the checkout.
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    try {
      if ((await lstat(join(root, ...segments.slice(0, index)))).isSymbolicLink()) {
        return {
          mode: "unsupported",
          digest: "symlink-parent",
          note: "A parent directory is a symbolic link; content was not followed.",
        };
      }
    } catch (error) {
      if (isMissing(error)) return { mode: "missing", digest: "missing" };
      throw error;
    }
  }
  try {
    const before = await lstat(absolute);
    if (before.isDirectory())
      return {
        mode: "160000",
        digest: `${before.mtimeMs}:${before.ctimeMs}`,
        note: "Submodule or directory content is not included in this patch.",
      };
    const mode = before.isSymbolicLink() ? "120000" : before.mode & 0o111 ? "100755" : "100644";
    if (!before.isSymbolicLink() && !before.isFile())
      return {
        mode: "unsupported",
        digest: "special-file",
        note: "Special file content is not supported.",
      };
    if (before.size > maxBytes)
      return {
        mode,
        digest: `large:${before.size}:${before.mtimeMs}:${before.ctimeMs}`,
        note:
          before.size > MAX_CONTENT_BYTES
            ? "File exceeds the 8 MiB review content limit."
            : "File content was omitted because review preparation reached its byte or time budget.",
      };
    const bytes = before.isSymbolicLink()
      ? Buffer.from(await readlink(absolute))
      : await readFile(absolute);
    const after = await lstat(absolute);
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("File changed while its review snapshot was being read.");
    }
    return { mode, digest: digest(bytes), bytes };
  } catch (error) {
    if (isMissing(error)) return { mode: "missing", digest: "missing" };
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function parseBlobs(output: string, index: boolean): Map<string, BlobRef[]> {
  const blobs = new Map<string, BlobRef[]>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const path = record.slice(tab + 1);
    const fields = record.slice(0, tab).split(" ");
    const mode = fields[0];
    const oid = fields[index ? 1 : 2];
    if (tab < 0 || !mode || !oid) throw new Error("Invalid Git blob listing.");
    const blob = { mode, oid, ...(index ? { stage: Number(fields[2]) } : {}) };
    blobs.set(path, [...(blobs.get(path) ?? []), blob]);
  }
  return blobs;
}

/** Splits pathspecs into command-line-sized batches. */
function pathBatches(paths: Iterable<string>): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of new Set(paths)) {
    const size = Buffer.byteLength(path) + 1;
    if (batch.length && bytes + size > MAX_PATHSPEC_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Lists only the named paths, so the cost follows the change set rather than the size of
 * the repository. Without paths nothing is listed (an empty pathspec would list everything).
 */
async function listBlobs(
  cwd: string,
  command: readonly string[],
  paths: Iterable<string>,
  index: boolean,
  maxGitBytes: number,
): Promise<Map<string, BlobRef[]>> {
  const blobs = new Map<string, BlobRef[]>();
  for (const batch of pathBatches(paths)) {
    const output = await gitText(cwd, [...command, "--", ...batch], maxGitBytes);
    for (const [path, refs] of parseBlobs(output, index)) blobs.set(path, refs);
  }
  return blobs;
}

function tree(cwd: string, oid: string | null, paths: Iterable<string>, maxGitBytes: number) {
  return oid
    ? listBlobs(cwd, ["ls-tree", "-r", "-z", oid], paths, false, maxGitBytes)
    : Promise.resolve(new Map<string, BlobRef[]>());
}

interface StatusFile {
  path: string;
  previousPath?: string;
  status: ReviewFileStatus;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  conflicted: boolean;
  records: string[];
}

function parseStatus(output: string): StatusFile[] {
  const records = output.split("\0");
  const files = new Map<string, StatusFile>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Invalid Git status.");
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    const previousPath = /[RC]/.test(xy) ? records[++index] : undefined;
    const conflicted = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy);
    const status: ReviewFileStatus = conflicted
      ? "conflicted"
      : xy === "??"
        ? "untracked"
        : /R/.test(xy)
          ? "renamed"
          : /C/.test(xy)
            ? "copied"
            : /T/.test(xy)
              ? "typechanged"
              : /A/.test(xy)
                ? "added"
                : /D/.test(xy)
                  ? "deleted"
                  : "modified";
    const prior = files.get(path);
    files.set(path, {
      path,
      ...(previousPath ? { previousPath } : {}),
      status: prior ? "modified" : status,
      hasStagedChanges: Boolean(prior?.hasStagedChanges || (xy[0] !== " " && xy[0] !== "?")),
      hasUnstagedChanges: Boolean(prior?.hasUnstagedChanges || xy[1] !== " "),
      conflicted: Boolean(prior?.conflicted || conflicted),
      records: [...(prior?.records ?? []), record, ...(previousPath ? [previousPath] : [])],
    });
  }
  return [...files.values()];
}

function workingIdentity(working: WorkingFile | undefined) {
  return working ? { mode: working.mode, digest: working.digest } : undefined;
}

/**
 * Everything a comparison's actions depend on. Staged compares HEAD with the index, so
 * working-tree edits (and the status column that reports them) never make it stale.
 */
function fingerprint(source: FileSource, kind: ReviewScope["kind"]): string {
  if (kind === "staged") return digest(JSON.stringify({ base: source.base, index: source.index }));
  return digest(JSON.stringify({ ...source, working: workingIdentity(source.working) }));
}

/** Staging moves content between sides, so Staged and Unstaged fingerprint their own two sides. */
function contentFingerprint(source: FileSource, kind: ReviewScope["kind"]): string {
  const index = source.index.find((blob) => blob.stage === 0);
  const working = workingIdentity(source.working);
  return digest(
    JSON.stringify(
      kind === "staged"
        ? { base: source.base, index }
        : kind === "unstaged"
          ? { index, working }
          : { base: source.base, head: source.head, working },
    ),
  );
}

async function defaultBase(cwd: string): Promise<string | null> {
  const branch = (
    await gitText(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
  ).trim();
  const remote = branch
    ? (await gitText(cwd, ["config", "--get", `branch.${branch}.remote`]).catch(() => "")).trim()
    : "";
  const remoteHeads = (
    await gitText(cwd, ["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"])
  )
    .split("\n")
    .filter((line) => /\/HEAD /.test(line));
  const preferred = remoteHeads.find((line) => line.startsWith(`refs/remotes/${remote}/HEAD `));
  const chosen = preferred ?? (remoteHeads.length === 1 ? remoteHeads[0] : undefined);
  if (chosen) return chosen.slice(chosen.indexOf(" ") + 1).trim() || null;
  if (!branch) return null;
  return (
    (
      await gitText(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]).catch(() => "")
    ).trim() || null
  );
}

export async function createGitReview(
  checkoutPath: string,
  scope: GitReviewScope,
  limits: Partial<GitReviewLimits> = {},
): Promise<GitReviewSnapshot | ReviewIssue> {
  const maxGitBytes = limits.maxGitBytes ?? MAX_GIT_BYTES;
  try {
    if (scope.kind !== "turn") {
      const topLevel = (await gitText(checkoutPath, ["rev-parse", "--show-toplevel"])).trim();
      if ((await realpath(checkoutPath)) !== (await realpath(topLevel)))
        return issue(
          "unavailable",
          "nested-workspace",
          "Git review requires the checkout root. Open the repository root to review its changes.",
        );
    }
    if (isWorkingReviewScope(scope)) {
      const deadline = Date.now() + PREPARATION_MS;
      const headOid = await resolveRevision(checkoutPath, "HEAD");
      const entries = parseStatus(
        await gitText(
          checkoutPath,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          maxGitBytes,
        ),
      ).filter((entry) =>
        scope.kind === "staged"
          ? entry.hasStagedChanges
          : scope.kind === "unstaged"
            ? entry.hasUnstagedChanges
            : true,
      );
      const included = entries.slice(0, MAX_FILES);
      const [indexBlobs, baseBlobs] = await Promise.all([
        listBlobs(
          checkoutPath,
          ["ls-files", "--stage", "-z"],
          included.map((entry) => entry.path),
          true,
          maxGitBytes,
        ),
        tree(
          checkoutPath,
          headOid,
          included.map((entry) => entry.previousPath ?? entry.path),
          maxGitBytes,
        ),
      ]);
      const counts = await workingLineCounts(checkoutPath, scope.kind, headOid, maxGitBytes);
      const files: GitReviewFile[] = [];
      let remainingBytes = MAX_PREPARATION_BYTES;
      for (const entry of included) {
        // Staged never shows the working tree, so it does not spend the read budget on it.
        const working =
          scope.kind === "staged"
            ? undefined
            : await readWorkingFile(
                checkoutPath,
                entry.path,
                Date.now() < deadline ? Math.min(remainingBytes, MAX_CONTENT_BYTES) : 0,
              );
        remainingBytes -= working?.bytes?.length ?? 0;
        const source: FileSource = {
          base: baseBlobs.get(entry.previousPath ?? entry.path)?.[0],
          index: indexBlobs.get(entry.path) ?? [],
          ...(working
            ? {
                working: {
                  mode: working.mode,
                  digest: working.digest,
                  ...(working.note ? { note: working.note } : {}),
                },
              }
            : {}),
          statusRecords: entry.records,
        };
        const { records, ...fields } = entry;
        const untracked = records.some((record) => record.startsWith("?? "));
        files.push({
          ...fields,
          ...scopedStatus(entry, scope.kind),
          lines:
            entry.conflicted || (untracked && entry.status !== "untracked")
              ? null
              : entry.status === "untracked"
                ? // Git diff does not list untracked files, so their added lines are counted here.
                  countTextLines(working?.bytes)
                : (counts?.get(entry.path) ??
                  // Git leaves out a file whose sides match, such as cancelling staged edits.
                  (counts && !counts.truncated ? { added: 0, removed: 0 } : null)),
          id: digest(entry.path),
          fingerprint: fingerprint(source, scope.kind),
          contentFingerprint: contentFingerprint(source, scope.kind),
          source,
        });
      }
      // Each file's index and working state is revalidated against its fingerprint before it is
      // read, reviewed or staged, so the repository-wide listings are not repeated here.
      if (headOid !== (await resolveRevision(checkoutPath, "HEAD"))) {
        return issue(
          "stale",
          "checkout-changed",
          "The checkout changed while the review was being created. Refresh it.",
        );
      }
      const notes = files.flatMap((file) =>
        file.source.working?.note ? [file.source.working.note] : [],
      );
      if (files.length) {
        // Patch generation compares raw bytes without clean/textconv conversion.
        const attributePaths = files.slice(0, 100).map((file) => file.path);
        while (attributePaths.join("\0").length > 32_000) attributePaths.pop();
        const attributes = await gitText(checkoutPath, [
          "check-attr",
          "-z",
          "filter",
          "working-tree-encoding",
          "eol",
          "--",
          ...attributePaths,
        ]);
        const transformed = attributes
          .split("\0")
          .some((value, index) => index % 3 === 2 && value !== "unspecified" && value !== "unset");
        const autoCrlf = (
          await gitText(checkoutPath, ["config", "--get", "core.autocrlf"]).catch(() => "")
        ).trim();
        if (transformed || autoCrlf === "true" || autoCrlf === "input")
          notes.push(
            "Patches compare raw working bytes with Git blobs; configured filters and line-ending conversions are not applied.",
          );
        if (files.length > attributePaths.length)
          notes.push(
            `Attribute-conversion coverage was checked for the first ${attributePaths.length} changed files only; patches use raw bytes.`,
          );
      }
      if (entries.length > MAX_FILES)
        notes.push(`Only the first ${MAX_FILES} changed files are included.`);
      return {
        state: "available",
        checkoutPath,
        scope,
        baseLabel: workingBaseLabel(scope.kind, headOid !== null),
        headOid,
        baseOid: headOid,
        coverage: notes.length ? partial(...notes) : COMPLETE,
        files,
      };
    }
    const headOid = await resolveRevision(
      checkoutPath,
      scope.kind === "turn" ? scope.afterTreeOid : "HEAD",
      scope.kind === "turn" ? "tree" : "commit",
    );
    if (!headOid)
      return issue(
        "unavailable",
        "missing-head",
        "This comparison has no available head revision.",
      );
    const baseRef =
      scope.kind === "turn"
        ? scope.beforeTreeOid
        : (scope.baseRef ?? (await defaultBase(checkoutPath)));
    if (!baseRef)
      return issue(
        "unavailable",
        "missing-base",
        "No repository default or tracking branch is configured. Choose a base reference.",
      );
    let baseOid = await resolveRevision(
      checkoutPath,
      baseRef,
      scope.kind === "turn" ? "tree" : "commit",
    );
    if (!baseOid)
      return issue("unavailable", "missing-base", "The selected base reference is unavailable.");
    if (scope.kind === "branch") {
      baseOid = (
        await gitText(checkoutPath, ["merge-base", baseOid, headOid]).catch(() => "")
      ).trim();
      if (!baseOid)
        return issue(
          "unavailable",
          "unrelated-base",
          "The selected base and HEAD have no common ancestor.",
        );
    }
    const names = (
      await gitText(
        checkoutPath,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-status",
          "-z",
          "--find-renames",
          baseOid,
          headOid,
          "--",
        ],
        maxGitBytes,
      )
    ).split("\0");
    const changes: { code: string; first: string; path: string; renamed: boolean }[] = [];
    for (let index = 0; index < names.length; index += 1) {
      const code = names[index];
      if (!code) continue;
      const first = names[++index];
      const renamed = /^[RC]/.test(code);
      const path = renamed ? names[++index] : first;
      if (!path || !first) throw new Error("Invalid Git comparison listing.");
      changes.push({ code, first, path, renamed });
    }
    const included = changes.slice(0, MAX_FILES);
    const [baseBlobs, headBlobs] = await Promise.all([
      tree(
        checkoutPath,
        baseOid,
        included.map((change) => change.first),
        maxGitBytes,
      ),
      tree(
        checkoutPath,
        headOid,
        included.map((change) => change.path),
        maxGitBytes,
      ),
    ]);
    const counts = new Map(
      (await numstat(checkoutPath, [baseOid, headOid], maxGitBytes)).map((file) => [
        file.path,
        file.lines,
      ]),
    );
    const files: GitReviewFile[] = [];
    for (const { code, first, path, renamed } of included) {
      const status: ReviewFileStatus =
        code[0] === "A"
          ? "added"
          : code[0] === "D"
            ? "deleted"
            : code[0] === "R"
              ? "renamed"
              : code[0] === "C"
                ? "copied"
                : code[0] === "T"
                  ? "typechanged"
                  : "modified";
      const source: FileSource = {
        base: baseBlobs.get(first)?.[0],
        head: headBlobs.get(path)?.[0],
        index: [],
        statusRecords: [],
      };
      files.push({
        id: digest(path),
        path,
        ...(renamed ? { previousPath: first } : {}),
        status,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        conflicted: false,
        lines: counts.get(path) ?? null,
        source,
        fingerprint: fingerprint(source, scope.kind),
        contentFingerprint: contentFingerprint(source, scope.kind),
      });
    }
    const coverage = combineCoverage([
      scope.kind === "turn" ? (scope.coverage ?? COMPLETE) : COMPLETE,
      changes.length > MAX_FILES
        ? partial(`Only the first ${MAX_FILES} changed files are included.`)
        : COMPLETE,
    ]);
    return {
      state: "available",
      checkoutPath,
      scope:
        scope.kind === "turn"
          ? { kind: "turn", checkpointId: scope.checkpointId }
          : { kind: "branch", baseRef },
      baseLabel: scope.kind === "turn" ? "Captured turn" : baseRef,
      headOid,
      baseOid,
      coverage,
      files,
    };
  } catch (error) {
    return issue(
      "unavailable",
      "git-review-unavailable",
      error instanceof Error ? error.message : "Git review is unavailable.",
    );
  }
}

/** Per-file line counts between two captured trees, in Git's path order. */
export async function summarizeGitTreeChanges(
  repositoryPath: string,
  beforeTreeOid: string,
  afterTreeOid: string,
): Promise<TurnChangedFile[]> {
  return numstat(repositoryPath, [beforeTreeOid, afterTreeOid]);
}

/** `git diff --numstat` for the given comparison arguments, in Git's path order. */
async function numstat(
  cwd: string,
  comparison: readonly string[],
  maxGitBytes = MAX_GIT_BYTES,
): Promise<TurnChangedFile[]> {
  const records = (
    await gitText(
      cwd,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        "--find-renames",
        ...comparison,
        "--",
      ],
      maxGitBytes,
    )
  ).split("\0");
  const files: TurnChangedFile[] = [];
  for (let index = 0; index < records.length && files.length < MAX_FILES; index += 1) {
    const record = records[index];
    if (!record) continue;
    // With -z paths are not quoted, so a path may itself contain tabs.
    const addedEnd = record.indexOf("\t");
    const removedEnd = record.indexOf("\t", addedEnd + 1);
    if (addedEnd < 0 || removedEnd < 0) throw new Error("Invalid Git change summary.");
    const added = record.slice(0, addedEnd);
    const removed = record.slice(addedEnd + 1, removedEnd);
    const inlinePath = record.slice(removedEnd + 1);
    // A rename leaves the inline path empty and lists the old and new paths next.
    const previousPath = inlinePath ? undefined : records[++index];
    const path = inlinePath || records[++index];
    if (!path || previousPath === "") throw new Error("Invalid Git change summary.");
    files.push({
      path,
      ...(previousPath === undefined ? {} : { previousPath }),
      lines:
        added === "-" || removed === "-"
          ? null
          : { added: Number(added), removed: Number(removed) },
    });
  }
  return files;
}

interface LineCountMap {
  readonly get: (path: string) => ReviewLineCounts | null | undefined;
  /** The listing stopped at the file cap, so a missing path may still have changes. */
  readonly truncated: boolean;
}

/** Tracked-file line counts for a working scope, keyed by current path; null when uncountable. */
async function workingLineCounts(
  cwd: string,
  kind: "uncommitted" | "staged" | "unstaged",
  headOid: string | null,
  maxGitBytes: number,
): Promise<LineCountMap | null> {
  const comparison =
    kind === "staged" ? ["--cached"] : kind === "unstaged" ? [] : headOid ? [headOid] : null;
  if (!comparison) return null;
  const files = await numstat(cwd, comparison, maxGitBytes);
  const counts = new Map(files.map((file) => [file.path, file.lines]));
  return { get: (path) => counts.get(path), truncated: files.length >= MAX_FILES };
}

const STATUS_CODES: Partial<Record<string, ReviewFileStatus>> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechanged",
  "?": "untracked",
};

/** Staged and Unstaged report the status of their own side: Git's X column for the index, Y for the working tree. */
function scopedStatus(
  entry: StatusFile,
  kind: "uncommitted" | "staged" | "unstaged",
): { status: ReviewFileStatus; previousPath?: string } {
  const { status, previousPath } = entry;
  if (kind === "uncommitted" || entry.conflicted)
    return { status, ...(previousPath ? { previousPath } : {}) };
  const column = kind === "staged" ? 0 : 1;
  const code = entry.records
    .filter((record) => record.length > 3 && record[2] === " ")
    .map((record) => record[column])
    .find((value) => value !== undefined && value !== " " && (kind !== "staged" || value !== "?"));
  return {
    status: (code ? STATUS_CODES[code] : undefined) ?? status,
    ...(previousPath ? { previousPath } : {}),
  };
}

function countTextLines(bytes: Buffer | undefined): ReviewLineCounts | null {
  if (!bytes || bytes.subarray(0, 8000).includes(0)) return null;
  if (bytes.length === 0) return { added: 0, removed: 0 };
  let added = 0;
  for (const byte of bytes) if (byte === 0x0a) added += 1;
  if (bytes[bytes.length - 1] !== 0x0a) added += 1;
  return { added, removed: 0 };
}

function workingBaseLabel(kind: "uncommitted" | "staged" | "unstaged", hasHead: boolean): string {
  const head = hasHead ? "HEAD" : "Empty repository";
  return kind === "staged"
    ? `${head} → index`
    : kind === "unstaged"
      ? "Index → working tree"
      : `${head} → working tree`;
}

export async function checkGitReviewFileCurrent(
  snapshot: GitReviewSnapshot,
  fileId: string,
): Promise<ReviewIssue | null> {
  const file = snapshot.files.find((entry) => entry.id === fileId);
  if (!file)
    return issue("unavailable", "missing-file", "This file does not belong to the review.");
  if (!isWorkingReviewScope(snapshot.scope)) return null;
  const staged = snapshot.scope.kind === "staged";
  try {
    // Path-limited status only pairs a rename when both sides are in the pathspec, so include
    // the other half of any rename touching this file, or its records differ from the review's.
    const ownPaths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
    const renamePartners = snapshot.files
      .filter((entry) => entry.previousPath && ownPaths.includes(entry.previousPath))
      .map((entry) => entry.path);
    const paths = [...new Set([...ownPaths, ...renamePartners])];
    const head = await resolveRevision(snapshot.checkoutPath, "HEAD");
    if (head !== snapshot.headOid)
      return issue("stale", "head-changed", "HEAD changed. Refresh the review.");
    const index = parseBlobs(
      await gitText(snapshot.checkoutPath, ["ls-files", "--stage", "-z", "--", ...paths]),
      true,
    );
    // Staged compares HEAD with the index only, so it skips the status and working reads.
    const current = staged
      ? {}
      : {
          statusRecords:
            parseStatus(
              await gitText(snapshot.checkoutPath, [
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                ...paths,
              ]),
            ).find((entry) => entry.path === file.path)?.records ?? [],
          working: await readWorkingFile(
            snapshot.checkoutPath,
            file.path,
            file.source.working?.note ? 0 : MAX_CONTENT_BYTES,
          ),
        };
    const source: FileSource = {
      ...file.source,
      index: index.get(file.path) ?? [],
      ...current,
    };
    return fingerprint(source, snapshot.scope.kind) === file.fingerprint
      ? null
      : issue(
          "stale",
          "file-changed",
          "The file or index changed. Refresh the review before continuing.",
        );
  } catch (error) {
    return issue(
      "unavailable",
      "freshness-unavailable",
      error instanceof Error ? error.message : "The file could not be checked.",
    );
  }
}

async function readBlob(cwd: string, ref: BlobRef | undefined): Promise<WorkingFile> {
  if (!ref) return { mode: "missing", digest: "missing" };
  if (ref.mode === "160000")
    return {
      mode: ref.mode,
      digest: ref.oid,
      note: `Submodule revision ${ref.oid}; nested content is not included.`,
    };
  const size = Number((await gitText(cwd, ["cat-file", "-s", ref.oid])).trim());
  if (size > MAX_CONTENT_BYTES)
    return {
      mode: ref.mode,
      digest: ref.oid,
      note: "File exceeds the 8 MiB review content limit.",
    };
  const result = await git(cwd, ["cat-file", "blob", ref.oid], MAX_CONTENT_BYTES);
  if (result.code !== 0 || result.truncated) throw new Error("Git blob is unavailable.");
  return { mode: ref.mode, digest: ref.oid, bytes: result.stdout };
}

interface Patch {
  readonly patch: string;
  readonly coverage: ReviewCoverage;
}

async function readPatch(
  path: string,
  beforePath: string,
  before: WorkingFile,
  after: WorkingFile,
): Promise<Patch> {
  if (before.note || after.note)
    return {
      patch: "",
      coverage: partial(
        ...[before.note, after.note].filter((note): note is string => Boolean(note)),
      ),
    };
  if (before.mode === "missing" && after.mode === "missing")
    return { patch: "", coverage: COMPLETE };
  const scratch = await mkdtemp(join(tmpdir(), "pi-gui-review-"));
  try {
    const materialize = async (side: string, name: string, file: WorkingFile) => {
      if (file.mode === "missing") return devNull;
      const relative = `${side}/${name}`;
      const target = safePath(scratch, relative);
      await mkdir(dirname(target), { recursive: true });
      if (file.mode === "120000") await symlink(file.bytes!.toString("utf8"), target);
      else {
        await writeFile(target, file.bytes!);
        await chmod(target, file.mode === "100755" ? 0o755 : 0o644);
      }
      return relative;
    };
    const left = await materialize("a", beforePath, before);
    const right = await materialize("b", path, after);
    const result = await git(
      scratch,
      ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-prefix", "--", left, right],
      MAX_PATCH_BYTES,
    );
    const patch = result.stdout.toString("utf8");
    const notes: string[] = [];
    if (result.truncated) notes.push("Patch is truncated at the 1 MiB review limit.");
    if (
      patch.includes("Binary files ") ||
      before.bytes?.subarray(0, 8000).includes(0) ||
      after.bytes?.subarray(0, 8000).includes(0)
    )
      notes.push("Binary file contents are not rendered; the patch reports whether they differ.");
    return { patch, coverage: notes.length ? partial(...notes) : COMPLETE };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function readGitReviewFile(
  snapshot: GitReviewSnapshot,
  fileId: string,
): Promise<GitReviewFileContent | ReviewIssue> {
  const file = snapshot.files.find((entry) => entry.id === fileId);
  if (!file)
    return issue("unavailable", "missing-file", "This file does not belong to the review.");
  const stale = await checkGitReviewFileCurrent(snapshot, fileId);
  if (stale) return stale;
  try {
    const { scope, checkoutPath } = snapshot;
    const readIndex = () =>
      readBlob(
        checkoutPath,
        file.source.index.find((blob) => blob.stage === 0),
      );
    const readWorking = async () =>
      file.source.working?.note ? file.source.working : readWorkingFile(checkoutPath, file.path);
    // A conflict has no single index side, so every working scope shows HEAD → working tree.
    const side = file.conflicted && isWorkingReviewScope(scope) ? "uncommitted" : scope.kind;
    const before =
      side === "unstaged" ? await readIndex() : await readBlob(checkoutPath, file.source.base);
    const after =
      side === "staged"
        ? await readIndex()
        : side === "uncommitted" || side === "unstaged"
          ? await readWorking()
          : await readBlob(checkoutPath, file.source.head);
    const beforePath = side === "unstaged" ? file.path : (file.previousPath ?? file.path);
    const { patch, coverage } = await readPatch(file.path, beforePath, before, after);
    let summary: string | undefined;
    if (file.conflicted) {
      summary = `Unmerged index stages: ${file.source.index.map((blob) => `${blob.stage === 1 ? "base" : blob.stage === 2 ? "ours" : "theirs"} ${blob.oid}`).join("; ")}. Resolve the conflict before staging through review.`;
    } else if (
      scope.kind === "uncommitted" &&
      patch === "" &&
      file.hasStagedChanges &&
      file.hasUnstagedChanges
    ) {
      summary =
        "The combined contents match HEAD; staged and unstaged changes cancel each other. Choose Staged or Unstaged to see each part.";
    }
    const current = await checkGitReviewFileCurrent(snapshot, fileId);
    if (current) return current;
    return {
      state: "available",
      patch,
      coverage: combineCoverage([
        coverage,
        file.conflicted
          ? partial("Unmerged index stages are summarized; no staged or unstaged patch is claimed.")
          : COMPLETE,
      ]),
      ...(summary ? { summary } : {}),
    };
  } catch (error) {
    return issue(
      "failed",
      "file-review-failed",
      error instanceof Error ? error.message : "The patch could not be read.",
    );
  }
}

export async function changeGitReviewFileStage(
  snapshot: GitReviewSnapshot,
  fileId: string,
  action: "stage" | "unstage",
): Promise<ChangeReviewFileStageResult> {
  if (!isWorkingReviewScope(snapshot.scope))
    return issue(
      "unavailable",
      "immutable-comparison",
      "Only Uncommitted, Staged and Unstaged review can change the index.",
    );
  const file = snapshot.files.find((entry) => entry.id === fileId);
  if (!file)
    return issue("unavailable", "missing-file", "This file does not belong to the review.");
  if (file.conflicted || file.source.working?.note)
    return issue(
      "unavailable",
      "unsupported-staging",
      "Resolve this file's conflict or incomplete coverage before staging it through review.",
    );
  const stale = await checkGitReviewFileCurrent(snapshot, fileId);
  if (stale) return stale;
  // A staged rename has already removed its previous path from the index and
  // working tree, so `git add` must name only the current path. Unstaging
  // restores both halves of the pair.
  const paths = [...new Set([file.path, ...(file.previousPath ? [file.previousPath] : [])])];
  try {
    await gitText(
      snapshot.checkoutPath,
      action === "stage"
        ? ["add", "--", file.path]
        : snapshot.headOid
          ? ["reset", "--quiet", snapshot.headOid, "--", ...paths]
          : ["rm", "--cached", "--ignore-unmatch", "--force", "--", ...paths],
    );
    return { state: "applied" };
  } catch (error) {
    return issue(
      "failed",
      "stage-failed",
      error instanceof Error ? error.message : "The index could not be changed.",
    );
  }
}
