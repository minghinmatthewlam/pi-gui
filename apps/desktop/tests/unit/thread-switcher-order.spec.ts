import { expect, test } from "@playwright/test";
import type { SessionRecord } from "../../contracts/desktop-state";
import type { ThreadListEntry } from "../../src/features/threads/thread-groups";
import {
  orderThreadSwitcherEntries,
  THREAD_SWITCHER_ORDER_LIMIT,
  touchThreadSwitcherOrder,
} from "../../src/features/threads/thread-switcher-order";

function entry(workspaceId: string, sessionId: string): ThreadListEntry {
  const session: SessionRecord = {
    id: sessionId,
    title: sessionId,
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
  return {
    folderId: workspaceId,
    workspaceId,
    session,
    environment: { kind: "local", label: "Local" },
    contextLabel: workspaceId,
  };
}

const keys = (entries: readonly ThreadListEntry[]) =>
  entries.map((item) => `${item.workspaceId}:${item.session.id}`);

test("touching a thread moves it to the front once", () => {
  expect(touchThreadSwitcherOrder([], "w:a")).toEqual(["w:a"]);
  expect(touchThreadSwitcherOrder(["w:a", "w:b", "w:c"], "w:c")).toEqual(["w:c", "w:a", "w:b"]);
  const unchanged = ["w:a", "w:b"];
  expect(touchThreadSwitcherOrder(unchanged, "w:a")).toBe(unchanged);
});

test("the stored order is capped", () => {
  const full = Array.from({ length: THREAD_SWITCHER_ORDER_LIMIT }, (_, index) => `w:${index}`);
  const next = touchThreadSwitcherOrder(full, "w:new");
  expect(next).toHaveLength(THREAD_SWITCHER_ORDER_LIMIT);
  expect(next[0]).toBe("w:new");
  expect(next).not.toContain(`w:${THREAD_SWITCHER_ORDER_LIMIT - 1}`);
});

test("used threads come first, then the rest in sidebar recency order", () => {
  const recencyOrder = [entry("w", "a"), entry("w", "b"), entry("x", "c"), entry("w", "d")];
  expect(keys(orderThreadSwitcherEntries(recencyOrder, ["w:d", "x:c"]))).toEqual([
    "w:d",
    "x:c",
    "w:a",
    "w:b",
  ]);
});

test("archived or deleted threads in the stored order are skipped", () => {
  // Archived threads are not in the sidebar's recency order.
  const recencyOrder = [entry("w", "a"), entry("w", "b")];
  expect(keys(orderThreadSwitcherEntries(recencyOrder, ["w:gone", "w:b", "w:a"]))).toEqual([
    "w:b",
    "w:a",
  ]);
});
