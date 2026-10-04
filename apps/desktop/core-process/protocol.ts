/**
 * Methods of the Rust `pi-gui-core` process (`crates/pi-gui-core`). Kept in step with
 * `methods` in its `lib.rs`; a unit test checks the two lists match.
 */
export const coreMethods = {
  initialize: "core.initialize",
  shutdown: "core.shutdown",
  /** Catalog storage calls, in the same `{ path, args, undefinedAt }` shape the pi host uses. */
  catalogCall: "catalog.call",
  /** Turn checkpoints (`crates/pi-gui-core/src/checkpoints`); see `TurnCheckpointClient`. */
  checkpointsRecordBoundary: "checkpoints.recordBoundary",
  checkpointsList: "checkpoints.list",
  checkpointsListTurns: "checkpoints.listTurns",
  checkpointsResolve: "checkpoints.resolve",
  checkpointsCapture: "checkpoints.capture",
  checkpointsMaintain: "checkpoints.maintain",
  /** Integrated terminal calls; see `electron/platform/terminal-service.ts`. */
  terminalEnsurePanel: "terminal.ensurePanel",
  terminalCreateSession: "terminal.createSession",
  terminalSetActiveSession: "terminal.setActiveSession",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",
  terminalSetTitle: "terminal.setTitle",
  terminalRetainWorkspacePaths: "terminal.retainWorkspacePaths",
  terminalDisposeOwner: "terminal.disposeOwner",
  terminalDisposeAll: "terminal.disposeAll",
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

/**
 * Notifications the core sends the app. Terminal ones name the window they are for by its
 * `webContents.id` (`ownerId`).
 */
export const coreNotifications = {
  terminalData: "terminal.data",
  terminalExit: "terminal.exit",
  terminalError: "terminal.error",
} as const;

export interface CoreInitializeParams {
  /** The app's profile folder. Saved files keep their names and formats inside it. */
  readonly userDataDir: string;
  /** Turn capture limits and retention. Only tests set these; the app uses the defaults. */
  readonly turnCheckpoints?: {
    readonly limits?: Partial<{
      readonly timeoutMs: number;
      readonly maxFiles: number;
      readonly maxBytes: number;
      readonly maxFileBytes: number;
    }>;
    readonly retention?: Partial<{
      /** Finalized intervals kept per task; open intervals are never dropped. */
      readonly maxRecordsPerTask: number;
      /** Finalized intervals kept across all tasks. */
      readonly maxRecords: number;
      /** Unreferenced refs and objects younger than this survive maintenance. */
      readonly pruneGraceMs: number;
      /** Minimum spacing between background maintenance passes. */
      readonly maintenanceIntervalMs: number;
    }>;
  };
}
