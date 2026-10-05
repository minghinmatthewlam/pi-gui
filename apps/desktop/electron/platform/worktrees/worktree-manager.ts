import type { WorktreeCatalogEntry, WorktreeCatalogSnapshot } from "@pi-gui/catalogs";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import { coreMethods } from "../../../core-process/protocol";
import type { RpcPeer } from "../../../rpc/rpc-peer";

/**
 * Worktrees pi-gui creates for threads, run by the Rust core (`crates/pi-gui-core/src/git/
 * worktrees.rs`): transactional create with rollback, removal with branch cleanup, the
 * startup prune, and the rule that a user's own checkout is never listed or removed. The
 * core updates the catalog rows itself.
 */
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
  constructor(private readonly core: RpcPeer) {}

  async listWorktrees(workspace: WorkspaceRef): Promise<WorktreeCatalogSnapshot> {
    return this.call(coreMethods.worktreesList, { workspace: workspaceRef(workspace) });
  }

  /**
   * Rebuild one folder's worktree rows. `claimPath` hands a worktree the folder just created
   * to that folder, whoever listed it first.
   */
  async refreshWorktrees(
    workspace: WorkspaceRef,
    options: { readonly claimPath?: string } = {},
  ): Promise<WorktreeCatalogSnapshot> {
    return this.call(coreMethods.worktreesRefresh, {
      workspace: workspaceRef(workspace),
      ...options,
    });
  }

  async inspectWorkspace(workspace: WorkspaceRef): Promise<GitWorkspaceInspection> {
    return this.call(coreMethods.worktreesInspect, { workspace: workspaceRef(workspace) });
  }

  async createWorktree(
    workspace: WorkspaceRef,
    input: CreateWorktreeOptions,
  ): Promise<WorktreeCatalogEntry> {
    return this.call(coreMethods.worktreesCreate, { workspace: workspaceRef(workspace), ...input });
  }

  async removeWorktree(
    workspace: WorkspaceRef,
    worktreeId: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<void> {
    await this.call(coreMethods.worktreesRemove, {
      workspace: workspaceRef(workspace),
      worktreeId,
      force: options.force ?? false,
    });
  }

  /** Roll back a worktree this app just created. Best-effort: never throws for Git failures. */
  async destroyWorktree(
    workspace: WorkspaceRef,
    input: DestroyCreatedWorktreeInput,
  ): Promise<void> {
    await this.call(coreMethods.worktreesDestroy, { workspace: workspaceRef(workspace), ...input });
  }

  /** Startup reconcile pass; dirty, unmerged or unknown worktrees are skipped, never forced. */
  async pruneOrphanedWorktrees(
    input: PruneOrphanedWorktreesInput,
  ): Promise<PruneOrphanedWorktreesResult> {
    return this.call(coreMethods.worktreesPrune, {
      worktreeRoot: input.worktreeRoot,
      referencedPaths: [...input.referencedPaths],
    });
  }

  /** True for paths under the profile's or the legacy `~/.pi` worktree folder. */
  async isAppWorktreePath(path: string): Promise<boolean> {
    return this.call(coreMethods.worktreesIsAppPath, { path });
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    return (await this.core.request(method, params)) as T;
  }
}

/** Only the fields the core reads; callers pass catalog rows with more. */
function workspaceRef(workspace: WorkspaceRef): WorkspaceRef {
  return {
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    ...(workspace.displayName === undefined ? {} : { displayName: workspace.displayName }),
  };
}
