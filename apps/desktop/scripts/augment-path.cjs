"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Compute the PATH pi-gui should use so npm / Homebrew / npm-global /
 * `~/.local/bin` binaries stay reachable when the app is launched from
 * Finder/Dock (which hands the process a minimal PATH).
 *
 * This is POSIX-only. Windows resolves executables differently and uses a
 * different PATH separator, so on win32 the PATH is returned untouched — this
 * avoids injecting POSIX-style entries (and a literal `undefined/.npm-global/bin`
 * when HOME is unset) into a Windows PATH.
 *
 * `~/.local/bin` is only added when it exists, since many machines never
 * create it.
 *
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, delimiter?: string, exists?: (dir: string) => boolean }} [options]
 * @returns {{ changed: boolean, path: string }}
 */
function augmentPosixPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const delimiter = options.delimiter ?? path.delimiter;
  const exists = options.exists ?? fs.existsSync;
  const currentPath = env.PATH ?? "";

  if (platform === "win32") {
    return { changed: false, path: currentPath };
  }

  const homeDir = env.HOME;
  const localBin = homeDir ? `${homeDir}/.local/bin` : undefined;
  const extraBinPaths = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    homeDir ? `${homeDir}/.npm-global/bin` : undefined,
    localBin && exists(localBin) ? localBin : undefined,
  ].filter((entry) => Boolean(entry));

  const existing = new Set(currentPath.split(delimiter));
  const missingPaths = extraBinPaths.filter((entry) => !existing.has(entry));
  if (missingPaths.length === 0) {
    return { changed: false, path: currentPath };
  }

  return { changed: true, path: [...missingPaths, currentPath].join(delimiter) };
}

module.exports = { augmentPosixPath };
