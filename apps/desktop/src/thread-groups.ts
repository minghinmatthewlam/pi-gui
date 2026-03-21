import type { DesktopAppState, SessionRecord, WorkspaceRecord } from "./desktop-state";

export interface ThreadEnvironmentMeta {
  readonly kind: "local" | "worktree";
  readonly label: string;
  readonly branchName?: string;
  readonly detached?: boolean;
}

export interface ThreadListEntry {
  readonly workspaceId: string;
  readonly session: SessionRecord;
  readonly environment: ThreadEnvironmentMeta;
}

export interface ThreadGroup {
  readonly rootWorkspace: WorkspaceRecord;
  readonly threads: readonly ThreadListEntry[];
  readonly archivedThreads: readonly ThreadListEntry[];
}

export function buildThreadGroups(state: DesktopAppState): readonly ThreadGroup[] {
  const workspacesById = new Map(state.workspaces.map((workspace) => [workspace.id, workspace] as const));
  const rootWorkspaces = state.workspaces.filter((workspace) => workspace.kind === "primary");
  const orphanWorktrees = state.workspaces.filter(
    (workspace) => workspace.kind === "worktree" && !workspacesById.has(workspace.rootWorkspaceId ?? ""),
  );

  return [
    ...rootWorkspaces.map((workspace) => buildRootGroup(state, workspacesById, workspace)),
    ...orphanWorktrees.map(buildOrphanGroup),
  ];
}

function buildRootGroup(
  state: DesktopAppState,
  workspacesById: ReadonlyMap<string, WorkspaceRecord>,
  rootWorkspace: WorkspaceRecord,
): ThreadGroup {
  const linkedWorkspaces = (state.worktreesByWorkspace[rootWorkspace.id] ?? [])
    .map((worktree) => ({
      worktree,
      workspace: worktree.linkedWorkspaceId ? workspacesById.get(worktree.linkedWorkspaceId) : undefined,
    }))
    .filter((entry): entry is { worktree: NonNullable<(typeof state.worktreesByWorkspace)[string][number]>; workspace: WorkspaceRecord } =>
      Boolean(entry.workspace),
    );

  const threads: ThreadListEntry[] = [
    ...rootWorkspace.sessions.map((session) => ({
      workspaceId: rootWorkspace.id,
      session,
      environment: {
        kind: "local" as const,
        label: "Local",
      },
    })),
    ...linkedWorkspaces.flatMap(({ workspace, worktree }) =>
      workspace.sessions.map((session) => ({
        workspaceId: workspace.id,
        session,
        environment: {
          kind: "worktree" as const,
          label: worktree.name,
          branchName: worktree.branchName,
          detached: !worktree.branchName,
        },
      })),
    ),
  ];

  threads.sort((left, right) => {
    if (left.session.updatedAt !== right.session.updatedAt) {
      return right.session.updatedAt.localeCompare(left.session.updatedAt);
    }
    return left.session.title.localeCompare(right.session.title);
  });

  return partitionThreads(rootWorkspace, threads);
}

function buildOrphanGroup(workspace: WorkspaceRecord): ThreadGroup {
  return partitionThreads(
    workspace,
    workspace.sessions.map((session) => ({
      workspaceId: workspace.id,
      session,
      environment: {
        kind: "worktree",
        label: workspace.name,
        branchName: workspace.branchName,
        detached: !workspace.branchName,
      },
    })),
  );
}

function partitionThreads(rootWorkspace: WorkspaceRecord, entries: readonly ThreadListEntry[]): ThreadGroup {
  return {
    rootWorkspace,
    threads: entries.filter((entry) => !entry.session.archivedAt),
    archivedThreads: entries.filter((entry) => Boolean(entry.session.archivedAt)),
  };
}
