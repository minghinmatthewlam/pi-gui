import type {
  DesktopAppState,
  SessionRecord,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";

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
  readonly contextLabel: string;
}

export interface ThreadGroup {
  readonly rootWorkspace: WorkspaceRecord;
  readonly pinnedThreads: readonly ThreadListEntry[];
  readonly threads: readonly ThreadListEntry[];
  readonly archivedThreads: readonly ThreadListEntry[];
}

export function buildThreadGroups(state: DesktopAppState): readonly ThreadGroup[] {
  const workspacesById = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const rootWorkspaces = state.workspaces.filter((workspace) => workspace.kind === "primary");
  const orphanWorktrees = state.workspaces.filter(
    (workspace) =>
      workspace.kind === "worktree" && !workspacesById.has(workspace.rootWorkspaceId ?? ""),
  );

  const order = state.workspaceOrder;
  const sortedRoots = [...rootWorkspaces].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    // Workspaces not in the order list come first (newly added)
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return -1;
    if (bi === -1) return 1;
    return ai - bi;
  });

  return [
    ...sortedRoots.map((workspace) => buildRootGroup(state, workspacesById, workspace)),
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
      workspace: worktree.linkedWorkspaceId
        ? workspacesById.get(worktree.linkedWorkspaceId)
        : undefined,
    }))
    .filter(
      (
        entry,
      ): entry is {
        worktree: NonNullable<(typeof state.worktreesByWorkspace)[string][number]>;
        workspace: WorkspaceRecord;
      } => Boolean(entry.workspace),
    );

  const threads: ThreadListEntry[] = [
    ...rootWorkspace.sessions.map((session) => ({
      workspaceId: rootWorkspace.id,
      session,
      environment: {
        kind: "local" as const,
        label: "Local",
      },
      contextLabel: rootWorkspace.name,
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
        contextLabel: `${rootWorkspace.name} / ${worktree.name}`,
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
      contextLabel: workspace.name,
    })),
  );
}

function partitionThreads(
  rootWorkspace: WorkspaceRecord,
  entries: readonly ThreadListEntry[],
): ThreadGroup {
  return {
    rootWorkspace,
    pinnedThreads: entries.filter(
      (entry) => !entry.session.archivedAt && Boolean(entry.session.pinnedAt),
    ),
    threads: entries.filter((entry) => !entry.session.archivedAt && !entry.session.pinnedAt),
    archivedThreads: entries.filter((entry) => Boolean(entry.session.archivedAt)),
  };
}

export const WORKSPACE_HISTORY_PREVIEW_LIMIT = 5;

export function workspaceHistoryList<T>(
  threads: readonly T[],
  expanded: boolean,
): { readonly visible: readonly T[]; readonly overflow: boolean } {
  const overflow = threads.length > WORKSPACE_HISTORY_PREVIEW_LIMIT;
  return {
    visible: overflow && !expanded ? threads.slice(0, WORKSPACE_HISTORY_PREVIEW_LIMIT) : threads,
    overflow,
  };
}

export function sessionThreadKey(thread: ThreadListEntry): string {
  return `${thread.workspaceId}:${thread.session.id}`;
}

export function comparePinnedThreads(
  left: ThreadListEntry,
  right: ThreadListEntry,
  pinnedSessionOrder: readonly string[] = [],
): number {
  const order = new Map(pinnedSessionOrder.map((key, index) => [key, index] as const));
  const leftIndex = order.get(sessionThreadKey(left));
  const rightIndex = order.get(sessionThreadKey(right));
  if (leftIndex !== undefined || rightIndex !== undefined) {
    if (leftIndex === undefined) return 1;
    if (rightIndex === undefined) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  const leftPinnedAt = left.session.pinnedAt ?? "";
  const rightPinnedAt = right.session.pinnedAt ?? "";
  if (leftPinnedAt !== rightPinnedAt) {
    return rightPinnedAt.localeCompare(leftPinnedAt);
  }
  if (left.session.updatedAt !== right.session.updatedAt) {
    return right.session.updatedAt.localeCompare(left.session.updatedAt);
  }
  return left.session.title.localeCompare(right.session.title);
}
