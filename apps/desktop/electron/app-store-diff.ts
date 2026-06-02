import { execFile } from "node:child_process";
import path from "node:path";

function validateFilePath(workspacePath: string, filePath: string): string {
  const resolved = path.resolve(workspacePath, filePath);
  if (!resolved.startsWith(workspacePath + path.sep) && resolved !== workspacePath) {
    throw new Error("Path escapes workspace");
  }
  return filePath;
}

export interface ChangedFileEntry {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "untracked";
  readonly staged: boolean;
}

export function getChangedFiles(workspacePath: string): Promise<ChangedFileEntry[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd: workspacePath, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const entries: ChangedFileEntry[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          const xy = line.slice(0, 2);
          let filePath = line.slice(3).trim();
          // Renames show as "old -> new"; use the new path
          const renameArrow = filePath.indexOf(" -> ");
          if (renameArrow >= 0) {
            filePath = filePath.slice(renameArrow + 4);
          }
          entries.push({
            path: filePath,
            status: parseStatus(xy),
            staged: isFullyStaged(xy),
          });
        }
        resolve(entries);
      },
    );
  });
}

export function getFileDiff(workspacePath: string, filePath: string): Promise<string> {
  validateFilePath(workspacePath, filePath);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["diff", "--", filePath],
      { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          // Try staged diff
          execFile(
            "git",
            ["diff", "--cached", "--", filePath],
            { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
            (error2, stdout2) => {
              if (!error2 && stdout2.trim()) {
                resolve(stdout2);
                return;
              }
              // Untracked file — show content as all-additions diff
              execFile(
                "git",
                ["diff", "--no-index", "--", "/dev/null", filePath],
                { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
                (_error3, stdout3) => {
                  // git diff --no-index exits 1 when files differ, which is expected
                  resolve(stdout3 || "");
                },
              );
            },
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function stageFile(workspacePath: string, filePath: string): Promise<void> {
  validateFilePath(workspacePath, filePath);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["add", "--", filePath],
      { cwd: workspacePath, windowsHide: true },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

function parseStatus(xy: string): ChangedFileEntry["status"] {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";

  if (x === "?" && y === "?") {
    return "untracked";
  }
  if (x === "A" || y === "A") {
    return "added";
  }
  if (x === "D" || y === "D") {
    return "deleted";
  }
  return "modified";
}

function isFullyStaged(xy: string): boolean {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "?" || x === " ") return false;
  return y === " ";
}
