/**
 * Methods of the Rust `pi-gui-core` process (`crates/pi-gui-core`). Kept in step with
 * `methods` in its `lib.rs`; a unit test checks the two lists match.
 */
export const coreMethods = {
  initialize: "core.initialize",
  shutdown: "core.shutdown",
  /** Catalog storage calls, in the same `{ path, args, undefinedAt }` shape the pi host uses. */
  catalogCall: "catalog.call",
  /** `ui-state.json`: the decoded saved state, or `{}` before the first save. */
  uiStateRead: "uiState.read",
  /** Saves `{ state }` as version 19. */
  uiStateWrite: "uiState.write",
  /** A thread's saved composer attachments by `{ sessionKey }`, or `null`. */
  attachmentsRead: "attachments.read",
  attachmentsWrite: "attachments.write",
  attachmentsListKeys: "attachments.listKeys",
  attachmentsRemove: "attachments.remove",
  /** `scheduled-tasks.json` as `{ tasks, recovered }`. */
  scheduledTasksRead: "scheduledTasks.read",
  scheduledTasksWrite: "scheduledTasks.write",
  /** The review marks in `reviewed-files.json`, oldest first. */
  reviewedSnapshot: "reviewed.snapshot",
  reviewedSet: "reviewed.set",
} as const;

export interface CoreInitializeParams {
  /** The app's profile folder. Saved files keep their names and formats inside it. */
  readonly userDataDir: string;
}
