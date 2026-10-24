import { expect, test } from "@playwright/test";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type SessionRecord,
  type WorkspaceRecord,
  type WorktreeRecord,
} from "../../contracts/desktop-state";
import {
  buildThreadSidebarModel,
  flattenThreadTrees,
  recencyHistoryExpansionKey,
  sessionThreadKey,
  threadHistoryPreview,
  visibleThreadShortcutOrder,
  workspaceHistoryExpansionKey,
} from "../../src/features/threads/thread-groups";

const now = new Date(2026, 8, 21, 15, 0, 0);
const nowMs = now.getTime();

function isoDaysAgo(days: number, hour = 12): string {
  return new Date(2026, 8, 21 - days, hour, 0, 0).toISOString();
}

function session(
  id: string,
  title: string,
  extra: Partial<SessionRecord> & { readonly updatedAt: string },
): SessionRecord {
  return {
    id,
    title,
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...extra,
  };
}

function workspace(
  id: string,
  name: string,
  sessions: readonly SessionRecord[],
  extra: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    kind: "primary",
    sessions,
    ...extra,
  };
}

function state(
  workspaces: readonly WorkspaceRecord[],
  extra: Partial<DesktopAppState> = {},
): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    workspaces,
    workspaceOrder: workspaces.filter((entry) => entry.kind === "primary").map((entry) => entry.id),
    ...extra,
  };
}

test("omits empty date buckets and mixed-folder threads share one recency list", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("today", "Today thread", { updatedAt: isoDaysAgo(0) }),
        session("older", "Older thread", { updatedAt: isoDaysAgo(40) }),
      ]),
      workspace("beta", "Beta", [session("week", "Week thread", { updatedAt: isoDaysAgo(2) })]),
    ]),
    nowMs,
  );

  expect(model.folders.map((folder) => folder.name)).toEqual(["Alpha", "Beta"]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual([
    "today",
    "last-7-days",
    "older",
  ]);
  expect(
    model.recencySections.find((section) => section.bucket === "last-30-days"),
  ).toBeUndefined();
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Today thread",
  ]);
  expect(model.recencySections[1]?.threads[0]?.contextLabel).toBe("Beta");
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Today thread",
    "Week thread",
    "Older thread",
  ]);
});

test("keeps pins out of date buckets even when the pin is the latest send", () => {
  const pinned = session("pin", "Pinned recent", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(0, 16),
    pinnedAt: isoDaysAgo(1),
  });
  const today = session("today", "Unpinned today", {
    updatedAt: isoDaysAgo(0, 10),
    lastInteractedAt: isoDaysAgo(0, 10),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [pinned, today])]),
    nowMs,
  );

  expect(model.pinnedThreads.map((thread) => thread.session.title)).toEqual(["Pinned recent"]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual(["today"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Unpinned today",
  ]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Pinned recent",
    "Unpinned today",
  ]);
  expect(sessionThreadKey(model.recencyOrder[0]!)).toBe("alpha:pin");
});

test("puts a newer unpinned send ahead of an older pin in recencyOrder", () => {
  const pinned = session("pin", "Older pin", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(2),
    pinnedAt: isoDaysAgo(1),
  });
  const sent = session("send", "Newer send", {
    updatedAt: isoDaysAgo(0, 16),
    lastInteractedAt: isoDaysAgo(0, 16),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [pinned, sent])]),
    nowMs,
  );

  expect(model.pinnedThreads.map((thread) => thread.session.title)).toEqual(["Older pin"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Newer send",
  ]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Newer send",
    "Older pin",
  ]);
});

test("excludes archived threads from recencyOrder and date buckets", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("live", "Live", { updatedAt: isoDaysAgo(0) }),
        session("archived", "Archived", {
          updatedAt: isoDaysAgo(0, 18),
          archivedAt: isoDaysAgo(0, 18),
        }),
      ]),
    ]),
    nowMs,
  );

  expect(model.archivedThreads.map((thread) => thread.session.title)).toEqual(["Archived"]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual(["Live"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual(["Live"]);
});

test("does not let a newer lastViewedAt steal recency from lastInteractedAt", () => {
  const staleOpen = session("stale", "Stale open", {
    updatedAt: isoDaysAgo(3),
    lastInteractedAt: isoDaysAgo(3),
    lastViewedAt: isoDaysAgo(0, 18),
  });
  const recentSend = session("send", "Recent send", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
    lastViewedAt: isoDaysAgo(10),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [staleOpen, recentSend])]),
    nowMs,
  );

  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Recent send",
    "Stale open",
  ]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual(["today", "last-7-days"]);
});

test("labels worktree sessions with folder context", () => {
  const root = workspace("root", "Repo", [
    session("local", "Local thread", { updatedAt: isoDaysAgo(0) }),
  ]);
  const worktreeWorkspace = workspace(
    "wt",
    "feature",
    [session("wt-thread", "Worktree thread", { updatedAt: isoDaysAgo(0, 11) })],
    { kind: "worktree", rootWorkspaceId: "root", branchName: "feature" },
  );
  const worktree: WorktreeRecord = {
    id: "wt-record",
    rootWorkspaceId: "root",
    linkedWorkspaceId: "wt",
    name: "feature",
    path: "/tmp/feature",
    status: "ready",
    branchName: "feature",
    updatedAt: isoDaysAgo(0),
  };
  const model = buildThreadSidebarModel(
    state([root, worktreeWorkspace], { worktreesByWorkspace: { root: [worktree] } }),
    nowMs,
  );

  const worktreeEntry = model.recencyOrder.find((thread) => thread.session.id === "wt-thread");
  expect(worktreeEntry?.contextLabel).toBe("Repo / feature");
  expect(worktreeEntry?.environment.kind).toBe("worktree");
  expect(worktreeEntry?.folderId).toBe("root");
  expect(
    model.workspaceGroups
      .find((group) => group.workspace.id === "root")
      ?.threads.map((thread) => thread.session.title),
  ).toEqual(["Local thread", "Worktree thread"]);
});

test("sorts a workspace folder by last user message, not catalog updatedAt", () => {
  const opened = session("opened", "Opened recently", {
    updatedAt: isoDaysAgo(0, 18),
    lastInteractedAt: isoDaysAgo(3),
  });
  const sent = session("sent", "Sent earlier today", {
    updatedAt: isoDaysAgo(4),
    lastInteractedAt: isoDaysAgo(0, 9),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [opened, sent])]),
    nowMs,
  );

  expect(model.workspaceGroups[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Sent earlier today",
    "Opened recently",
  ]);
});

test("numbers shortcut slots pinned first, then visible rows", () => {
  const olderPin = session("pin", "Older pin", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(2),
    pinnedAt: isoDaysAgo(1),
  });
  const newerSend = session("send", "Newer send", {
    updatedAt: isoDaysAgo(0, 16),
    lastInteractedAt: isoDaysAgo(0, 16),
  });
  const hidden = Array.from({ length: 5 }, (_, index) =>
    session(`extra-${index}`, `Extra ${index}`, {
      updatedAt: isoDaysAgo(0, 10 - index),
      lastInteractedAt: isoDaysAgo(0, 10 - index),
    }),
  );
  const week = session("week", "Week thread", {
    updatedAt: isoDaysAgo(3),
    lastInteractedAt: isoDaysAgo(3),
  });
  const archived = session("archived", "Archived", {
    updatedAt: isoDaysAgo(0, 18),
    lastInteractedAt: isoDaysAgo(0, 18),
    archivedAt: isoDaysAgo(0, 18),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [olderPin, newerSend, ...hidden, week, archived])], {
      pinnedSessionOrder: ["alpha:pin"],
    }),
    nowMs,
  );

  expect(model.recencyOrder[0]?.session.title).toBe("Newer send");
  expect(
    visibleThreadShortcutOrder({ grouping: "time", model }).map((thread) => thread.session.title),
  ).toEqual(["Older pin", "Newer send", "Extra 0", "Extra 1", "Extra 2", "Extra 3", "Week thread"]);
  expect(
    visibleThreadShortcutOrder({
      grouping: "time",
      model,
      expandedHistory: new Set([recencyHistoryExpansionKey("today")]),
    }).map((thread) => thread.session.title),
  ).toEqual([
    "Older pin",
    "Newer send",
    "Extra 0",
    "Extra 1",
    "Extra 2",
    "Extra 3",
    "Extra 4",
    "Week thread",
  ]);
  expect(
    visibleThreadShortcutOrder({ grouping: "time", model, archivedOpen: true }).at(-1)?.session
      .title,
  ).toBe("Archived");
});

test("numbers workspace rows after pins, skipping collapsed overflow", () => {
  const pin = session("pin", "Pinned", {
    updatedAt: isoDaysAgo(1),
    lastInteractedAt: isoDaysAgo(1),
    pinnedAt: isoDaysAgo(0),
  });
  const alphaThreads = Array.from({ length: 6 }, (_, index) =>
    session(`a-${index}`, `Alpha ${index}`, {
      updatedAt: isoDaysAgo(0, 12 - index),
      lastInteractedAt: isoDaysAgo(0, 12 - index),
    }),
  );
  const beta = session("b", "Beta thread", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
  });
  const model = buildThreadSidebarModel(
    state(
      [workspace("alpha", "Alpha", [pin, ...alphaThreads]), workspace("beta", "Beta", [beta])],
      { pinnedSessionOrder: ["alpha:pin"] },
    ),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({ grouping: "workspace", model }).map(
      (thread) => thread.session.title,
    ),
  ).toEqual(["Pinned", "Alpha 0", "Alpha 1", "Alpha 2", "Alpha 3", "Alpha 4", "Beta thread"]);
  expect(
    visibleThreadShortcutOrder({
      grouping: "workspace",
      model,
      expandedHistory: new Set([workspaceHistoryExpansionKey("alpha")]),
    }).map((thread) => thread.session.title),
  ).toEqual([
    "Pinned",
    "Alpha 0",
    "Alpha 1",
    "Alpha 2",
    "Alpha 3",
    "Alpha 4",
    "Alpha 5",
    "Beta thread",
  ]);
});

test("numbers workspace rows only for folders that are open", () => {
  const alpha = session("a", "Alpha thread", {
    updatedAt: isoDaysAgo(0, 12),
    lastInteractedAt: isoDaysAgo(0, 12),
  });
  const beta = session("b", "Beta thread", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [alpha]), workspace("beta", "Beta", [beta])]),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({
      grouping: "workspace",
      model,
      collapsedWorkspaceIds: ["alpha"],
    }).map((thread) => thread.session.title),
  ).toEqual(["Beta thread"]);
  // Time buckets have no folders to fold, so every row stays numbered.
  expect(
    visibleThreadShortcutOrder({
      grouping: "time",
      model,
      collapsedWorkspaceIds: ["alpha"],
    }).map((thread) => thread.session.title),
  ).toEqual(["Alpha thread", "Beta thread"]);
});

test("numbers visible rows in order when nothing is pinned", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("today", "Today thread", { updatedAt: isoDaysAgo(0) }),
        session("older", "Older thread", { updatedAt: isoDaysAgo(40) }),
      ]),
    ]),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({ grouping: "time", model }).map((thread) => thread.session.title),
  ).toEqual(["Today thread", "Older thread"]);
});

test("caps a history list at five until it is expanded", () => {
  const threads = ["1", "2", "3", "4", "5", "6"];
  expect(threadHistoryPreview(threads, false)).toEqual({
    visible: ["1", "2", "3", "4", "5"],
    overflow: true,
  });
  expect(threadHistoryPreview(threads, true).visible).toEqual(threads);
  expect(threadHistoryPreview(threads.slice(0, 5), false).overflow).toBe(false);
});

function relationship(
  id: string,
  parentId: string,
  childId: string,
  parentWorkspaceId = "ws",
  childWorkspaceId = "ws",
): DesktopAppState["orchestrationChildren"][number] {
  return {
    id,
    parentWorkspaceId,
    parentSessionId: parentId,
    childWorkspaceId,
    childSessionId: childId,
    title: childId,
    goal: "fixture",
    status: "complete",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt: isoDaysAgo(0),
    updatedAt: isoDaysAgo(0),
  };
}

test("nests children under their actual parent across recency buckets and workspaces", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace("ws", "Main", [
          session("parent", "Main task", { updatedAt: isoDaysAgo(40) }),
          session("unrelated", "Other task", { updatedAt: isoDaysAgo(2) }),
        ]),
        workspace("other", "Child folder", [
          session("child", "Worker", { updatedAt: isoDaysAgo(0) }),
        ]),
      ],
      { orchestrationChildren: [relationship("child-record", "parent", "child", "ws", "other")] },
    ),
    nowMs,
  );
  expect(model.recencySections[0]?.bucket).toBe("today");
  const parent = model.recencySections[0]!.threads[0]!;
  expect(parent.session.id).toBe("parent");
  expect(parent.isParent).toBe(true);
  expect(parent.children?.[0]?.parent).toEqual({ key: "ws:parent", title: "Main task" });
  expect(model.workspaceGroups[1]?.threads).toEqual([]);
  expect(visibleThreadShortcutOrder({ grouping: "time", model }).map(sessionThreadKey)).toEqual([
    "ws:parent",
    "other:child",
    "ws:unrelated",
  ]);
  expect(
    visibleThreadShortcutOrder({
      grouping: "time",
      model,
      collapsedThreadKeys: new Set(["ws:parent"]),
    }).map(sessionThreadKey),
  ).toEqual(["ws:parent", "ws:unrelated"]);
});

test("pins, archives and orphaned children remain reachable with their parent identity", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace("ws", "Main", [
          session("parent", "Main task", { updatedAt: isoDaysAgo(3) }),
          session("nested", "Nested", { updatedAt: isoDaysAgo(0) }),
          session("pin", "Pinned child", { updatedAt: isoDaysAgo(0), pinnedAt: isoDaysAgo(0) }),
          session("archive", "Archived child", {
            updatedAt: isoDaysAgo(0),
            archivedAt: isoDaysAgo(0),
          }),
          session("orphan", "Orphan", { updatedAt: isoDaysAgo(0) }),
        ]),
      ],
      {
        orchestrationChildren: [
          relationship("n", "parent", "nested"),
          relationship("p", "parent", "pin"),
          relationship("a", "parent", "archive"),
          relationship("o", "missing", "orphan"),
        ],
      },
    ),
    nowMs,
  );
  expect(model.pinnedThreads[0]?.session.id).toBe("pin");
  expect(model.pinnedThreads[0]?.parent?.key).toBe("ws:parent");
  expect(model.archivedThreads[0]?.parent?.title).toBe("Main task");
  const visible = visibleThreadShortcutOrder({ grouping: "time", model, archivedOpen: true });
  expect(new Set(visible.map(sessionThreadKey)).size).toBe(5);
  expect(visible).toHaveLength(5);
  expect(
    model.recencyOrder.find((t) => t.session.id === "parent")?.children?.map((t) => t.session.id),
  ).toEqual(["nested"]);
});

test("malformed cycles cannot hide sessions or loop during hierarchy traversal", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace(
          "ws",
          "Main",
          ["a", "b", "c"].map((id) => session(id, id, { updatedAt: isoDaysAgo(0) })),
        ),
      ],
      {
        orchestrationChildren: [
          relationship("a", "b", "a"),
          relationship("b", "c", "b"),
          relationship("c", "a", "c"),
        ],
      },
    ),
    nowMs,
  );
  const visible = flattenThreadTrees(model.recencySections.flatMap((section) => section.threads));
  expect(new Set(visible.map(sessionThreadKey)).size).toBe(3);
  expect(visible).toHaveLength(3);
});
