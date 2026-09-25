import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Worktrees pi-gui creates live under the active profile's `<userData>/worktrees`
 * or the legacy shared `~/.pi/worktrees`. Only those nest under the folder that
 * created them; any other checkout the user opens is its own sidebar folder.
 */
export function appWorktreeRootMatcher(profileRoot: string): (path: string) => Promise<boolean> {
  return async (path) => {
    const candidate = await canonicalize(path);
    // Read HOME per call so tests that point HOME elsewhere see their legacy root.
    const roots = await Promise.all(
      [profileRoot, join(homedir(), ".pi", "worktrees")].map(canonicalize),
    );
    return roots.some((root) => isStrictlyWithin(root, candidate));
  };
}

function isStrictlyWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/** realpath of the nearest existing ancestor, so missing roots still compare like git's paths. */
async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await canonicalize(parent), basename(absolute));
  }
}
