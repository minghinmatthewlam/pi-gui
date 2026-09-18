import { execFile } from "node:child_process";
import type { ChangedFileEntry, ChangedFilesResult } from "../src/ipc";
import { resolveWorkspacePath } from "./workspace-paths";

export interface GitCommandOptions {
  readonly cwd: string;
  readonly maxBuffer?: number;
}

export interface GitCommandResult {
  readonly error: Error | null;
  readonly stdout: string;
}

export type GitCommandExecutor = (
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

export interface StageFileOptions {
  readonly sourcePath?: string;
  readonly executeGit?: GitCommandExecutor;
}

export async function getChangedFiles(
  workspacePath: string,
  executeGit: GitCommandExecutor = executeGitCommand,
): Promise<ChangedFilesResult> {
  let result: GitCommandResult;
  try {
    result = await executeGit(["status", "--porcelain=v1", "-z"], {
      cwd: workspacePath,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    return gitStatusUnavailable(
      "git-status-failed",
      "Git status is unavailable for this workspace.",
    );
  }

  if (result.error) {
    return gitStatusUnavailable(
      "git-status-failed",
      "Git status is unavailable for this workspace.",
    );
  }

  try {
    return {
      state: "available",
      files: parseGitStatusPorcelainV1Z(result.stdout),
    };
  } catch {
    return gitStatusUnavailable(
      "git-status-invalid",
      "Git returned an unreadable changed-file status.",
    );
  }
}

export function parseGitStatusPorcelainV1Z(output: string): ChangedFileEntry[] {
  if (output === "") {
    return [];
  }
  if (!output.endsWith("\0")) {
    throw new Error("NUL-delimited Git status output is missing its terminator");
  }

  const fields = output.slice(0, -1).split("\0");
  const entries: ChangedFileEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 4 || record[2] !== " ") {
      throw new Error("Malformed Git status record");
    }

    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!isRenameOrCopy(xy)) {
      entries.push(toChangedFileEntry(xy, filePath));
      continue;
    }

    const previousPath = fields[index + 1];
    if (!previousPath) {
      throw new Error("Git rename or copy record is missing its source path");
    }
    entries.push(toChangedFileEntry(xy, filePath, previousPath));
    index += 1;
  }
  return entries;
}

export async function getFileDiff(
  workspacePath: string,
  filePath: string,
  executeGit: GitCommandExecutor = executeGitCommand,
): Promise<string> {
  resolveWorkspacePath(workspacePath, filePath);
  const options = { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024 };

  const unstaged = await executeGit(["--literal-pathspecs", "diff", "--", filePath], options);
  if (!unstaged.error && unstaged.stdout.trim()) {
    return unstaged.stdout;
  }

  const staged = await executeGit(
    ["--literal-pathspecs", "diff", "--cached", "--", filePath],
    options,
  );
  if (!staged.error && staged.stdout.trim()) {
    return staged.stdout;
  }

  const untracked = await executeGit(
    ["--literal-pathspecs", "diff", "--no-index", "--", "/dev/null", filePath],
    options,
  );
  // git diff --no-index exits 1 when files differ, which is expected.
  return untracked.stdout || "";
}

export async function stageFile(
  workspacePath: string,
  filePath: string,
  options: StageFileOptions = {},
): Promise<void> {
  resolveWorkspacePath(workspacePath, filePath);
  if (options.sourcePath !== undefined) {
    resolveWorkspacePath(workspacePath, options.sourcePath);
  }
  const paths = options.sourcePath === undefined ? [filePath] : [filePath, options.sourcePath];
  const result = await (options.executeGit ?? executeGitCommand)(
    ["--literal-pathspecs", "add", "--", ...paths],
    { cwd: workspacePath },
  );
  if (result.error) {
    throw result.error;
  }
}

function executeGitCommand(
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile("git", [...args], options, (error, stdout) => {
      resolve({
        error,
        stdout,
      });
    });
  });
}

function gitStatusUnavailable(
  code: "git-status-failed" | "git-status-invalid",
  message: string,
): ChangedFilesResult {
  return {
    state: "unavailable",
    error: { code, message },
  };
}

function toChangedFileEntry(xy: string, filePath: string, previousPath?: string): ChangedFileEntry {
  return {
    path: filePath,
    ...(previousPath === undefined ? {} : { previousPath }),
    ...(previousPath !== undefined && xy[1] === "R" ? { stagingSourcePath: previousPath } : {}),
    status: parseStatus(xy),
    staged: isFullyStaged(xy),
  };
}

function parseStatus(xy: string): ChangedFileEntry["status"] {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";

  if (x === "?" && y === "?") {
    return "untracked";
  }
  if (x === "R" || y === "R") {
    return "renamed";
  }
  if (x === "C" || y === "C") {
    return "copied";
  }
  if (x === "A" || y === "A") {
    return "added";
  }
  if (x === "D" || y === "D") {
    return "deleted";
  }
  return "modified";
}

function isRenameOrCopy(xy: string): boolean {
  return xy.includes("R") || xy.includes("C");
}

function isFullyStaged(xy: string): boolean {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "?" || x === " ") return false;
  return y === " ";
}
