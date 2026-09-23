import { execFile } from "node:child_process";
import { open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
import type { WorkspaceFilePreview } from "../../../contracts/ipc";
import { isolatedGitEnvironment } from "./git-environment";
import { resolveExistingWorkspacePath } from "./workspace-paths";

const fileCache = new Map<string, { files: string[]; timestamp: number }>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 20;
const MAX_PREVIEW_BYTES = 200 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const ALWAYS_IGNORED_NAMES = new Set([".git", "node_modules", ".DS_Store"]);
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_LIST_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export interface ListWorkspaceFilesOptions {
  readonly force?: boolean;
  readonly maxFiles?: number;
}

type PathIgnore = ReturnType<typeof ignore>;

export async function listWorkspaceFiles(
  workspacePath: string,
  options: ListWorkspaceFilesOptions = {},
): Promise<string[]> {
  const cached = fileCache.get(workspacePath);
  if (!options.force && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.files;
  }

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files =
    (await listGitCheckoutFiles(workspacePath, maxFiles)) ??
    (await walkWorkspaceFiles(workspacePath, maxFiles));
  rememberListedFiles(workspacePath, files);
  return files;
}

export async function readWorkspaceFile(
  workspacePath: string,
  filePath: string,
): Promise<WorkspaceFilePreview> {
  const resolved = await resolveExistingWorkspacePath(workspacePath, filePath);
  const handle = await open(resolved, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return {
        path: filePath,
        content: "",
        truncated: false,
        binary: true,
        sizeBytes: stats.size,
      };
    }

    const readLength = Math.min(stats.size, MAX_PREVIEW_BYTES + 1);
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
    const previewBytes = buffer.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES));
    const binary = previewBytes.includes(0);

    return {
      path: filePath,
      content: binary ? "" : new TextDecoder("utf-8", { fatal: false }).decode(previewBytes),
      truncated: bytesRead > MAX_PREVIEW_BYTES || stats.size > MAX_PREVIEW_BYTES,
      binary,
      sizeBytes: stats.size,
    };
  } finally {
    await handle.close();
  }
}

function rememberListedFiles(workspacePath: string, files: string[]): void {
  if (fileCache.size >= CACHE_MAX_ENTRIES && !fileCache.has(workspacePath)) {
    const oldest = fileCache.keys().next().value;
    if (oldest !== undefined) {
      fileCache.delete(oldest);
    }
  }
  fileCache.set(workspacePath, { files, timestamp: Date.now() });
}

/**
 * Git's own view of the checkout: tracked files still on disk plus untracked files no ignore
 * source excludes (nested .gitignore, .git/info/exclude, core.excludesFile). Git does not
 * descend into nested repositories or linked worktrees, and submodules stay a single gitlink,
 * which is left out. Returns undefined when the folder is not usable as a Git checkout.
 */
async function listGitCheckoutFiles(
  workspacePath: string,
  maxFiles: number,
): Promise<string[] | undefined> {
  let outputs: string[];
  try {
    const [ignoredFolder, ...listings] = await Promise.all([
      // A folder its enclosing repository ignores (e.g. inside a dotfiles repo) is not part of
      // that checkout; list it from disk instead.
      gitText(workspacePath, ["check-ignore", "-q", "."]).then(
        () => true,
        () => false,
      ),
      ...[
        ["ls-files", "-z", "--stage"],
        ["ls-files", "-z", "--deleted"],
        ["ls-files", "-z", "--others", "--exclude-standard"],
      ].map((args) => gitText(workspacePath, args)),
    ]);
    if (ignoredFolder) return undefined;
    outputs = listings;
  } catch {
    return undefined;
  }
  const [staged = "", deleted = "", others = ""] = outputs;
  const missing = new Set(nulRecords(deleted));
  const files = new Set<string>();
  for (const entry of nulRecords(staged)) {
    // "<mode> <object> <stage>\t<path>"; mode 160000 is a submodule gitlink, not a file.
    const tab = entry.indexOf("\t");
    const filePath = entry.slice(tab + 1);
    if (tab < 0 || entry.startsWith("160000 ") || missing.has(filePath)) continue;
    files.add(filePath);
  }
  // A trailing slash marks a nested repository or worktree, which belongs to another checkout.
  for (const filePath of nulRecords(others)) {
    if (!filePath.endsWith("/")) files.add(filePath);
  }
  return [...files]
    .filter((filePath) => !filePath.split("/").some((name) => ALWAYS_IGNORED_NAMES.has(name)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxFiles);
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: isolatedGitEnvironment(),
    maxBuffer: GIT_LIST_MAX_BUFFER,
    timeout: GIT_LIST_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

function nulRecords(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

async function walkWorkspaceFiles(workspacePath: string, maxFiles: number): Promise<string[]> {
  const ig = ignore();
  ig.add([...ALWAYS_IGNORED_NAMES]);
  try {
    ig.add(await readFile(path.join(workspacePath, ".gitignore"), "utf8"));
  } catch (error) {
    if (!isNotFound(error)) {
      console.error("[main] Failed to read workspace .gitignore", workspacePath, error);
    }
  }

  const files: string[] = [];
  await walkDirectory(workspacePath, "", ig, files, maxFiles);
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function walkDirectory(
  absoluteDir: string,
  relativeDir: string,
  ig: PathIgnore,
  files: string[],
  maxFiles: number,
): Promise<void> {
  if (files.length >= maxFiles) {
    return;
  }

  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (relativeDir === "" && !isNotFound(error)) {
      console.error("[main] listWorkspaceFiles failed", absoluteDir, error);
    }
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= maxFiles) {
      return;
    }
    if (ALWAYS_IGNORED_NAMES.has(entry.name)) {
      continue;
    }

    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (isIgnoredPath(ig, relativePath, true)) {
        continue;
      }
      await walkDirectory(path.join(absoluteDir, entry.name), relativePath, ig, files, maxFiles);
      continue;
    }

    if (!isIgnoredPath(ig, relativePath, false)) {
      files.push(relativePath);
    }
  }
}

function isIgnoredPath(ig: PathIgnore, relativePath: string, isDirectory: boolean): boolean {
  return ig.ignores(isDirectory ? `${relativePath}/` : relativePath);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
