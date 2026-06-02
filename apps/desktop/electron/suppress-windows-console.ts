// A GUI process has no console, so spawning console programs (git, npm, bash)
// flashes a console window on Windows. Default windowsHide:true on every
// child_process spawn in the main process (no-op off Windows; explicit values win).
import childProcess from "node:child_process";

if (process.platform === "win32") {
  const methods = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const;
  for (const name of methods) {
    const original = (childProcess as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") {
      continue;
    }
    const wrapped = function patchedChildProcess(this: unknown, ...args: unknown[]) {
      const hasTrailingCallback = typeof args[args.length - 1] === "function";
      const optionsIndex = hasTrailingCallback ? args.length - 2 : args.length - 1;
      const candidate = optionsIndex >= 0 ? args[optionsIndex] : undefined;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const options = candidate as Record<string, unknown>;
        if (options.windowsHide === undefined) {
          options.windowsHide = true;
        }
      } else {
        args.splice(hasTrailingCallback ? args.length - 1 : args.length, 0, { windowsHide: true });
      }
      return (original as (...callArgs: unknown[]) => unknown).apply(this, args);
    };
    (childProcess as unknown as Record<string, unknown>)[name] = wrapped;
  }
}
