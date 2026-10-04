/**
 * Methods of the Rust `pi-gui-core` process (`crates/pi-gui-core`). Kept in step with
 * `methods` in its `lib.rs`; a unit test checks the two lists match.
 */
export const coreMethods = {
  initialize: "core.initialize",
  shutdown: "core.shutdown",
  /** Catalog storage calls, in the same `{ path, args, undefinedAt }` shape the pi host uses. */
  catalogCall: "catalog.call",
} as const;

export interface CoreInitializeParams {
  /** The app's profile folder. Saved files keep their names and formats inside it. */
  readonly userDataDir: string;
}
