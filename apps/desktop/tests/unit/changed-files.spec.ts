import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  getChangedFiles,
  getFileDiff,
  parseGitStatusPorcelainV1Z,
  stageFile,
  type GitCommandExecutor,
  type GitCommandResult,
} from "../../electron/app-store-diff";

const execFileAsync = promisify(execFile);

function pathologicalPath(label: string): string {
  return ` ${label} with space\t"quoted"\nsource -> destination `;
}

function gitResult(stdout = "", error: Error | null = null): GitCommandResult {
  return { error, stdout };
}

test("parses NUL-delimited status records without changing path bytes represented by UTF-8", () => {
  const modifiedPath = pathologicalPath("modified");
  const stagedPath = pathologicalPath("staged");
  const addedPath = pathologicalPath("added");
  const untrackedPath = pathologicalPath("untracked");
  const deletedPath = pathologicalPath("deleted");
  const renamedPath = pathologicalPath("renamed destination");
  const renameSourcePath = pathologicalPath("renamed source");
  const worktreeRenamedPath = pathologicalPath("worktree renamed destination");
  const worktreeRenameSourcePath = pathologicalPath("worktree renamed source");
  const copiedPath = pathologicalPath("copied destination");
  const copySourcePath = pathologicalPath("copied source");
  const porcelain = [
    ` M ${modifiedPath}`,
    `M  ${stagedPath}`,
    `A  ${addedPath}`,
    `?? ${untrackedPath}`,
    ` D ${deletedPath}`,
    `R  ${renamedPath}`,
    renameSourcePath,
    ` R ${worktreeRenamedPath}`,
    worktreeRenameSourcePath,
    `C  ${copiedPath}`,
    copySourcePath,
    "",
  ].join("\0");

  expect(parseGitStatusPorcelainV1Z(porcelain)).toEqual([
    { path: modifiedPath, status: "modified", staged: false },
    { path: stagedPath, status: "modified", staged: true },
    { path: addedPath, status: "added", staged: true },
    { path: untrackedPath, status: "untracked", staged: false },
    { path: deletedPath, status: "deleted", staged: false },
    {
      path: renamedPath,
      previousPath: renameSourcePath,
      status: "renamed",
      staged: true,
    },
    {
      path: worktreeRenamedPath,
      previousPath: worktreeRenameSourcePath,
      stagingSourcePath: worktreeRenameSourcePath,
      status: "renamed",
      staged: false,
    },
    {
      path: copiedPath,
      previousPath: copySourcePath,
      status: "copied",
      staged: true,
    },
  ]);
});

test("uses machine-safe status arguments and returns typed failures", async () => {
  const calls: { args: readonly string[]; cwd: string; maxBuffer?: number }[] = [];
  const executeGit: GitCommandExecutor = async (args, options) => {
    calls.push({ args, ...options });
    return gitResult(`?? ${pathologicalPath("status")}\0`);
  };

  const available = await getChangedFiles("/workspace", executeGit);
  expect(available).toEqual({
    state: "available",
    files: [
      {
        path: pathologicalPath("status"),
        status: "untracked",
        staged: false,
      },
    ],
  });
  expect(calls).toEqual([
    {
      args: ["status", "--porcelain=v1", "-z"],
      cwd: "/workspace",
      maxBuffer: 2 * 1024 * 1024,
    },
  ]);

  const executionFailure = await getChangedFiles("/workspace", async () =>
    gitResult("", new Error("injected Git failure")),
  );
  expect(executionFailure).toEqual({
    state: "unavailable",
    error: {
      code: "git-status-failed",
      message: "Git status is unavailable for this workspace.",
    },
  });

  const invalidOutput = await getChangedFiles("/workspace", async () =>
    gitResult("?? not NUL terminated"),
  );
  expect(invalidOutput).toEqual({
    state: "unavailable",
    error: {
      code: "git-status-invalid",
      message: "Git returned an unreadable changed-file status.",
    },
  });
});

test("passes exact paths as isolated argv values for diff and stage", async () => {
  const exactPath = ":(glob)*$(touch should-not-run); old -> new*.txt";
  const calls: string[][] = [];
  const responses = [
    gitResult(),
    gitResult(),
    gitResult("untracked diff", new Error("expected no-index exit 1")),
    gitResult(),
    gitResult(),
  ];
  const executeGit: GitCommandExecutor = async (args) => {
    calls.push([...args]);
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected Git command");
    }
    return response;
  };

  await expect(getFileDiff("/workspace", exactPath, executeGit)).resolves.toBe("untracked diff");
  const renameDestination = pathologicalPath("rename destination");
  const renameSource = pathologicalPath("rename source");
  await expect(stageFile("/workspace", exactPath, { executeGit })).resolves.toBeUndefined();
  await expect(
    stageFile("/workspace", renameDestination, { sourcePath: renameSource, executeGit }),
  ).resolves.toBeUndefined();
  expect(calls).toEqual([
    ["--literal-pathspecs", "diff", "--", exactPath],
    ["--literal-pathspecs", "diff", "--cached", "--", exactPath],
    ["--literal-pathspecs", "diff", "--no-index", "--", "/dev/null", exactPath],
    ["--literal-pathspecs", "add", "--", exactPath],
    ["--literal-pathspecs", "add", "--", renameDestination, renameSource],
  ]);
});

test("stages both exact paths for a filesystem rename", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-gui-stage-rename-"));
  const sourcePath = "source name.txt";
  const destinationPath = "destination name.txt";

  try {
    await runGit(workspacePath, ["init", "-b", "main"]);
    await runGit(workspacePath, ["config", "user.name", "Pi App Tests"]);
    await runGit(workspacePath, ["config", "user.email", "pi-gui-tests@example.com"]);
    await writeFile(join(workspacePath, sourcePath), "rename contents\n", "utf8");
    await runGit(workspacePath, ["add", "--", sourcePath]);
    await runGit(workspacePath, ["commit", "-m", "base"]);
    await rename(join(workspacePath, sourcePath), join(workspacePath, destinationPath));

    await stageFile(workspacePath, destinationPath, { sourcePath });
    await expect(getChangedFiles(workspacePath)).resolves.toEqual({
      state: "available",
      files: [
        {
          path: destinationPath,
          previousPath: sourcePath,
          status: "renamed",
          staged: true,
        },
      ],
    });
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("round-trips pathological paths through a real Git repository", async () => {
  test.skip(
    process.platform === "win32",
    "Win32 filenames cannot represent tabs, quotes, or newlines.",
  );

  const workspacePath = await mkdtemp(join(tmpdir(), "pi-gui-changed-files-"));
  const modifiedPath = pathologicalPath("modified");
  const stagedPath = pathologicalPath("staged");
  const addedPath = pathologicalPath("added");
  const untrackedPath = pathologicalPath("untracked");
  const deletedPath = pathologicalPath("deleted");
  const renameSourcePath = pathologicalPath("rename source");
  const renamedPath = pathologicalPath("rename destination");
  const pathspecMagicPath = ":(glob)*.txt";
  const pathspecVictimPath = "pathspec-victim.txt";
  const renameBaseContents = "renamed base contents ".repeat(20);

  try {
    await runGit(workspacePath, ["init", "-b", "main"]);
    await runGit(workspacePath, ["config", "user.name", "Pi App Tests"]);
    await runGit(workspacePath, ["config", "user.email", "pi-gui-tests@example.com"]);

    await writeFile(join(workspacePath, modifiedPath), "modified base\n", "utf8");
    await writeFile(join(workspacePath, stagedPath), "staged base\n", "utf8");
    await writeFile(join(workspacePath, deletedPath), "deleted base\n", "utf8");
    await writeFile(join(workspacePath, renameSourcePath), renameBaseContents, "utf8");
    await runGit(workspacePath, ["add", "-A"]);
    await runGit(workspacePath, ["commit", "-m", "base"]);

    await writeFile(join(workspacePath, modifiedPath), "modified worktree\n", "utf8");
    await writeFile(join(workspacePath, stagedPath), "staged index\n", "utf8");
    await runGit(workspacePath, ["add", "--", stagedPath]);
    await writeFile(join(workspacePath, addedPath), "added index\n", "utf8");
    await runGit(workspacePath, ["add", "--", addedPath]);
    await writeFile(join(workspacePath, untrackedPath), "untracked contents\n", "utf8");
    await writeFile(join(workspacePath, pathspecMagicPath), "literal pathspec contents\n", "utf8");
    await writeFile(join(workspacePath, pathspecVictimPath), "must remain untracked\n", "utf8");
    await unlink(join(workspacePath, deletedPath));
    await runGit(workspacePath, ["mv", "--", renameSourcePath, renamedPath]);
    await writeFile(
      join(workspacePath, renamedPath),
      `${renameBaseContents}worktree edit\n`,
      "utf8",
    );

    const result = await getChangedFiles(workspacePath);
    expect(result.state).toBe("available");
    if (result.state !== "available") {
      return;
    }

    const entriesByPath = new Map(result.files.map((entry) => [entry.path, entry]));
    expect(entriesByPath.size).toBe(8);
    expect(entriesByPath.get(modifiedPath)).toEqual({
      path: modifiedPath,
      status: "modified",
      staged: false,
    });
    expect(entriesByPath.get(stagedPath)).toEqual({
      path: stagedPath,
      status: "modified",
      staged: true,
    });
    expect(entriesByPath.get(addedPath)).toEqual({
      path: addedPath,
      status: "added",
      staged: true,
    });
    expect(entriesByPath.get(untrackedPath)).toEqual({
      path: untrackedPath,
      status: "untracked",
      staged: false,
    });
    expect(entriesByPath.get(deletedPath)).toEqual({
      path: deletedPath,
      status: "deleted",
      staged: false,
    });
    expect(entriesByPath.get(renamedPath)).toEqual({
      path: renamedPath,
      previousPath: renameSourcePath,
      status: "renamed",
      staged: false,
    });
    expect(entriesByPath.get(pathspecMagicPath)).toEqual({
      path: pathspecMagicPath,
      status: "untracked",
      staged: false,
    });
    expect(entriesByPath.get(pathspecVictimPath)).toEqual({
      path: pathspecVictimPath,
      status: "untracked",
      staged: false,
    });

    await expect(getFileDiff(workspacePath, untrackedPath)).resolves.toContain(
      "untracked contents",
    );
    await expect(getFileDiff(workspacePath, pathspecMagicPath)).resolves.toContain(
      "literal pathspec contents",
    );
    await stageFile(workspacePath, untrackedPath);
    await stageFile(workspacePath, renamedPath);
    await stageFile(workspacePath, pathspecMagicPath);
    const stagedNames = await runGit(workspacePath, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--",
      untrackedPath,
    ]);
    expect(stagedNames).toBe(`${untrackedPath}\0`);

    const stagedResult = await getChangedFiles(workspacePath);
    expect(stagedResult.state).toBe("available");
    if (stagedResult.state === "available") {
      expect(stagedResult.files.find((entry) => entry.path === renamedPath)).toEqual({
        path: renamedPath,
        previousPath: renameSourcePath,
        status: "renamed",
        staged: true,
      });
      expect(stagedResult.files.find((entry) => entry.path === pathspecMagicPath)).toEqual({
        path: pathspecMagicPath,
        status: "added",
        staged: true,
      });
      expect(stagedResult.files.find((entry) => entry.path === pathspecVictimPath)).toEqual({
        path: pathspecVictimPath,
        status: "untracked",
        staged: false,
      });
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

async function runGit(workspacePath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: workspacePath,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}
