import {
  getSelectedWorkspace,
  type DesktopAppState,
  type WorkspaceRecord,
  type WorktreeRecord,
} from "../../contracts/desktop-state";
import { resolveRepoWorkspaceId } from "../../contracts/workspace-roots";

export interface WorkspaceContext {
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly activeWorktrees: readonly WorktreeRecord[];
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
}

export function deriveWorkspaceContext(
  snapshot: DesktopAppState | null | undefined,
): WorkspaceContext {
  if (!snapshot) {
    return {
      selectedWorkspace: undefined,
      activeWorktrees: [],
      linkedWorktreeByWorkspaceId: new Map(),
      rootWorkspace: undefined,
      rootWorkspaceOptions: [],
      visibleWorkspaces: [],
    };
  }

  const selectedWorkspace = getSelectedWorkspace(snapshot) ?? snapshot.workspaces[0];
  const workspacesById = new Map(
    snapshot.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const primaryWorkspaces = snapshot.workspaces.filter((workspace) => workspace.kind === "primary");
  const orphanWorkspaces = snapshot.workspaces.filter(
    (workspace) =>
      workspace.kind === "worktree" && !workspacesById.has(workspace.rootWorkspaceId ?? ""),
  );
  const visibleWorkspaces =
    primaryWorkspaces.length > 0
      ? [...primaryWorkspaces, ...orphanWorkspaces]
      : snapshot.workspaces;
  const linkedWorktreeByWorkspaceId = new Map(
    Object.values(snapshot.worktreesByWorkspace)
      .flat()
      .filter((worktree) => Boolean(worktree.linkedWorkspaceId))
      .map((worktree) => [worktree.linkedWorkspaceId as string, worktree] as const),
  );
  const rootWorkspaceId = resolveRepoWorkspaceId(snapshot.workspaces, selectedWorkspace?.id);
  const rootWorkspace =
    (rootWorkspaceId
      ? snapshot.workspaces.find((workspace) => workspace.id === rootWorkspaceId)
      : undefined) ?? selectedWorkspace;
  const rootWorkspaceOptions = [
    ...new Set(
      snapshot.workspaces.map(
        (workspace) => resolveRepoWorkspaceId(snapshot.workspaces, workspace.id) ?? workspace.id,
      ),
    ),
  ]
    .map((workspaceId) => snapshot.workspaces.find((workspace) => workspace.id === workspaceId))
    .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));

  return {
    selectedWorkspace,
    activeWorktrees: rootWorkspace ? (snapshot.worktreesByWorkspace[rootWorkspace.id] ?? []) : [],
    linkedWorktreeByWorkspaceId,
    rootWorkspace,
    rootWorkspaceOptions,
    visibleWorkspaces,
  };
}
