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
 * `~/.local/bin`, `~/.volta/bin`, `~/.asdf/shims` and the newest
 * `~/.nvm/versions/node/<version>/bin` are only added when they exist, since
 * many machines never create them.
 *
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, delimiter?: string, exists?: (dir: string) => boolean, readDir?: (dir: string) => string[] }} [options]
 * @returns {{ changed: boolean, path: string }}
 */
function augmentPosixPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const delimiter = options.delimiter ?? path.delimiter;
  const exists = options.exists ?? fs.existsSync;
  const readDir = options.readDir ?? fs.readdirSync;
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
    homeDir && exists(`${homeDir}/.volta/bin`) ? `${homeDir}/.volta/bin` : undefined,
    homeDir && exists(`${homeDir}/.asdf/shims`) ? `${homeDir}/.asdf/shims` : undefined,
    homeDir ? newestNvmNodeBin(homeDir, exists, readDir) : undefined,
  ].filter((entry) => Boolean(entry));

  const existing = new Set(currentPath.split(delimiter));
  const missingPaths = extraBinPaths.filter((entry) => !existing.has(entry));
  if (missingPaths.length === 0) {
    return { changed: false, path: currentPath };
  }

  return { changed: true, path: [...missingPaths, currentPath].join(delimiter) };
}

/**
 * The `bin` dir of the newest node version nvm has installed, or undefined.
 * Finder/Dock launches never run the shell hooks that put the aliased version
 * on PATH, so without this npm (and node) are unreachable for GUI installs
 * whenever node is managed by nvm. The newest installed version is a best
 * effort — it matches the common `nvm install --lts` flow; anyone pinning an
 * older default keeps their shell PATH when launching from a terminal.
 */
function newestNvmNodeBin(homeDir, exists, readDir) {
  const versionsDir = `${homeDir}/.nvm/versions/node`;
  if (!exists(versionsDir)) {
    return undefined;
  }
  let entries;
  try {
    entries = readDir(versionsDir);
  } catch {
    return undefined;
  }
  const versions = entries
    .map((entry) => /^(v?)(\d+)\.(\d+)\.(\d+)$/.exec(entry))
    .filter(Boolean)
    .map((match) => ({
      entry: match[0],
      key: match.slice(2).map((part) => Number.parseInt(part, 10)),
    }));
  if (versions.length === 0) {
    return undefined;
  }
  versions.sort((left, right) => compareVersionKeys(left.key, right.key));
  const binDir = `${versionsDir}/${versions[versions.length - 1].entry}/bin`;
  return exists(binDir) ? binDir : undefined;
}

function compareVersionKeys(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

module.exports = { augmentPosixPath };
