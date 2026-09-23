import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { listWorkspaceFiles } from "../../electron/platform/files/app-store-files";

async function makeFolder(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-workspace-files-"));
  const workspacePath = join(root, name);
  await mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

test("lists files in a folder that is not a git repository", async () => {
  const workspacePath = await makeFolder("plain-folder");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# plain\n", "utf8");
  await writeFile(join(workspacePath, "src", "app.ts"), "export {}\n", "utf8");

  const files = await listWorkspaceFiles(workspacePath, { force: true });
  expect(files).toEqual(["README.md", "src/app.ts"]);
});

test("lists files when .git exists but is not a usable git directory", async () => {
  const workspacePath = await makeFolder("broken-git");
  await writeFile(join(workspacePath, ".git"), "not a git dir\n", "utf8");
  await writeFile(join(workspacePath, "notes.md"), "hello\n", "utf8");

  const files = await listWorkspaceFiles(workspacePath, { force: true });
  expect(files).toEqual(["notes.md"]);
});

test("skips node_modules and .git contents without a gitignore", async () => {
  const workspacePath = await makeFolder("skipped-dirs");
  await mkdir(join(workspacePath, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(workspacePath, ".git", "objects"), { recursive: true });
  await writeFile(
    join(workspacePath, "node_modules", "left-pad", "index.js"),
    "module.exports=1\n",
  );
  await writeFile(join(workspacePath, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(workspacePath, "keep.txt"), "keep\n", "utf8");

  const files = await listWorkspaceFiles(workspacePath, { force: true });
  expect(files).toEqual(["keep.txt"]);
});

test("omits files ignored by the workspace .gitignore", async () => {
  const workspacePath = await makeFolder("gitignore");
  await writeFile(join(workspacePath, ".gitignore"), "secret.txt\nbuild/\n", "utf8");
  await mkdir(join(workspacePath, "build"), { recursive: true });
  await writeFile(join(workspacePath, "secret.txt"), "nope\n", "utf8");
  await writeFile(join(workspacePath, "build", "out.js"), "console.log(1)\n", "utf8");
  await writeFile(join(workspacePath, "keep.ts"), "export {}\n", "utf8");

  const files = await listWorkspaceFiles(workspacePath, { force: true });
  expect(files).toEqual([".gitignore", "keep.ts"]);
});

test("descends into directories un-ignored after a catch-all gitignore", async () => {
  const workspacePath = await makeFolder("star-gitignore");
  await writeFile(join(workspacePath, ".gitignore"), "*\n!src/\n!src/**\n!README.md\n", "utf8");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# keep\n", "utf8");
  await writeFile(join(workspacePath, "secret.txt"), "nope\n", "utf8");
  await writeFile(join(workspacePath, "src", "app.ts"), "export {}\n", "utf8");

  const files = await listWorkspaceFiles(workspacePath, { force: true });
  expect(files).toEqual(["README.md", "src/app.ts"]);
});

function gitIn(cwd: string) {
  return (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=pi", "-c", "user.email=pi@example.com", ...args], {
      cwd,
      stdio: "ignore",
    });
}

async function makeGitRepo(name: string): Promise<{ path: string; git: ReturnType<typeof gitIn> }> {
  const workspacePath = await makeFolder(name);
  const git = gitIn(workspacePath);
  git("init", "-q");
  return { path: workspacePath, git };
}

test("leaves out git worktrees checked out inside the repository", async () => {
  const { path: workspacePath, git } = await makeGitRepo("repo-with-worktrees");
  await writeFile(join(workspacePath, "app.ts"), "export {}\n", "utf8");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("worktree", "add", "-q", "-b", "feature", ".worktrees/feature");

  expect(await listWorkspaceFiles(workspacePath, { force: true })).toEqual(["app.ts"]);
  // Opened on its own, the worktree lists its own checkout.
  expect(
    await listWorkspaceFiles(join(workspacePath, ".worktrees", "feature"), { force: true }),
  ).toEqual(["app.ts"]);
});

test("honors every git ignore source, not only the root .gitignore", async () => {
  const { path: workspacePath, git } = await makeGitRepo("repo-ignore-sources");
  await mkdir(join(workspacePath, "local-scratch"), { recursive: true });
  await mkdir(join(workspacePath, "pkg", "dist"), { recursive: true });
  await writeFile(join(workspacePath, ".git", "info", "exclude"), "local-scratch/\n", "utf8");
  await writeFile(join(workspacePath, "local-scratch", "notes.md"), "x\n", "utf8");
  await writeFile(join(workspacePath, "pkg", ".gitignore"), "dist/\n", "utf8");
  await writeFile(join(workspacePath, "pkg", "dist", "out.js"), "x\n", "utf8");
  await writeFile(join(workspacePath, "pkg", "index.ts"), "export {}\n", "utf8");
  await writeFile(join(workspacePath, "untracked.ts"), "export {}\n", "utf8");

  expect(await listWorkspaceFiles(workspacePath, { force: true })).toEqual([
    "pkg/.gitignore",
    "pkg/index.ts",
    "untracked.ts",
  ]);
});

test("omits tracked files deleted from disk and submodule gitlinks", async () => {
  const { path: workspacePath, git } = await makeGitRepo("repo-deleted-and-submodule");
  const library = await makeGitRepo("library");
  await writeFile(join(library.path, "lib.ts"), "export {}\n", "utf8");
  library.git("add", ".");
  library.git("commit", "-q", "-m", "lib");
  await writeFile(join(workspacePath, "keep.ts"), "export {}\n", "utf8");
  await writeFile(join(workspacePath, "gone.ts"), "export {}\n", "utf8");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("-c", "protocol.file.allow=always", "submodule", "add", "-q", library.path, "vendor/lib");
  await rm(join(workspacePath, "gone.ts"));

  expect(await listWorkspaceFiles(workspacePath, { force: true })).toEqual([
    ".gitmodules",
    "keep.ts",
  ]);
});

test("lists a folder its enclosing repository ignores from disk", async () => {
  const { path: repoPath } = await makeGitRepo("repo-ignoring-folder");
  await writeFile(join(repoPath, ".gitignore"), "*\n", "utf8");
  const workspacePath = join(repoPath, "projects", "app");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "main.ts"), "export {}\n", "utf8");

  expect(await listWorkspaceFiles(workspacePath, { force: true })).toEqual(["main.ts"]);
});

test("returns an empty list for a missing folder", async () => {
  const files = await listWorkspaceFiles(join(tmpdir(), "pi-gui-missing-workspace-files"), {
    force: true,
  });
  expect(files).toEqual([]);
});
