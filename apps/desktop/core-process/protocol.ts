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
