import { execFile } from "node:child_process";

const fileCache = new Map<string, { files: string[]; timestamp: number }>();
const CACHE_TTL_MS = 30_000;

export function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const cached = fileCache.get(workspacePath);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
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
        fileCache.set(workspacePath, { files, timestamp: Date.now() });
        resolve(files);
      },
    );
  });
}
