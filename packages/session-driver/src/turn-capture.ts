import type { SessionRef, WorkspaceRef } from "./types.js";

export interface TurnCaptureOpening {
  readonly checkpointId: string;
  readonly beforeEntryId: string | null;
  readonly startedAt: string;
}

export interface TurnCaptureClosing extends TurnCaptureOpening {
  readonly userEntryIds: readonly string[];
  readonly assistantEntryIds: readonly string[];
  readonly lastEntryId: string | null;
  readonly outcome: "completed" | "stopped" | "failed" | "interrupted";
  readonly reason: "next-input" | "settled" | "runtime-replaced";
  /** A missing/failed baseline must never become an apparently complete comparison. */
  readonly captureError?: string;
}

/** One awaited boundary can close an interval and open the next using the same snapshot. */
export interface TurnCaptureBoundary {
  readonly sessionRef: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly runtimeGeneration: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly opening?: TurnCaptureOpening;
  readonly closing?: TurnCaptureClosing;
}

/**
 * The app owns storage and coverage. This callback runs before the agent proceeds;
 * it must honor cancellation, especially before committing a usable capture.
 * No Git, desktop view, or file-content types belong in the driver contract.
 */
export type TurnCaptureObserver = (
  boundary: TurnCaptureBoundary,
  signal: AbortSignal,
) => Promise<void>;
