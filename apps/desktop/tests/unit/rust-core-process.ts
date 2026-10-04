import { join } from "node:path";
import { test } from "@playwright/test";
import { startCore, type CoreProcess } from "../../core-process/launch";
import type { RpcPeer } from "../../rpc/rpc-peer";

/**
 * Starts the built `pi-gui-core` binary for a unit test, with `userDataDir` as its profile
 * folder; a spec that calls `stopTestCoresAfterEach()` stops it after each test. Needs `pnpm --filter @pi-gui/desktop run build:core`
 * first (part of `pnpm build` and `pnpm test:core`).
 */
export const coreBinaryPath = join(
  __dirname,
  "..",
  "..",
  "build",
  "native",
  process.platform === "win32" ? "pi-gui-core.exe" : "pi-gui-core",
);

const running = new Set<CoreProcess>();

/** Registers the cleanup in the calling spec file. */
export function stopTestCoresAfterEach(): void {
  test.afterEach(async () => {
    await Promise.all([...running].map((core) => core.stop(1_000)));
    running.clear();
  });
}

export async function startTestCore(userDataDir: string): Promise<RpcPeer> {
  const core = await startCore({
    binaryPath: coreBinaryPath,
    initialize: { userDataDir },
    onUnexpectedExit: (detail) => {
      throw new Error(`pi-gui-core exited: ${detail}`);
    },
  });
  running.add(core);
  return core.peer;
}
