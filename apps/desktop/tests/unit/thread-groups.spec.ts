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
  sessionThreadKey,
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
});
