import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withGithubDownloadRetry } from "./github-download-retry.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const toolsDir = path.join(repoDir, "tools");
const cacheRoot = path.join(repoDir, ".cache");

function createPackagingEnv() {
  // electron-builder wraps pnpm.cmd in a temporary .bat file. On Windows locales
  // that use a non-UTF-8 code page, paths under a non-ASCII %USERPROFILE% are
  // corrupted and pnpm list fails with "The system cannot find the path specified."
  // Prefer the ASCII repo-local shim first.
  const pathPrefix = [toolsDir, path.join(repoDir, "node_modules", ".bin")];
  const envPath = [...pathPrefix, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  const electronBuilderCache =
    process.env.ELECTRON_BUILDER_CACHE ?? path.join(cacheRoot, "electron-builder");
  const localAppData = process.env.LOCALAPPDATA ?? path.join(cacheRoot, "localappdata");
  mkdirSync(electronBuilderCache, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...process.env,
    PATH: envPath,
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    LOCALAPPDATA: localAppData,
    COREPACK_ENABLE_STRICT: "0",
  };
}

function spawnElectronBuilder(electronBuilderArgs) {
  const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpmBinary, ["exec", "electron-builder", ...electronBuilderArgs], {
    cwd: desktopDir,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    env: createPackagingEnv(),
    shell: process.platform === "win32",
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? (result.signal ? 1 : 0),
    output,
    error: result.error,
  };
}

export async function runElectronBuilder(electronBuilderArgs) {
  const result = await withGithubDownloadRetry(() => spawnElectronBuilder(electronBuilderArgs));
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const electronBuilderArgs = process.argv.slice(2);
  if (electronBuilderArgs.length === 0) {
    throw new Error("Usage: run-electron-builder.mjs <electron-builder args...>");
  }
  process.exit(await runElectronBuilder(electronBuilderArgs));
}
