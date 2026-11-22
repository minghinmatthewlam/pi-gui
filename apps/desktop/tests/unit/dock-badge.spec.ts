import { expect, test } from "@playwright/test";
import type { SessionRecord, WorkspaceRecord } from "../../contracts/desktop-state";
import { createDockBadgeUpdater } from "../../electron/platform/dock-badge";

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    title: id,
    updatedAt: "2026-11-22T10:00:00.000Z",
    preview: "Finished",
    status: "idle",
    hasUnseenUpdate: true,
    ...overrides,
  };
}

function workspace(id: string, sessions: SessionRecord[]): WorkspaceRecord {
  return { id, name: id, path: `/projects/${id}`, lastOpenedAt: "", kind: "primary", sessions };
}

function badgeHarness() {
  const badges: string[] = [];
  const update = createDockBadgeUpdater({
    setBadge: (badge) => {
      badges.push(badge);
    },
  });
  return { badges, update };
}

test("initializes from unread sidebar state across projects and worktrees", () => {
  const { badges, update } = badgeHarness();
  update({
    workspaces: [
      workspace("first", [
        session("done"),
        session("read", { hasUnseenUpdate: false }),
        session("running", { status: "running" }),
        session("failed", { status: "failed" }),
        session("archived", { archivedAt: "2026-11-22T10:01:00.000Z" }),
      ]),
      workspace("second", [session("done")]),
      { ...workspace("worktree", [session("done")]), kind: "worktree", rootWorkspaceId: "first" },
    ],
  });
  expect(badges).toEqual(["3"]);
});

test("updates on completion, reading, archiving and workspace removal", () => {
  const { badges, update } = badgeHarness();
  const first = session("first");
  const second = session("second");
  const publish = (sessions: SessionRecord[]) =>
    update({ workspaces: [workspace("project", sessions)] });
  publish([
    { ...first, status: "running" },
    { ...second, status: "running" },
  ]);
  publish([first, { ...second, status: "running" }]);
  publish([first, second]);
  publish([first, second]); // Repeated state publication counts chats, not completion events.
  publish([{ ...first, hasUnseenUpdate: false }, second]);
  publish([
    { ...first, hasUnseenUpdate: false },
    { ...second, archivedAt: "2026-11-22T10:01:00.000Z" },
  ]);
  publish([first, second]);
  update({ workspaces: [] });
  expect(badges).toEqual(["", "1", "2", "1", "", "2", ""]);
});

test("a new run removes that chat until it finishes again", () => {
  const { badges, update } = badgeHarness();
  const completed = session("done");
  update({ workspaces: [workspace("project", [completed])] });
  update({ workspaces: [workspace("project", [{ ...completed, status: "running" }])] });
  update({ workspaces: [workspace("project", [completed])] });
  expect(badges).toEqual(["1", "", "1"]);
});

test("clears a stale badge for an empty profile", () => {
  const { badges, update } = badgeHarness();
  update({ workspaces: [] });
  expect(badges).toEqual([""]);
});

test("supports platforms without a macOS Dock", () => {
  const update = createDockBadgeUpdater(undefined);
  expect(() => update({ workspaces: [workspace("project", [session("done")])] })).not.toThrow();
});
