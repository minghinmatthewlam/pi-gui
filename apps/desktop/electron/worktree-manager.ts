import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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
    const existing = await this.options.catalogStorage.worktrees.listWorktrees(workspace.workspaceId);
    const discovered = await listGitWorktrees(repoRoot, workspace, existing.worktrees);
    await this.options.catalogStorage.worktrees.replaceWorkspaceWorktrees(workspace.workspaceId, discovered);
    return { worktrees: discovered.map((entry) => ({ ...entry })) };
  }

  async inspectWorkspace(workspace: WorkspaceRef): Promise<GitWorkspaceInspection> {
    return inspectGitWorkspace(workspace.path);
  }

  async createWorktree(workspace: WorkspaceRef, input: CreateWorktreeOptions): Promise<WorktreeCatalogEntry> {
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
      throw new Error(`Worktree ${canonicalWorktreePath} was created but is missing from the catalog.`);
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
    if (existing?.kind === "primary" || (!existing && targetPath === await canonicalPath(workspace.path))) {
      throw new Error("The primary workspace cannot be removed as a git worktree.");
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
        return;
      }
      throw error;
    }

    await this.refreshWorktrees(workspace);
  }
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
  const displayName = existing.get(path)?.displayName?.trim() || defaultWorktreeDisplayName(workspace, path, kind);
  const entry: WorktreeCatalogEntry = {
    worktreeId: path,
    workspaceId: workspace.workspaceId,
    path,
    displayName,
    kind,
    status,
    ...(headLine ? { headSha: headLine.slice("HEAD ".length).trim() } : {}),
    ...(branchLine ? { branchName: normalizeBranchName(branchLine.slice("branch ".length).trim()) } : {}),
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
    existingEntry && hasSameWorktreeIdentity(existingEntry, nextEntry) ? existingEntry.updatedAt : nextEntry.updatedAt;
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

function defaultWorktreeDisplayName(workspace: WorkspaceRef, path: string, kind: WorktreeCatalogEntry["kind"]): string {
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
    windowsHide: true,
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
