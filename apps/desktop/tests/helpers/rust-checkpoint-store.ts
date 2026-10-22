import { join } from "node:path";
import type { SessionRef, TurnCaptureBoundary } from "@pi-gui/session-driver";
import { startCore, type CoreProcess } from "../../core-process/launch";
import type { CoreInitializeParams } from "../../core-process/protocol";
import { TurnCheckpointClient } from "../../electron/workbench/checkpoint-client";

type CheckpointOptions = NonNullable<CoreInitializeParams["turnCheckpoints"]>;

const binaryPath = join(
  __dirname,
  "..",
  "..",
  "build",
  "native",
  process.platform === "win32" ? "pi-gui-core.exe" : "pi-gui-core",
);

const started = new Set<CoreProcess>();

/** Stops every core the stores below started. */
export async function stopCheckpointCores(): Promise<void> {
  const cores = [...started];
  started.clear();
  await Promise.all(cores.map((core) => core.stop(1_000)));
}

/**
 * The removed TypeScript `TurnCheckpointStore`'s constructor and methods, each instance backed
 * by its own Rust core process. Two instances share only the files in `userDataDir`, as two
 * stores did. Needs `pnpm --filter @pi-gui/desktop run build:core` first.
 */
export class TurnCheckpointStore {
  readonly repositoryPath: string;
  private readonly client: Promise<TurnCheckpointClient>;

  constructor(
    userDataDir: string,
    limits: CheckpointOptions["limits"] = {},
    retention: CheckpointOptions["retention"] = {},
  ) {
    this.repositoryPath = join(userDataDir, "turn-checkpoints", "objects.git");
    this.client = startCore({
      binaryPath,
      initialize: { userDataDir, turnCheckpoints: { limits, retention } },
      onUnexpectedExit: (detail) => console.error(`pi-gui-core exited: ${detail}`),
    }).then((core) => {
      started.add(core);
      return new TurnCheckpointClient(core.peer);
    });
    // A store a test never calls must not report its start failure as unhandled.
    this.client.catch(() => undefined);
  }

  async recordBoundary(boundary: TurnCaptureBoundary, signal: AbortSignal): Promise<void> {
    return (await this.client).recordBoundary(boundary, signal);
  }

  async list(target: SessionRef) {
    return (await this.client).list(target);
  }

  async listTurns(target: SessionRef) {
    return (await this.client).listTurns(target);
  }

  async resolve(input: { target: SessionRef; checkoutId: string; checkpointId?: string }) {
    return (await this.client).resolve(input);
  }

  async capture(workspacePath: string, signal?: AbortSignal) {
    return (await this.client).capture(workspacePath, signal);
  }

  async maintain(): Promise<void> {
    return (await this.client).maintain();
  }
}
