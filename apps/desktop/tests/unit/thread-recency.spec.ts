import { expect, test } from "@playwright/test";
import { desktopCommands, getDesktopCommandFromShortcut } from "../../contracts/ipc";
import {
  compareByRecency,
  recencyBucketId,
  sessionLastInteractedAt,
} from "../../contracts/thread-recency";

const now = new Date(2026, 8, 21, 15, 30, 0);
const nowMs = now.getTime();
const todayStart = new Date(2026, 8, 21).getTime();
const last7Start = new Date(2026, 8, 14).getTime();
const last30Start = new Date(2026, 7, 22).getTime();

test("uses lastInteractedAt when present and otherwise catalog updatedAt", () => {
  expect(
    sessionLastInteractedAt({
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastInteractedAt: "2026-09-21T00:00:00.000Z",
    }),
  ).toBe("2026-09-21T00:00:00.000Z");
  expect(sessionLastInteractedAt({ updatedAt: "2026-01-01T00:00:00.000Z" })).toBe(
    "2026-01-01T00:00:00.000Z",
  );
});

test("cuts recency buckets on local calendar midnights", () => {
  expect(recencyBucketId(new Date(todayStart).toISOString(), nowMs)).toBe("today");
  expect(recencyBucketId(new Date(nowMs).toISOString(), nowMs)).toBe("today");
  expect(recencyBucketId(new Date(todayStart - 1).toISOString(), nowMs)).toBe("last-7-days");
  expect(recencyBucketId(new Date(last7Start).toISOString(), nowMs)).toBe("last-7-days");
  expect(recencyBucketId(new Date(last7Start - 1).toISOString(), nowMs)).toBe("last-30-days");
  expect(recencyBucketId(new Date(last30Start).toISOString(), nowMs)).toBe("last-30-days");
  expect(recencyBucketId(new Date(last30Start - 1).toISOString(), nowMs)).toBe("older");
  expect(recencyBucketId("not-a-timestamp", nowMs)).toBe("older");
});

test("sorts by last interaction then title, ignoring lastViewedAt", () => {
  const alpha = {
    title: "Alpha",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastInteractedAt: "2026-09-10T00:00:00.000Z",
    lastViewedAt: "2026-09-21T00:00:00.000Z",
  };
  const bravo = {
    title: "Bravo",
    updatedAt: "2026-09-20T00:00:00.000Z",
    lastInteractedAt: "2026-09-20T00:00:00.000Z",
    lastViewedAt: "2026-09-02T00:00:00.000Z",
  };
  expect(compareByRecency(bravo, alpha)).toBeLessThan(0);
  expect(compareByRecency({ ...alpha, title: "Zed" }, { ...alpha, title: "Ace" })).toBeGreaterThan(
    0,
  );
});

test("maps unmodified digit shortcuts onto recency commands in order", () => {
  expect(getDesktopCommandFromShortcut({ modifier: true, shift: false, key: "1" })).toBe(
    desktopCommands.selectRecentThread1,
  );
  expect(
    getDesktopCommandFromShortcut({
      modifier: true,
      shift: false,
      key: "Unidentified",
      code: "Digit9",
    }),
  ).toBe(desktopCommands.selectRecentThread9);
  expect(getDesktopCommandFromShortcut({ modifier: true, shift: true, key: "1" })).toBeUndefined();
});
