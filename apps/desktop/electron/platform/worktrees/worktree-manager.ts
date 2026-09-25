import { execFile } from "node:child_process";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CatalogStorage,
  WorktreeCatalogEntry,
  WorktreeCatalogSnapshot,
} from "@pi-gui/catalogs";
import type { WorkspaceRef } from "@pi-gui/session-driver";

const execFileAsync = promisify(execFile);

export interface GitWorktreeManagerOptions {
  readonly catalogStorage: CatalogStorage;
  /**
   * Which linked worktrees the app created and may list or remove. Others are
   * the user's own checkouts and are left out of every folder's worktree list.
   * Defaults to every linked worktree.
   */
  readonly isAppWorktreePath?: (path: string) => Promise<boolean>;
}

export interface CreateWorktreeOptions {
  readonly path: string;
  readonly branchName?: string;
  readonly startPoint?: string;
  readonly displayName?: string;
}

interface RemoveWorktreeOptions {
  readonly force?: boolean;
}

export interface DestroyCreatedWorktreeInput {
  readonly path: string;
  readonly branchName?: string;
}

export interface PruneOrphanedWorktreesInput {
  /** Absolute, profile-owned root under which the app creates its worktrees. */
  readonly worktreeRoot: string;
  /** Canonicalized worktree/workspace paths that must never be pruned. */
  readonly referencedPaths: ReadonlySet<string>;
}

export interface PruneOrphanedWorktreesResult {
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
}

export interface GitWorkspaceInspection {
  readonly canonicalPath: string;
  readonly commonDir: string;
}

export class GitWorktreeManager {
  constructor(private readonly options: GitWorktreeManagerOptions) {}

  async listWorktrees(workspace: WorkspaceRef): Promise<WorktreeCatalogSnapshot> {
    return this.options.catalogStorage.worktrees.listWorktrees(workspace.workspaceId);
  }

  async refreshWorktrees(workspace: WorkspaceRef): Promise<WorktreeCatalogSnapshot> {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    const existing = await this.options.catalogStorage.worktrees.listWorktrees(
      workspace.workspaceId,
    );
    const discovered = await this.ownLinkedWorktrees(
      workspace,
      await listGitWorktrees(repoRoot, workspace, existing.worktrees),
    );
    await this.options.catalogStorage.worktrees.replaceWorkspaceWorktrees(
      workspace.workspaceId,
      discovered,
    );
    return { worktrees: discovered.map((entry) => ({ ...entry })) };
  }

  /**
   * Keep the workspace's own row and the app worktrees no other folder has
   * claimed, so each app worktree nests under exactly one folder.
   */
  private async ownLinkedWorktrees(
    workspace: WorkspaceRef,
    discovered: readonly WorktreeCatalogEntry[],
  ): Promise<WorktreeCatalogEntry[]> {
    const catalog = await this.options.catalogStorage.worktrees.listWorktrees();
    const claimedElsewhere = new Set(
      catalog.worktrees
        .filter((entry) => entry.kind === "linked" && entry.workspaceId !== workspace.workspaceId)
        .map((entry) => entry.path),
    );
    const isAppWorktreePath = this.options.isAppWorktreePath;
    const owned: WorktreeCatalogEntry[] = [];
    for (const entry of discovered) {
      if (
        entry.kind === "primary" ||
        (!claimedElsewhere.has(entry.path) &&
          (!isAppWorktreePath || (await isAppWorktreePath(entry.path))))
      ) {
        owned.push(entry);
      }
    }
    return owned;
  }

  async inspectWorkspace(workspace: WorkspaceRef): Promise<GitWorkspaceInspection> {
    return inspectGitWorkspace(workspace.path);
  }

  async createWorktree(
    workspace: WorkspaceRef,
    input: CreateWorktreeOptions,
  ): Promise<WorktreeCatalogEntry> {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    const normalizedPath = input.path.trim();
    if (!normalizedPath) {
      throw new Error("Worktree path cannot be empty.");
    }
    const worktreePath = resolve(normalizedPath);

    await mkdir(dirname(worktreePath), { recursive: true });

    const args = ["-C", repoRoot, "worktree", "add"];
    if (input.branchName) {
      args.push("-b", input.branchName);
    }
    args.push(worktreePath, input.startPoint?.trim() || "HEAD");
    await runGit(args);

    const canonicalWorktreePath = await canonicalPath(worktreePath);
    const snapshot = await this.refreshWorktrees(workspace);
    const created = snapshot.worktrees.find((entry) => entry.worktreeId === canonicalWorktreePath);
    if (!created) {
      throw new Error(
        `Worktree ${canonicalWorktreePath} was created but is missing from the catalog.`,
      );
    }
    if (input.displayName?.trim()) {
      const next = { ...created, displayName: input.displayName.trim() };
      await this.options.catalogStorage.worktrees.upsertWorktree(next);
      return next;
    }
    return created;
  }

  async removeWorktree(
    workspace: WorkspaceRef,
    worktreeId: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<void> {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    const resolvedId = await canonicalPath(worktreeId);
    const existing = await this.options.catalogStorage.worktrees.getWorktree(resolvedId);
    const targetPath = await canonicalPath(existing?.path ? existing.path : resolvedId);
    if (
      existing?.kind === "primary" ||
      (!existing && targetPath === (await canonicalPath(workspace.path)))
    ) {
      throw new Error("The primary workspace cannot be removed as a git worktree.");
    }
    if (this.options.isAppWorktreePath && !(await this.options.isAppWorktreePath(targetPath))) {
      throw new Error("Only worktrees created by pi-gui can be removed here.");
    }

    try {
      await runGit([
        "-C",
        repoRoot,
        "worktree",
        "remove",
        ...(options.force ? ["--force"] : []),
        targetPath,
      ]);
    } catch (error) {
      const refreshed = await this.refreshWorktrees(workspace);
      if (!refreshed.worktrees.some((entry) => entry.worktreeId === targetPath)) {
        await deleteAppWorktreeBranch(repoRoot, existing?.branchName);
        return;
      }
      throw error;
    }

    await this.refreshWorktrees(workspace);
    await deleteAppWorktreeBranch(repoRoot, existing?.branchName);
  }

  /**
   * Roll back a worktree that this app just created (fix: transactional thread
   * creation). Force-removes the worktree and deletes its branch — both are
   * brand-new artifacts owned by the failed call, so nothing pre-existing is
   * touched. Best-effort: never throws.
   */
  async destroyWorktree(
    workspace: WorkspaceRef,
    input: DestroyCreatedWorktreeInput,
  ): Promise<void> {
    let repoRoot: string;
    try {
      repoRoot = await resolveRepositoryRoot(workspace.path);
    } catch {
      return;
    }
    const targetPath = await canonicalPath(input.path);
    try {
      await runGit(["-C", repoRoot, "worktree", "remove", "--force", targetPath]);
    } catch {
      // The worktree may not have been fully materialized; fall through to prune + branch cleanup.
    }
    if (input.branchName) {
      try {
        await runGit(["-C", repoRoot, "branch", "-D", input.branchName]);
      } catch {
        // Branch may never have been created; ignore.
      }
    }
    await this.refreshWorktrees(workspace).catch(() => undefined);
  }

  /**
   * Startup reconcile pass: remove git worktrees under the app's worktree root
   * that no longer have a catalog/session reference. Only merged `pi/*` branches
   * are eligible. Never force-removes a dirty worktree (a non-`--force`
   * `git worktree remove` refuses when the tree is modified), so user work is
   * never destroyed — protected worktrees are skipped and reported instead.
   */
  async pruneOrphanedWorktrees(
    input: PruneOrphanedWorktreesInput,
  ): Promise<PruneOrphanedWorktreesResult> {
    const worktreeRoot = await canonicalPath(input.worktreeRoot);
    const removed: string[] = [];
    const skipped: string[] = [];

    const candidates = await listAppWorktreeCandidates(worktreeRoot);
    for (const candidatePath of candidates) {
      if (input.referencedPaths.has(candidatePath)) {
        continue;
      }
      let repoRoot: string;
      let branchName: string | undefined;
      try {
        const info = await inspectLinkedWorktree(candidatePath);
        if (!info) {
          skipped.push(candidatePath);
          continue;
        }
        repoRoot = info.repoRoot;
        branchName = info.branchName;
      } catch {
        skipped.push(candidatePath);
        continue;
      }

      if (!branchName?.startsWith("pi/") || !(await isBranchMergedIntoHead(repoRoot, branchName))) {
        skipped.push(candidatePath);
        continue;
      }

      try {
        // No `--force`: git refuses to remove a dirty worktree, protecting user work.
        await runGit(["-C", repoRoot, "worktree", "remove", candidatePath]);
        removed.push(candidatePath);
        await deleteAppWorktreeBranch(repoRoot, branchName);
      } catch (error) {
        skipped.push(candidatePath);
        console.warn(`pi-gui: kept orphaned worktree ${candidatePath}: ${errorMessage(error)}`);
      }
    }

    return { removed, skipped };
  }
}

/**
 * Delete an app-created worktree branch after its worktree was removed. Only
 * touches `pi/*` branches, and uses the safe `git branch -d` (refuses to delete
 * unmerged work) so a leaked branch is preferred over lost commits.
 */
async function deleteAppWorktreeBranch(
  repoRoot: string,
  branchName: string | undefined,
): Promise<void> {
  if (!branchName || !branchName.startsWith("pi/")) {
    return;
  }
  try {
    await runGit(["-C", repoRoot, "branch", "-d", branchName]);
  } catch (error) {
    console.warn(
      `pi-gui: kept branch ${branchName} after worktree removal: ${errorMessage(error)}`,
    );
  }
}

async function isBranchMergedIntoHead(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    await runGit([
      "-C",
      repoRoot,
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branchName}`,
      "HEAD",
    ]);
    return true;
  } catch {
    return false;
  }
}

async function listAppWorktreeCandidates(worktreeRoot: string): Promise<readonly string[]> {
  // Layout: <worktreeRoot>/<repoName>/<folder>
  let repoDirs: string[];
  try {
    repoDirs = (await readdir(worktreeRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const repoDir of repoDirs) {
    let folders: string[];
    try {
      folders = (await readdir(join(worktreeRoot, repoDir), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const folder of folders) {
      candidates.push(await canonicalPath(join(worktreeRoot, repoDir, folder)));
    }
  }
  return candidates;
}

async function inspectLinkedWorktree(
  worktreePath: string,
): Promise<{ readonly repoRoot: string; readonly branchName?: string } | undefined> {
  const output = await runGit(["-C", worktreePath, "worktree", "list", "--porcelain"]);
  const blocks = output.split(/\n\s*\n/).filter((block) => block.trim());
  let repoRoot: string | undefined;
  let branchName: string | undefined;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim());
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine) {
      continue;
    }
    const entryPath = await canonicalPath(worktreeLine.slice("worktree ".length).trim());
    if (repoRoot === undefined) {
      repoRoot = entryPath; // first entry is the main worktree
    }
    if (entryPath === worktreePath) {
      const branchLine = lines.find((line) => line.startsWith("branch "));
      if (branchLine) {
        branchName = normalizeBranchName(branchLine.slice("branch ".length).trim());
      }
    }
  }
  if (!repoRoot || repoRoot === worktreePath) {
    return undefined; // not a linked worktree
  }
  return { repoRoot, ...(branchName ? { branchName } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveRepositoryRoot(workspacePath: string): Promise<string> {
  const output = await runGit(["-C", workspacePath, "rev-parse", "--show-toplevel"]);
  return canonicalPath(output.trim());
}

async function inspectGitWorkspace(workspacePath: string): Promise<GitWorkspaceInspection> {
  const canonicalPathValue = await canonicalPath(workspacePath);
  const commonDirPath = (
    await runGit(["-C", workspacePath, "rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();

  return {
    canonicalPath: canonicalPathValue,
    commonDir: await canonicalPath(commonDirPath),
  };
}

async function listGitWorktrees(
  repoRoot: string,
  workspace: WorkspaceRef,
  existingEntries: readonly WorktreeCatalogEntry[],
): Promise<WorktreeCatalogEntry[]> {
  const output = await runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const existing = new Map(existingEntries.map((entry) => [entry.worktreeId, entry]));
  const discovered = new Map<string, WorktreeCatalogEntry>();

  for (const block of output.split(/\n\s*\n/)) {
    const entry = await parseWorktreeBlock(block, workspace, existing);
    if (entry) {
      discovered.set(entry.worktreeId, mergeWorktreeEntry(entry, existing.get(entry.worktreeId)));
    }
  }

  const workspacePath = await canonicalPath(workspace.path);
  if (!discovered.has(workspacePath)) {
    const primaryPath = workspacePath;
    discovered.set(
      primaryPath,
      mergeWorktreeEntry(
        {
          worktreeId: primaryPath,
          workspaceId: workspace.workspaceId,
          path: primaryPath,
          displayName: workspace.displayName?.trim() || basename(primaryPath) || primaryPath,
          kind: "primary",
          status: "ready",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        existing.get(primaryPath),
      ),
    );
  }

  return [...discovered.values()].sort(compareWorktreeEntries);
}

async function parseWorktreeBlock(
  block: string,
  workspace: WorkspaceRef,
  existing: ReadonlyMap<string, WorktreeCatalogEntry>,
): Promise<WorktreeCatalogEntry | undefined> {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const worktreeLine = lines.find((line) => line.startsWith("worktree "));
  if (!worktreeLine) {
    return undefined;
  }

  const path = await canonicalPath(worktreeLine.slice("worktree ".length).trim());
  const workspacePath = await canonicalPath(workspace.path);
  const kind: WorktreeCatalogEntry["kind"] = path === workspacePath ? "primary" : "linked";
  const headLine = lines.find((line) => line.startsWith("HEAD "));
  const branchLine = lines.find((line) => line.startsWith("branch "));
  const status: WorktreeCatalogEntry["status"] = lines.includes("prunable") ? "missing" : "ready";
  const displayName =
    existing.get(path)?.displayName?.trim() || defaultWorktreeDisplayName(workspace, path, kind);
  const entry: WorktreeCatalogEntry = {
    worktreeId: path,
    workspaceId: workspace.workspaceId,
    path,
    displayName,
    kind,
    status,
    ...(headLine ? { headSha: headLine.slice("HEAD ".length).trim() } : {}),
    ...(branchLine
      ? { branchName: normalizeBranchName(branchLine.slice("branch ".length).trim()) }
      : {}),
    createdAt: existing.get(path)?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    ...(existing.get(path)?.pinned !== undefined ? { pinned: existing.get(path)?.pinned } : {}),
  };

  return entry;
}

function mergeWorktreeEntry(
  nextEntry: WorktreeCatalogEntry,
  existingEntry: WorktreeCatalogEntry | undefined,
): WorktreeCatalogEntry {
  const updatedAt =
    existingEntry && hasSameWorktreeIdentity(existingEntry, nextEntry)
      ? existingEntry.updatedAt
      : nextEntry.updatedAt;
  return {
    ...nextEntry,
    displayName: existingEntry?.displayName?.trim() || nextEntry.displayName,
    createdAt: existingEntry?.createdAt ?? nextEntry.createdAt,
    updatedAt,
    pinned: existingEntry?.pinned ?? nextEntry.pinned,
  };
}

function hasSameWorktreeIdentity(left: WorktreeCatalogEntry, right: WorktreeCatalogEntry): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.path === right.path &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.branchName === right.branchName &&
    left.headSha === right.headSha
  );
}

function compareWorktreeEntries(left: WorktreeCatalogEntry, right: WorktreeCatalogEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "primary" ? -1 : 1;
  }
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  return left.displayName.localeCompare(right.displayName);
}

function defaultWorktreeDisplayName(
  workspace: WorkspaceRef,
  path: string,
  kind: WorktreeCatalogEntry["kind"],
): string {
  if (kind === "primary") {
    return workspace.displayName?.trim() || basename(path) || path;
  }
  return basename(path) || path;
}

function normalizeBranchName(value: string): string | undefined {
  const branch = value.replace(/^refs\/heads\//, "").trim();
  return branch.length > 0 && branch !== "detached" ? branch : undefined;
}

async function runGit(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function canonicalPath(pathValue: string): Promise<string> {
  const resolved = resolve(pathValue);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}
