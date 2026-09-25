import { expect, test } from "@playwright/test";
import type { SessionRef, SessionSnapshot, WorkspaceRef } from "@pi-gui/session-driver";
import type {
  DesktopAppState,
  SessionRecord,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import type { ScheduledTaskRecord } from "../../contracts/scheduled-tasks";
import {
  createScheduledTaskOwner,
  type ScheduledTaskOwnerHost,
} from "../../electron/scheduled-tasks/app-store-scheduled-tasks";

const workspaceId = "ws-1";
const sessionId = "session-1";
const sessionRef: SessionRef = { workspaceId, sessionId };
const workspaceRef: WorkspaceRef = { workspaceId, path: "/tmp" };

interface ScheduledTaskTestHost extends ScheduledTaskOwnerHost {
  tasks: ScheduledTaskRecord[];
  deliverCalls: { readonly sessionRef: SessionRef; readonly text: string }[];
  transcripts: Map<string, TranscriptMessage[]>;
}

function sessionRecord(status: SessionRecord["status"] = "idle"): SessionRecord {
  return {
    id: sessionId,
    title: "Target",
    updatedAt: "2026-09-21T12:00:00.000Z",
    preview: "",
    status,
    hasUnseenUpdate: false,
  };
}

function dueIntervalTask(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: "task-1",
    title: "Ping",
    instruction: "Say ping",
    status: "active",
    schedule: { kind: "interval", everyMs: 60_000 },
    target: { kind: "existing-thread", workspaceId, sessionId },
    createdAt: "2026-09-21T11:00:00.000Z",
    updatedAt: "2026-09-21T11:00:00.000Z",
    nextRunAt: "2026-09-21T12:00:00.000Z",
    runs: [],
    ...overrides,
  };
}

function snapshotFrom(host: ScheduledTaskTestHost, lastError?: string): DesktopAppState {
  return {
    scheduledTasks: host.tasks,
    lastError,
  } as DesktopAppState;
}

function createHost(
  options: {
    readonly tasks?: ScheduledTaskRecord[];
    readonly sessionStatus?: SessionRecord["status"];
    readonly deliver?: (sessionRef: SessionRef, text: string) => Promise<string | undefined>;
  } = {},
): ScheduledTaskTestHost {
  const host: ScheduledTaskTestHost = {
    tasks: [...(options.tasks ?? [])],
    deliverCalls: [],
    transcripts: new Map(),
    driver: {
      createSession: async () => {
        throw new Error("createSession should not run in these tests");
      },
    },
    initialize: async () => undefined,
    scheduledTasks: () => host.tasks,
    replaceScheduledTasks: (tasks) => {
      host.tasks = [...tasks];
    },
    persistScheduledTasks: async () => undefined,
    rescheduleScheduledTasks: () => undefined,
    canWriteScheduledTasks: () => true,
    emit: () => snapshotFrom(host),
    refreshState: async () => snapshotFrom(host),
    withError: async (error) =>
      snapshotFrom(host, error instanceof Error ? error.message : String(error)),
    selectedWorkspaceId: () => workspaceId,
    selectedSessionId: () => sessionId,
    workspaces: () => [],
    workspaceRefFromState: (id) => (id === workspaceId ? workspaceRef : undefined),
    sessionFromState: (ref) =>
      ref.sessionId === sessionId ? sessionRecord(options.sessionStatus) : undefined,
    createForegroundSession: async () => snapshotFrom(host),
    seedSession: (_snapshot: SessionSnapshot) => undefined,
    ensureSessionSubscription: async () => undefined,
    ensureSessionReady: async () => undefined,
    buildCreateSessionOptions: async () => ({}),
    updateComposerDraft: async () => snapshotFrom(host),
    deliverBackgroundInstruction: async (ref, text) => {
      host.deliverCalls.push({ sessionRef: ref, text });
      if (options.deliver) {
        return options.deliver(ref, text);
      }
      const message: TranscriptMessage = {
        id: "msg-1",
        kind: "message",
        role: "user",
        text,
        createdAt: "2026-09-21T12:00:00.400Z",
      };
      host.transcripts.set(`${ref.workspaceId}:${ref.sessionId}`, [message]);
      return message.id;
    },
    transcriptFor: (ref) => host.transcripts.get(`${ref.workspaceId}:${ref.sessionId}`) ?? [],
  };
  return host;
}

test("queue persist failure pauses without advancing lastRunAt or nextRunAt", async () => {
  const due = dueIntervalTask();
  const host = createHost({
    tasks: [due],
    sessionStatus: "running",
    deliver: async () => {
      throw new Error("Failed to persist queued messages");
    },
  });
  const owner = createScheduledTaskOwner(host);
  await owner.fireDueScheduledTasks(new Date("2026-09-21T12:00:01.000Z"));
  expect(host.deliverCalls).toHaveLength(1);
  expect(host.tasks).toHaveLength(1);
  expect(host.tasks[0]?.status).toBe("paused");
  expect(host.tasks[0]?.lastRunAt).toBeUndefined();
  expect(host.tasks[0]?.nextRunAt).toBeUndefined();
  expect(host.tasks[0]?.runs[0]?.outcome).toBe("failed");
  expect(host.tasks[0]?.lastError).toMatch(/persist queued messages/i);
});

test("successful fire records a started run after background delivery", async () => {
  const due = dueIntervalTask();
  const host = createHost({ tasks: [due] });
  const owner = createScheduledTaskOwner(host);
  await owner.fireDueScheduledTasks(new Date("2026-09-21T12:00:01.000Z"));
  expect(host.deliverCalls).toEqual([{ sessionRef, text: "Say ping" }]);
  expect(host.tasks[0]?.status).toBe("active");
  expect(host.tasks[0]?.lastRunAt).toBe("2026-09-21T12:00:01.000Z");
  expect(host.tasks[0]?.nextRunAt).toBe("2026-09-21T12:01:01.000Z");
  expect(host.tasks[0]?.runs[0]?.outcome).toBe("started");
});

test("a due task is claimed and persisted before its run is delivered", async () => {
  let claimSeenByDelivery: ScheduledTaskRecord | undefined;
  let persistedBeforeDelivery = 0;
  let persisted = 0;
  const host = createHost({
    tasks: [dueIntervalTask()],
    deliver: async () => {
      claimSeenByDelivery = { ...host.tasks[0]! };
      persistedBeforeDelivery = persisted;
      return undefined;
    },
  });
  host.persistScheduledTasks = async () => {
    persisted += 1;
  };
  const owner = createScheduledTaskOwner(host);
  await owner.fireDueScheduledTasks(new Date("2026-09-21T12:00:01.000Z"));
  expect(persistedBeforeDelivery).toBe(1);
  expect(claimSeenByDelivery?.lastRunAt).toBe("2026-09-21T12:00:01.000Z");
  expect(claimSeenByDelivery?.nextRunAt).toBe("2026-09-21T12:01:01.000Z");
});

test("scheduled-task tools and edits work while a fired run is still going", async () => {
  let finishRun: (() => void) | undefined;
  let runStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    runStarted = resolve;
  });
  const host = createHost({
    tasks: [dueIntervalTask()],
    deliver: () => {
      runStarted?.();
      return new Promise((resolve) => {
        finishRun = () => resolve(undefined);
      });
    },
  });
  const owner = createScheduledTaskOwner(host);
  const firing = owner.fireDueScheduledTasks(new Date("2026-09-21T12:00:01.000Z"));
  await started;
  const withinRun = <T>(work: Promise<T>) =>
    Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("blocked until the run finished")), 1_000),
      ),
    ]);
  const listed = await withinRun(owner.listScheduledTasksToolResult());
  expect(listed.details.tasks).toHaveLength(1);
  await withinRun(owner.updateScheduledTask("task-1", { status: "paused" }));
  expect(host.tasks[0]?.status).toBe("paused");
  finishRun?.();
  await firing;
  expect(host.tasks[0]?.status).toBe("paused");
  expect(host.tasks[0]?.runs.map((run) => run.outcome)).toEqual(["started"]);
});

test("the timer is re-armed once a run is claimed, not only when it finishes", async () => {
  let rescheduledDuringRun = 0;
  let rescheduled = 0;
  const host = createHost({
    tasks: [dueIntervalTask()],
    deliver: async () => {
      rescheduledDuringRun = rescheduled;
      return undefined;
    },
  });
  host.rescheduleScheduledTasks = () => {
    rescheduled += 1;
  };
  const owner = createScheduledTaskOwner(host);
  await owner.fireDueScheduledTasks(new Date("2026-09-21T12:00:01.000Z"));
  expect(rescheduledDuringRun).toBe(1);
  expect(rescheduled).toBe(2);
});

test("a failed claim save does not leave the task stuck in flight", async () => {
  const host = createHost({ tasks: [dueIntervalTask()] });
  host.persistScheduledTasks = async () => {
    throw new Error("disk full");
  };
  const owner = createScheduledTaskOwner(host);
  await expect(owner.fireDueScheduledTasks(new Date("2026-09-21T12:00:01.000Z"))).rejects.toThrow(
    "disk full",
  );
  expect(host.deliverCalls).toHaveLength(0);
  host.persistScheduledTasks = async () => undefined;
  await owner.fireDueScheduledTasks(new Date("2026-09-21T12:01:02.000Z"));
  expect(host.deliverCalls).toHaveLength(1);
});

test("a one-time task completes after delivery and can be renamed mid-run", async () => {
  let finishRun: (() => void) | undefined;
  let runStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    runStarted = resolve;
  });
  const host = createHost({
    tasks: [
      dueIntervalTask({
        schedule: { kind: "once", at: "2026-09-21T12:00:00.000Z" },
      }),
    ],
    deliver: () => {
      runStarted?.();
      return new Promise((resolve) => {
        finishRun = () => resolve(undefined);
      });
    },
  });
  const owner = createScheduledTaskOwner(host);
  const firing = owner.fireDueScheduledTasks(new Date("2026-09-21T12:00:01.000Z"));
  await started;
  const renamed = await owner.updateScheduledTask("task-1", { title: "Renamed" });
  expect(renamed.lastError).toBeUndefined();
  expect(host.tasks[0]?.status).toBe("active");
  finishRun?.();
  await firing;
  expect(host.tasks[0]?.title).toBe("Renamed");
  expect(host.tasks[0]?.status).toBe("completed");
  expect(host.tasks[0]?.runs.map((run) => run.outcome)).toEqual(["started"]);
});

test("invalid timeZone pauses a due task without delivering", async () => {
  const host = createHost({
    tasks: [
      dueIntervalTask({
        schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "Not/A_Zone" },
      }),
    ],
  });
  const owner = createScheduledTaskOwner(host);
  await owner.fireDueScheduledTasks(new Date("2026-09-21T12:00:01.000Z"));
  expect(host.deliverCalls).toHaveLength(0);
  expect(host.tasks[0]?.status).toBe("paused");
  expect(host.tasks[0]?.lastRunAt).toBeUndefined();
  expect(host.tasks[0]?.nextRunAt).toBeUndefined();
});

test("past once create is rejected", async () => {
  const host = createHost();
  const owner = createScheduledTaskOwner(host);
  const state = await owner.createScheduledTask({
    title: "Late",
    instruction: "Too late",
    schedule: { kind: "once", at: "2020-01-01T00:00:00.000Z" },
    target: { kind: "existing-thread", workspaceId, sessionId },
  });
  expect(state.lastError).toMatch(/future/i);
  expect(host.tasks).toHaveLength(0);
});

test("title-only update keeps timezone and nextRunAt", async () => {
  const nextRunAt = "2026-09-22T16:00:00.000Z";
  const host = createHost({
    tasks: [
      dueIntervalTask({
        schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "America/Los_Angeles" },
        nextRunAt,
      }),
    ],
  });
  const owner = createScheduledTaskOwner(host);
  await owner.updateScheduledTask("task-1", { title: "Renamed ping" });
  expect(host.tasks[0]?.title).toBe("Renamed ping");
  expect(host.tasks[0]?.schedule).toEqual({
    kind: "daily",
    hour: 9,
    minute: 0,
    timeZone: "America/Los_Angeles",
  });
  expect(host.tasks[0]?.nextRunAt).toBe(nextRunAt);
});
