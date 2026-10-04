import { join } from "node:path";
import { startCore, type CoreProcess } from "../../core-process/launch";

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
