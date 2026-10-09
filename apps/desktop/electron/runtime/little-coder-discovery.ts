import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface LittleCoderInstallation {
  readonly root: string;
  readonly launcher: string;
  readonly version: "1.20.0";
  readonly piRoot: string;
  readonly piVersion: "0.83.0";
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isContained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function containedPath(root: string, path: string, directory: boolean): Promise<string> {
  const canonical = await realpath(resolve(root, path));
  if (!isContained(root, canonical)) throw new Error("Runtime resource escapes its package.");
  const info = await stat(canonical);
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error("Runtime resource has the wrong file type.");
  }
  return canonical;
}

async function packageMetadata(root: string): Promise<Record<string, unknown>> {
  const path = await containedPath(root, "package.json", false);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isObject(value)) throw new Error("Invalid runtime package metadata.");
  return value;
}

/** Validate an explicitly supplied installation. Never install, patch, or discover globally. */
export async function discoverLittleCoder(packageRoot: string): Promise<LittleCoderInstallation> {
  const root = await realpath(packageRoot);
  const metadata = await packageMetadata(root);
  if (metadata.name !== "little-coder" || metadata.version !== "1.20.0") {
    throw new Error("Experimental Little Coder requires package version 1.20.0.");
  }
  if (!isObject(metadata.bin) || metadata.bin["little-coder"] !== "bin/little-coder.mjs") {
    throw new Error("Unsupported Little Coder launcher layout.");
  }
  const launcher = await containedPath(root, "bin/little-coder.mjs", false);
  await containedPath(root, "AGENTS.md", false);
  await containedPath(root, "skills", true);
  await containedPath(root, ".pi/extensions", true);

  // These are exactly the two layouts the inspected launcher knows how to spawn.
  const candidates = [
    join(root, "node_modules/@earendil-works/pi-coding-agent"),
    join(dirname(root), "@earendil-works/pi-coding-agent"),
  ];
  for (const candidate of candidates) {
    let piRoot: string;
    try {
      piRoot = await realpath(candidate);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const pi = await packageMetadata(piRoot);
    if (pi.name !== "@earendil-works/pi-coding-agent" || pi.version !== "0.83.0") {
      throw new Error("Experimental Little Coder requires its own Pi 0.83.0 dependency.");
    }
    const bin = typeof pi.bin === "string" ? pi.bin : isObject(pi.bin) ? pi.bin.pi : undefined;
    if (typeof bin !== "string") throw new Error("Little Coder Pi has no CLI entry.");
    await containedPath(piRoot, bin, false);
    return { root, launcher, version: "1.20.0", piRoot, piVersion: "0.83.0" };
  }
  throw new Error("Little Coder's Pi dependency is unavailable; install it separately.");
}
