/**
 * Methods of the Rust `pi-gui-core` process (`crates/pi-gui-core`). Kept in step with
 * `methods` in its `lib.rs`; a unit test checks the two lists match.
 */
export const coreMethods = {
  initialize: "core.initialize",
  shutdown: "core.shutdown",
  /** Catalog storage calls, in the same `{ path, args, undefinedAt }` shape the pi host uses. */
  catalogCall: "catalog.call",
  /** App worktrees and their catalog rows (`worktree-manager.ts`). */
  worktreesList: "worktrees.list",
  worktreesRefresh: "worktrees.refresh",
  worktreesInspect: "worktrees.inspect",
  worktreesCreate: "worktrees.create",
  worktreesRemove: "worktrees.remove",
  worktreesDestroy: "worktrees.destroy",
  worktreesPrune: "worktrees.prune",
  worktreesIsAppPath: "worktrees.isAppPath",
  /** Review comparisons and staging (`git-review.ts`). */
  reviewCreate: "review.create",
  reviewCheckFile: "review.checkFile",
  reviewReadFile: "review.readFile",
  reviewChangeStage: "review.changeStage",
  reviewTreeChanges: "review.treeChanges",
  /** A folder's files, previews, changed files, diffs and staging (`workspace-files.ts`). */
  workspaceFilesList: "workspaceFiles.list",
  workspaceFilesRead: "workspaceFiles.read",
  workspaceFilesChanged: "workspaceFiles.changed",
  workspaceFilesDiff: "workspaceFiles.diff",
  workspaceFilesStage: "workspaceFiles.stage",
} as const;

export interface CoreInitializeParams {
  /** The app's profile folder. Saved files keep their names and formats inside it. */
  readonly userDataDir: string;
}
