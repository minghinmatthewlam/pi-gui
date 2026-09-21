import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "../../electron/platform/files/workspace-paths";

test("rejects relative paths that escape the workspace before reveal", async () => {
  const workspacePath = join(await mkdtemp(join(tmpdir(), "pi-gui-path-")), "safe");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "keep.txt"), "ok\n", "utf8");

  expect(() => resolveWorkspacePath(workspacePath, "../secret.txt")).toThrow(
    "Path escapes workspace",
  );
  await expect(resolveExistingWorkspacePath(workspacePath, "../secret.txt")).rejects.toThrow(
    "Path escapes workspace",
  );
});

test("resolves an existing file inside the workspace", async () => {
  const workspacePath = join(await mkdtemp(join(tmpdir(), "pi-gui-path-")), "safe");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "keep.txt"), "ok\n", "utf8");
  const resolved = await resolveExistingWorkspacePath(workspacePath, "keep.txt");
  expect(resolved).toBe(await realpath(join(workspacePath, "keep.txt")));
});
