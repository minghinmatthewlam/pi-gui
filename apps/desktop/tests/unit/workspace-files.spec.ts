import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

test("returns an empty list for a missing folder", async () => {
  const files = await listWorkspaceFiles(join(tmpdir(), "pi-gui-missing-workspace-files"), {
    force: true,
  });
  expect(files).toEqual([]);
});
