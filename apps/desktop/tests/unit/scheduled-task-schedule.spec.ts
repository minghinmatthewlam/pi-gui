import { expect, test } from "@playwright/test";
import {
  nextRunAt,
  earliestScheduledWakeAt,
} from "../../electron/scheduled-tasks/scheduled-task-schedule";
import {
  formatScheduledTaskRecurrence,
  formatScheduledTaskNextRun,
  onceActivationNeedsNewTime,
  scheduledOriginsByMessageId,
  type ScheduledTaskRecord,
} from "../../contracts/scheduled-tasks";

test("nextRunAt advances daily and weekly wall-clock times in the given zone", () => {
  const from = new Date("2026-09-21T16:00:00.000Z");
  expect(
    nextRunAt({ kind: "daily", hour: 9, minute: 0, timeZone: "America/Los_Angeles" }, from),
  ).toBe("2026-09-22T16:00:00.000Z");
  expect(
    nextRunAt(
      {
        kind: "weekly",
        days: [1, 3, 5],
        hour: 22,
        minute: 0,
        timeZone: "America/Los_Angeles",
      },
      from,
    ),
  ).toBe("2026-09-22T05:00:00.000Z");
});

test("nextRunAt for interval is claim-clock plus everyMs, and once past has no next", () => {
  const from = new Date("2026-09-21T12:00:00.000Z");
  expect(nextRunAt({ kind: "interval", everyMs: 10 * 60_000 }, from)).toBe(
    "2026-09-21T12:10:00.000Z",
  );
  expect(nextRunAt({ kind: "once", at: "2026-09-21T11:00:00.000Z" }, from)).toBeUndefined();
  expect(nextRunAt({ kind: "once", at: "2026-09-21T13:00:00.000Z" }, from)).toBe(
    "2026-09-21T13:00:00.000Z",
  );
});

test("earliestScheduledWakeAt uses due-now for overdue active tasks", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  expect(
    earliestScheduledWakeAt([{ status: "active", nextRunAt: "2026-09-21T11:00:00.000Z" }], now),
  ).toBe(now.toISOString());
  expect(
    earliestScheduledWakeAt([{ status: "paused", nextRunAt: "2026-09-21T11:00:00.000Z" }], now),
  ).toBeUndefined();
});

test("recurrence and next-run copy match the list format", () => {
  expect(
    formatScheduledTaskRecurrence({
      kind: "weekly",
      days: [1, 3, 5],
      hour: 22,
      minute: 0,
      timeZone: "UTC",
    }),
  ).toBe("Mon, Wed, and Fri at 10:00 PM");
  expect(formatScheduledTaskRecurrence({ kind: "interval", everyMs: 10 * 60_000 })).toBe(
    "Every 10 minutes",
  );
  expect(
    formatScheduledTaskNextRun("2026-09-22T12:00:00.000Z", new Date("2026-09-21T12:00:00.000Z")),
  ).toBe("Next run in 1 day");
});

test("overlay matches unmatched runs by instruction and firedAt window", () => {
  const task: ScheduledTaskRecord = {
    id: "task-1",
    title: "Ping",
    instruction: "Say ping",
    status: "completed",
    schedule: { kind: "once", at: "2026-09-21T12:00:00.000Z" },
    target: { kind: "new-thread", workspaceId: "ws" },
    createdAt: "2026-09-21T11:00:00.000Z",
    updatedAt: "2026-09-21T12:00:01.000Z",
    completedAt: "2026-09-21T12:00:01.000Z",
    runs: [
      {
        id: "run-1",
        sessionId: "session-1",
        workspaceId: "ws",
        firedAt: "2026-09-21T12:00:00.000Z",
        instruction: "Say ping",
        outcome: "started",
      },
    ],
  };
  const origins = scheduledOriginsByMessageId([task], "ws", "session-1", [
    {
      id: "msg-1",
      kind: "message",
      role: "user",
      text: "Say ping",
      createdAt: "2026-09-21T12:00:00.400Z",
    },
  ]);
  expect(origins.get("msg-1")).toEqual({ taskId: "task-1", title: "Ping" });
});

test("overlay does not label a same-text user message from before firedAt", () => {
  const task: ScheduledTaskRecord = {
    id: "task-1",
    title: "Ping",
    instruction: "Say ping",
    status: "completed",
    schedule: { kind: "once", at: "2026-09-21T12:00:00.000Z" },
    target: { kind: "new-thread", workspaceId: "ws" },
    createdAt: "2026-09-21T11:00:00.000Z",
    updatedAt: "2026-09-21T12:00:01.000Z",
    completedAt: "2026-09-21T12:00:01.000Z",
    runs: [
      {
        id: "run-1",
        sessionId: "session-1",
        workspaceId: "ws",
        firedAt: "2026-09-21T12:00:00.000Z",
        instruction: "Say ping",
        outcome: "started",
      },
    ],
  };
  const origins = scheduledOriginsByMessageId([task], "ws", "session-1", [
    {
      id: "msg-prior",
      kind: "message",
      role: "user",
      text: "Say ping",
      createdAt: "2026-09-21T11:59:59.000Z",
    },
  ]);
  expect(origins.has("msg-prior")).toBe(false);
});

test("onceActivationNeedsNewTime blocks resume of a claimed past once", () => {
  expect(
    onceActivationNeedsNewTime(
      { kind: "once", at: "2026-09-21T12:00:00.000Z" },
      "2026-09-21T12:00:01.000Z",
      new Date("2026-09-21T12:05:00.000Z"),
    ),
  ).toBe(true);
  expect(
    onceActivationNeedsNewTime(
      { kind: "once", at: "2026-09-21T13:00:00.000Z" },
      undefined,
      new Date("2026-09-21T12:05:00.000Z"),
    ),
  ).toBe(false);
});
