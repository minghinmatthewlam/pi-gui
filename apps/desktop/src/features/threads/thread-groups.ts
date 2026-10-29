import type {
  ChildThreadLink,
  DesktopAppState,
  SessionRecord,
  ThreadGrouping,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import {
  compareByRecency,
  RECENCY_BUCKET_LABELS,
  RECENCY_BUCKET_ORDER,
  recencyBucketer,
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
  /** Set when this row is drawn nested under its parent thread's row. */
  readonly parentKey?: string;
  /** Child threads drawn nested under this row, most recent first. */
  readonly children?: readonly ThreadListEntry[];
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
  const entries = nestThreads(collectThreadEntries(state), state.childThreadLinks);
  const pinnedThreads = entries
    .filter((entry) => !entry.session.archivedAt && Boolean(entry.session.pinnedAt))
    .sort((left, right) => comparePinnedThreads(left, right, state.pinnedSessionOrder));
  const historyThreads = entries
    .filter((entry) => !entry.session.archivedAt && !entry.session.pinnedAt && !entry.parentKey)
    .sort((left, right) => compareByRecency(left.session, right.session));
  const archivedThreads = entries
    .filter((entry) => Boolean(entry.session.archivedAt))
    .sort((left, right) => compareByRecency(left.session, right.session));
  const recencyOrder = entries
    .filter((entry) => !entry.session.archivedAt)
    .sort((left, right) => compareByRecency(left.session, right.session));

  // Bucket each thread once, in recency order, instead of re-checking every thread per bucket.
  const bucketOf = recencyBucketer(nowMs);
  const historyByBucket = new Map<RecencyBucketId, ThreadListEntry[]>();
  for (const entry of historyThreads) {
    const bucket = bucketOf(sessionLastInteractedAt(entry.session));
    const threads = historyByBucket.get(bucket);
    if (threads) {
      threads.push(entry);
    } else {
      historyByBucket.set(bucket, [entry]);
    }
  }

  const folders = listFolders(state);
  return {
    folders,
    workspaceGroups: folders.map((workspace) => ({
      workspace,
      threads: historyThreads.filter((entry) => entry.folderId === workspace.id),
    })),
    pinnedThreads,
    recencySections: RECENCY_BUCKET_ORDER.flatMap((bucket) => {
      const threads = historyByBucket.get(bucket);
      return threads ? [{ bucket, label: RECENCY_BUCKET_LABELS[bucket], threads }] : [];
    }),
    archivedThreads,
    recencyOrder,
  };
}

/**
 * Nests each child thread under its parent's row. A child stays a top-level row when
 * it is pinned or archived, its parent is archived or missing, or the saved
 * links form a cycle, so every thread stays reachable. View-only: no transcript reads.
 */
function nestThreads(
  entries: readonly ThreadListEntry[],
  links: readonly ChildThreadLink[],
): ThreadListEntry[] {
  const byKey = new Map(entries.map((entry) => [sessionThreadKey(entry), entry]));
  const parentOf = new Map<string, string>();
  for (const link of links) {
    const key = `${link.childWorkspaceId}:${link.childSessionId}`;
    const parentKey = `${link.parentWorkspaceId}:${link.parentSessionId}`;
    const child = byKey.get(key);
    const parent = byKey.get(parentKey);
    if (!child || !parent || key === parentKey || parentOf.has(key)) continue;
    if (child.session.archivedAt || child.session.pinnedAt) continue;
    if (parent.session.archivedAt) continue;
    parentOf.set(key, parentKey);
  }
  for (const start of [...parentOf.keys()]) {
    const path = new Set<string>();
    for (let cursor: string | undefined = start; cursor; cursor = parentOf.get(cursor)) {
      if (path.has(cursor)) {
        parentOf.delete(cursor);
        break;
      }
      path.add(cursor);
    }
  }
  const childKeys = new Map<string, string[]>();
  for (const [key, parentKey] of parentOf) {
    const siblings = childKeys.get(parentKey);
    if (siblings) siblings.push(key);
    else childKeys.set(parentKey, [key]);
  }
  const built = new Map<string, ThreadListEntry>();
  const build = (key: string): ThreadListEntry => {
    const done = built.get(key);
    if (done) return done;
    const entry = byKey.get(key)!;
    const children = (childKeys.get(key) ?? [])
      .map(build)
      .sort((left, right) => compareByRecency(left.session, right.session));
    const parentKey = parentOf.get(key);
    const next: ThreadListEntry = {
      ...entry,
      ...(parentKey ? { parentKey } : {}),
      ...(children.length ? { children } : {}),
    };
    built.set(key, next);
    return next;
  };
  return entries.map((entry) => build(sessionThreadKey(entry)));
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
