import type { ScheduledTaskRecord } from "../../contracts/scheduled-tasks";
import { coreMethods } from "../../core-process/protocol";
import type { RpcPeer } from "../../rpc/rpc-peer";

/**
 * `scheduled-tasks.json` in the profile folder, read and checked by the Rust core
 * (`crates/pi-gui-core/src/persistence/scheduled_tasks.rs`). `recovered` is true when the
 * tasks came from the `.bak` copy because the file was damaged.
 */
export async function readScheduledTasksFile(core: RpcPeer): Promise<{
  readonly tasks: readonly ScheduledTaskRecord[];
  readonly recovered: boolean;
}> {
  return (await core.request(coreMethods.scheduledTasksRead)) as {
    readonly tasks: readonly ScheduledTaskRecord[];
    readonly recovered: boolean;
  };
}

export async function writeScheduledTasksFile(
  core: RpcPeer,
  tasks: readonly ScheduledTaskRecord[],
): Promise<void> {
  await core.request(coreMethods.scheduledTasksWrite, { tasks });
}
