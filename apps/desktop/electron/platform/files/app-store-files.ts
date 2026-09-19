import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import type { WorkspaceFilePreview } from "../../../contracts/ipc";
import { resolveExistingWorkspacePath } from "./workspace-paths";

const fileCache = new Map<string, { files: string[]; timestamp: number }>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 20;
const MAX_PREVIEW_BYTES = 200 * 1024;

export function listWorkspaceFiles(
  workspacePath: string,
  options: { readonly force?: boolean } = {},
): Promise<string[]> {
  const cached = fileCache.get(workspacePath);
  if (!options.force && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return Promise.resolve(cached.files);
  }

  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const files = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .sort();
        if (fileCache.size >= CACHE_MAX_ENTRIES) {
          const oldest = fileCache.keys().next().value;
          if (oldest !== undefined) {
            fileCache.delete(oldest);
          }
        }
        fileCache.set(workspacePath, { files, timestamp: Date.now() });
        resolve(files);
      },
    );
  });
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
