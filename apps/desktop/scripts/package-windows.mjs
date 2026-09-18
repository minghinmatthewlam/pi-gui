import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const toolsDir = path.join(repoDir, "tools");
const cacheRoot = path.join(repoDir, ".cache");

const electronBuilderArgs = process.argv.slice(2);
if (electronBuilderArgs.length === 0) {
  throw new Error("Usage: package-windows.mjs <electron-builder args...>");
}

// electron-builder wraps pnpm.cmd in a temporary .bat file. On Windows locales that use a
// non-UTF-8 code page, paths under a non-ASCII %USERPROFILE% are corrupted and pnpm list fails
// with "The system cannot find the path specified." Prefer the ASCII repo-local shim first.
const pathPrefix = [toolsDir, path.join(repoDir, "node_modules", ".bin")];
const envPath = [...pathPrefix, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);

const electronBuilderCache =
  process.env.ELECTRON_BUILDER_CACHE ?? path.join(cacheRoot, "electron-builder");
const localAppData = process.env.LOCALAPPDATA ?? path.join(cacheRoot, "localappdata");
mkdirSync(electronBuilderCache, { recursive: true });
mkdirSync(localAppData, { recursive: true });

const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpmBinary, ["exec", "electron-builder", ...electronBuilderArgs], {
  cwd: desktopDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: envPath,
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    LOCALAPPDATA: localAppData,
    COREPACK_ENABLE_STRICT: "0",
  },
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? (result.signal ? 1 : 0));
