import type {
  DesktopAppState,
  SessionRecord,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import {
  compareByRecency,
  RECENCY_BUCKET_LABELS,
  RECENCY_BUCKET_ORDER,
  recencyBucketId,
  sessionLastInteractedAt,
  type RecencyBucketId,
} from "../../../contracts/thread-recency";

export interface ThreadEnvironmentMeta {
  readonly kind: "local" | "worktree";
  readonly label: string;
  readonly branchName?: string;
  readonly detached?: boolean;
}

export interface ThreadListEntry {
  readonly folderId: string;
  readonly workspaceId: string;
  readonly session: SessionRecord;
  readonly environment: ThreadEnvironmentMeta;
  readonly contextLabel: string;
}

export interface WorkspaceThreadGroup {
  readonly workspace: WorkspaceRecord;
  readonly threads: readonly ThreadListEntry[];
}

export const THREAD_HISTORY_PREVIEW_LIMIT = 5;

export function threadHistoryPreview<T>(
  threads: readonly T[],
  expanded: boolean,
): { readonly visible: readonly T[]; readonly overflow: boolean } {
  const overflow = threads.length > THREAD_HISTORY_PREVIEW_LIMIT;
  return {
    visible: overflow && !expanded ? threads.slice(0, THREAD_HISTORY_PREVIEW_LIMIT) : threads,
    overflow,
  };
}

export interface RecencyThreadSection {
  readonly bucket: RecencyBucketId;
  readonly label: string;
  readonly threads: readonly ThreadListEntry[];
}

export interface ThreadSidebarModel {
  readonly folders: readonly WorkspaceRecord[];
  readonly workspaceGroups: readonly WorkspaceThreadGroup[];
  readonly pinnedThreads: readonly ThreadListEntry[];
  readonly recencySections: readonly RecencyThreadSection[];
  readonly archivedThreads: readonly ThreadListEntry[];
  readonly recencyOrder: readonly ThreadListEntry[];
}

export function buildThreadSidebarModel(
  state: DesktopAppState,
  nowMs: number = Date.now(),
): ThreadSidebarModel {
  const entries = collectThreadEntries(state);
  const pinnedThreads = entries
    .filter((entry) => !entry.session.archivedAt && Boolean(entry.session.pinnedAt))
    .sort((left, right) => comparePinnedThreads(left, right, state.pinnedSessionOrder));
  const historyThreads = entries
    .filter((entry) => !entry.session.archivedAt && !entry.session.pinnedAt)
    .sort((left, right) => compareByRecency(left.session, right.session));
  const archivedThreads = entries
    .filter((entry) => Boolean(entry.session.archivedAt))
    .sort((left, right) => compareByRecency(left.session, right.session));
  const recencyOrder = entries
    .filter((entry) => !entry.session.archivedAt)
    .sort((left, right) => compareByRecency(left.session, right.session));

  const folders = listFolders(state);
  return {
    folders,
    workspaceGroups: folders.map((workspace) => ({
      workspace,
      threads: historyThreads.filter((entry) => entry.folderId === workspace.id),
    })),
    pinnedThreads,
    recencySections: RECENCY_BUCKET_ORDER.flatMap((bucket) => {
      const threads = historyThreads.filter(
        (entry) => recencyBucketId(sessionLastInteractedAt(entry.session), nowMs) === bucket,
      );
      return threads.length > 0 ? [{ bucket, label: RECENCY_BUCKET_LABELS[bucket], threads }] : [];
    }),
    archivedThreads,
    recencyOrder,
  };
}

function listFolders(state: DesktopAppState): readonly WorkspaceRecord[] {
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
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return -1;
    if (bi === -1) return 1;
    return ai - bi;
  });
  return [...sortedRoots, ...orphanWorktrees];
}

function collectThreadEntries(state: DesktopAppState): ThreadListEntry[] {
  const workspacesById = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const folders = listFolders(state);
  return folders.flatMap((folder) => {
    if (folder.kind !== "primary") {
      return folder.sessions.map((session) => ({
        folderId: folder.id,
        workspaceId: folder.id,
        session,
        environment: {
          kind: "worktree" as const,
          label: folder.name,
          branchName: folder.branchName,
          detached: !folder.branchName,
        },
        contextLabel: folder.name,
      }));
    }

    const linkedWorkspaces = (state.worktreesByWorkspace[folder.id] ?? [])
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

    return [
      ...folder.sessions.map((session) => ({
        folderId: folder.id,
        workspaceId: folder.id,
        session,
        environment: {
          kind: "local" as const,
          label: "Local",
        },
        contextLabel: folder.name,
      })),
      ...linkedWorkspaces.flatMap(({ workspace, worktree }) =>
        workspace.sessions.map((session) => ({
          folderId: folder.id,
          workspaceId: workspace.id,
          session,
          environment: {
            kind: "worktree" as const,
            label: worktree.name,
            branchName: worktree.branchName,
            detached: !worktree.branchName,
          },
          contextLabel: `${folder.name} / ${worktree.name}`,
        })),
      ),
    ];
  });
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
  return compareByRecency(left.session, right.session);
}
