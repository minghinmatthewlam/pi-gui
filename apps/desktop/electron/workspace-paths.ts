import { realpath } from "node:fs/promises";
import path from "node:path";

export function resolveWorkspacePath(workspacePath: string, filePath: string): string {
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.resolve(workspaceRoot, filePath);
  assertInsideWorkspace(workspaceRoot, resolved);
  return resolved;
}

export async function resolveExistingWorkspacePath(
  workspacePath: string,
  filePath: string,
): Promise<string> {
  const resolved = resolveWorkspacePath(workspacePath, filePath);
  const [realWorkspaceRoot, realTarget] = await Promise.all([
    realpath(path.resolve(workspacePath)),
    realpath(resolved),
  ]);
  assertInsideWorkspace(realWorkspaceRoot, realTarget);
  return realTarget;
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("Path escapes workspace");
}
