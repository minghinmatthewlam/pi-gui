import type {
  DesktopAppState,
  OrchestrationChildThreadStatus,
  SessionRecord,
  ThreadGrouping,
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
  readonly parent?: { readonly key: string; readonly title: string };
  readonly isParent?: boolean;
  readonly childStatus?: OrchestrationChildThreadStatus;
  readonly children?: readonly ThreadListEntry[];
  readonly latestActivityAt?: string;
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
  const nestedKeys = attachThreadHierarchy(entries, state.orchestrationChildren);
  const pinnedThreads = entries
    .filter((entry) => !entry.session.archivedAt && Boolean(entry.session.pinnedAt))
    .sort((left, right) => comparePinnedThreads(left, right, state.pinnedSessionOrder));
  const historyThreads = entries
    .filter(
      (entry) =>
        !entry.session.archivedAt &&
        !entry.session.pinnedAt &&
        !nestedKeys.has(sessionThreadKey(entry)),
    )
    .sort(
      (left, right) =>
        threadActivityAt(right).localeCompare(threadActivityAt(left)) ||
        compareByRecency(left.session, right.session),
    );
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
        (entry) => recencyBucketId(threadActivityAt(entry), nowMs) === bucket,
      );
      return threads.length > 0 ? [{ bucket, label: RECENCY_BUCKET_LABELS[bucket], threads }] : [];
    }),
    archivedThreads,
    recencyOrder,
  };
}

function threadActivityAt(thread: ThreadListEntry): string {
  return thread.latestActivityAt ?? sessionLastInteractedAt(thread.session);
}

/** View-only links: no transcript reads, persistence, or changes to task execution. */
function attachThreadHierarchy(
  entries: ThreadListEntry[],
  relationships: DesktopAppState["orchestrationChildren"],
): ReadonlySet<string> {
  type Node = Omit<ThreadListEntry, "parent" | "childStatus" | "children" | "latestActivityAt"> & {
    parent?: ThreadListEntry["parent"];
    childStatus?: OrchestrationChildThreadStatus;
    children?: Node[];
    latestActivityAt?: string;
    isParent?: boolean;
  };
  const nodes = new Map(entries.map((entry) => [sessionThreadKey(entry), entry as Node]));
  const parents = new Map<string, string>();
  for (const relation of relationships) {
    const key = `${relation.childWorkspaceId}:${relation.childSessionId}`;
    const parentKey = `${relation.parentWorkspaceId}:${relation.parentSessionId}`;
    const child = nodes.get(key);
    const parent = nodes.get(parentKey);
    if (parent && key !== parentKey) parent.isParent = true;
    if (!child || child.parent || key === parentKey) continue;
    child.parent = { key: parentKey, title: parent?.session.title ?? "Original parent" };
    child.childStatus = relation.status;
    // Pins keep their existing location; archived/orphaned children keep a parent label.
    if (
      parent &&
      !parent.session.archivedAt &&
      !child.session.archivedAt &&
      !child.session.pinnedAt
    ) {
      parents.set(key, parentKey);
    }
  }
  // Break malformed saved cycles in linear time, so every session remains reachable.
  const visited = new Set<string>();
  for (const key of parents.keys()) {
    const path = new Set<string>();
    let cursor: string | undefined = key;
    while (cursor && !visited.has(cursor)) {
      if (path.has(cursor)) {
        parents.delete(cursor);
        break;
      }
      path.add(cursor);
      cursor = parents.get(cursor);
    }
    for (const item of path) visited.add(item);
  }
  for (const [key, parentKey] of parents) {
    const parent = nodes.get(parentKey)!;
    (parent.children ??= []).push(nodes.get(key)!);
  }
  const roots = entries.filter((entry) => !parents.has(sessionThreadKey(entry)));
  const ordered = flattenThreadTrees(roots);
  for (let index = ordered.length - 1; index >= 0; index--) {
    const node = ordered[index] as Node;
    node.children?.sort((a, b) => threadActivityAt(b).localeCompare(threadActivityAt(a)));
    node.latestActivityAt = node.children?.reduce(
      (latest, child) => (latest > threadActivityAt(child) ? latest : threadActivityAt(child)),
      sessionLastInteractedAt(node.session),
    );
  }
  return new Set(parents.keys());
}

export function flattenThreadTrees(
  roots: readonly ThreadListEntry[],
  collapsed: ReadonlySet<string> = new Set(),
): ThreadListEntry[] {
  const result: ThreadListEntry[] = [];
  const pending = [...roots].reverse();
  while (pending.length) {
    const entry = pending.pop()!;
    result.push(entry);
    if (!collapsed.has(sessionThreadKey(entry))) {
      const children = entry.children ?? [];
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
    }
  }
  return result;
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

const EMPTY_EXPANDED_HISTORY: ReadonlySet<string> = new Set();

export function workspaceHistoryExpansionKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function recencyHistoryExpansionKey(bucket: RecencyBucketId): string {
  return `bucket:${bucket}`;
}

export interface VisibleThreadShortcutOptions {
  readonly grouping: ThreadGrouping;
  readonly model: ThreadSidebarModel;
  readonly expandedHistory?: ReadonlySet<string>;
  readonly archivedOpen?: boolean;
  /** Folder groups folded shut in the sidebar; their rows are not on screen. */
  readonly collapsedWorkspaceIds?: readonly string[];
  readonly collapsedThreadKeys?: ReadonlySet<string>;
}

export function visibleThreadShortcutOrder(
  options: VisibleThreadShortcutOptions,
): readonly ThreadListEntry[] {
  const expandedHistory = options.expandedHistory ?? EMPTY_EXPANDED_HISTORY;
  const collapsedWorkspaceIds = new Set(options.collapsedWorkspaceIds ?? []);
  const unpinned =
    options.grouping === "workspace"
      ? options.model.workspaceGroups
          .filter((group) => !collapsedWorkspaceIds.has(group.workspace.id))
          .flatMap(
            (group) =>
              threadHistoryPreview(
                group.threads,
                expandedHistory.has(workspaceHistoryExpansionKey(group.workspace.id)),
              ).visible,
          )
      : options.model.recencySections.flatMap(
          (section) =>
            threadHistoryPreview(
              section.threads,
              expandedHistory.has(recencyHistoryExpansionKey(section.bucket)),
            ).visible,
        );
  return flattenThreadTrees(
    [
      ...options.model.pinnedThreads,
      ...unpinned,
      ...(options.archivedOpen ? options.model.archivedThreads : []),
    ],
    options.collapsedThreadKeys,
  );
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
