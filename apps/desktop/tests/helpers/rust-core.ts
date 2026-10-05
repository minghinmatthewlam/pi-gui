import { join } from "node:path";
import { test } from "@playwright/test";
import { startCore, type CoreProcess } from "../../core-process/launch";
import type { RpcPeer } from "../../rpc/rpc-peer";

/**
 * Starts the built Rust core (`pnpm --filter @pi-gui/desktop run build:core`) for unit specs.
 * `env` is added to the core's environment only; the test process keeps its own.
 */
export const coreBinaryPath = join(
  __dirname,
  "..",
  "..",
  "build",
  "native",
  process.platform === "win32" ? "pi-gui-core.exe" : "pi-gui-core",
);

export async function startTestCore(
  userDataDir: string,
  env: Record<string, string> = {},
): Promise<CoreProcess> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  // The child copies the environment when it is spawned, before the first await.
  const started = startCore({
    binaryPath: coreBinaryPath,
    initialize: { userDataDir },
    onUnexpectedExit: (detail) => {
      throw new Error(`pi-gui-core exited: ${detail}`);
    },
  });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return started;
}

/** Starts a test core that `stopTestCoresAfterEach()` stops, and returns its pipe. */
export async function startTestCorePeer(userDataDir: string): Promise<RpcPeer> {
  const core = await startTestCore(userDataDir);
  running.add(core);
  return core.peer;
}

const running = new Set<CoreProcess>();

/** Registers the cleanup in the calling spec file. */
export function stopTestCoresAfterEach(): void {
  test.afterEach(async () => {
    await Promise.all([...running].map((core) => core.stop(1_000)));
    running.clear();
  });
}
