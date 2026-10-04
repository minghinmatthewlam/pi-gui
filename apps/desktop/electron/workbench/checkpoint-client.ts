import type { SessionRef, TurnCaptureBoundary } from "@pi-gui/session-driver";
import type { ReviewCoverage, ReviewIssue } from "../../contracts/review";
import { coreMethods } from "../../core-process/protocol";
import type { RpcPeer } from "../../rpc/rpc-peer";

export type CheckpointCapture =
  | {
      readonly state: "available";
      readonly treeOid: string;
      readonly capturedAt: string;
      readonly coverage: ReviewCoverage;
      readonly fileCount: number;
      readonly byteCount: number;
      readonly durationMs: number;
    }
  | {
      readonly state: "unavailable";
      readonly code: string;
      readonly message: string;
      readonly capturedAt: string;
      readonly coverage: ReviewCoverage;
      readonly fileCount: number;
      readonly byteCount: number;
      readonly durationMs: number;
    };

export interface StoredTurnCheckpoint {
  readonly checkpointId: string;
  readonly target: SessionRef;
  readonly checkoutId: string;
  readonly checkoutPath: string;
  readonly runtimeGeneration: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly beforeEntryId: string | null;
  readonly userEntryIds: readonly string[];
  readonly assistantEntryIds: readonly string[];
  readonly lastEntryId: string | null;
  readonly outcome: "open" | "completed" | "stopped" | "failed" | "interrupted";
  readonly before: CheckpointCapture;
  readonly after: CheckpointCapture | null;
  readonly overlaps: readonly string[];
}

export interface ResolvedTurnCheckpoint {
  readonly state: "available";
  readonly checkpointId: string;
  readonly checkoutId: string;
  readonly repositoryPath: string;
  readonly beforeTreeOid: string;
  readonly afterTreeOid: string;
  readonly capturedAt: string;
  readonly coverage: ReviewCoverage;
}

export interface ListedTurnCheckpoint extends ResolvedTurnCheckpoint {
  /** Transcript entries of the turn, so a view can place it in the conversation. */
  readonly entryIds: readonly string[];
}

/**
 * Turn checkpoints: snapshots of a checkout at each turn boundary, owned by the Rust core
 * (`crates/pi-gui-core/src/checkpoints`). It keeps `turn-checkpoints/checkpoints.json` and the
 * app's bare `turn-checkpoints/objects.git`, and never touches the user's Git state.
 */
export class TurnCheckpointClient {
  constructor(private readonly peer: RpcPeer) {}

  /**
   * pi awaits this before a tool can run. Aborting `signal` cancels the core's capture; the
   * core still records the boundary (with an aborted capture), and this resolves once it has.
   */
  async recordBoundary(boundary: TurnCaptureBoundary, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      await this.peer.request(coreMethods.checkpointsRecordBoundary, { boundary, aborted: true });
      return;
    }
    try {
      await this.peer.request(coreMethods.checkpointsRecordBoundary, { boundary }, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      // Lookups wait for the task's latest boundary, so this returns once it is recorded.
      await this.list(boundary.sessionRef);
    }
  }

  async list(target: SessionRef): Promise<readonly StoredTurnCheckpoint[]> {
    return (await this.peer.request(coreMethods.checkpointsList, {
      target: taskRef(target),
    })) as StoredTurnCheckpoint[];
  }

  async resolve(input: {
    target: SessionRef;
    checkoutId: string;
    checkpointId?: string;
  }): Promise<ResolvedTurnCheckpoint | ReviewIssue> {
    return (await this.peer.request(coreMethods.checkpointsResolve, {
      target: taskRef(input.target),
      checkoutId: input.checkoutId,
      ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
    })) as ResolvedTurnCheckpoint | ReviewIssue;
  }

  /** Every finished turn of a task whose before and after captures are both usable. */
  async listTurns(target: SessionRef): Promise<readonly ListedTurnCheckpoint[]> {
    return (await this.peer.request(coreMethods.checkpointsListTurns, {
      target: taskRef(target),
    })) as ListedTurnCheckpoint[];
  }

  /** Captures a checkout now. An already aborted `signal` reports an aborted capture. */
  async capture(workspacePath: string, signal?: AbortSignal): Promise<CheckpointCapture> {
    return (await this.peer.request(
      coreMethods.checkpointsCapture,
      { workspacePath, ...(signal?.aborted ? { aborted: true } : {}) },
      signal?.aborted ? undefined : signal,
    )) as CheckpointCapture;
  }

  /** Deletes snapshot refs no retained interval needs and lets Git prune their objects. */
  async maintain(): Promise<void> {
    await this.peer.request(coreMethods.checkpointsMaintain);
  }
}

function taskRef(target: SessionRef): SessionRef {
  return { workspaceId: target.workspaceId, sessionId: target.sessionId };
}
