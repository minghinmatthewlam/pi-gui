/**
 * Methods of the Rust `pi-gui-core` process (`crates/pi-gui-core`). Kept in step with
 * `methods` in its `lib.rs`; a unit test checks the two lists match.
 */
export const coreMethods = {
  initialize: "core.initialize",
  shutdown: "core.shutdown",
  /** Catalog storage calls, in the same `{ path, args, undefinedAt }` shape the pi host uses. */
  catalogCall: "catalog.call",
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
}
