import type { FileWorkbenchContext } from "../features/workbench/diff-panel-types";
import type { WorkspaceRecord, WorktreeRecord } from "../../contracts/desktop-state";

export function buildFileWorkbenchContexts({
  workspaces,
  selectedWorkspace,
  selectedSessionTitle,
  rootWorkspace,
  activeWorktrees,
}: {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSessionTitle: string | undefined;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly activeWorktrees: readonly WorktreeRecord[];
}): readonly FileWorkbenchContext[] {
  if (!selectedWorkspace) {
    return [];
  }

  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  const contexts: FileWorkbenchContext[] = [
    {
      workspace: selectedWorkspace,
      role: "thread",
      sessionTitle: selectedSessionTitle,
    },
  ];
  const seenWorkspaceIds = new Set([selectedWorkspace.id]);

  const addWorkspace = (
    workspace: WorkspaceRecord | undefined,
    role: FileWorkbenchContext["role"],
    worktree?: WorktreeRecord,
  ) => {
    if (!workspace || seenWorkspaceIds.has(workspace.id)) {
      return;
    }
    contexts.push({ workspace, role, worktree });
    seenWorkspaceIds.add(workspace.id);
  };

  addWorkspace(rootWorkspace, "workspace");
  for (const worktree of activeWorktrees) {
    addWorkspace(
      worktree.linkedWorkspaceId ? workspacesById.get(worktree.linkedWorkspaceId) : undefined,
      "worktree",
      worktree,
    );
  }

  return contexts;
}
