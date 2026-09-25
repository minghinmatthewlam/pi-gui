import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
  CreateSessionOptions,
  SessionRef,
  SessionSnapshot,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import {
  MAX_SCHEDULED_TASK_RUNS,
  SCHEDULED_TASK_INTERVIEW_PROMPT,
  assertScheduledTaskSchedule,
  assertScheduledTaskTarget,
  onceActivationNeedsNewTime,
  scheduledTaskSchedulesEqual,
  type CreateScheduledTaskInput,
  type ScheduledTaskRecord,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
  type UpdateScheduledTaskInput,
} from "../../contracts/scheduled-tasks";
import type {
  CreateSessionInput,
  DesktopAppState,
  SessionRecord,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import { NEW_THREAD_PLACEHOLDER_TITLE } from "../conversation/thread-title-constants";
import type { RefreshStateOptions } from "../application/refresh-state-options";
import { nextRunAt } from "./scheduled-task-schedule";
import type {
  ScheduledTaskToolUpdate,
  CreateScheduledTaskToolDetails,
  ListScheduledTasksToolDetails,
  UpdateScheduledTaskToolDetails,
} from "./scheduled-task-runtime";

type ScheduledDriver = Pick<PiSdkDriver, "createSession">;

export interface ScheduledTaskOwnerHost {
  readonly driver: ScheduledDriver;
  initialize(): Promise<void>;
  scheduledTasks(): readonly ScheduledTaskRecord[];
  replaceScheduledTasks(tasks: readonly ScheduledTaskRecord[]): void;
  persistScheduledTasks(): Promise<void>;
  rescheduleScheduledTasks(): void;
  canWriteScheduledTasks(): boolean;
  emit(): DesktopAppState;
  refreshState(options?: RefreshStateOptions): Promise<DesktopAppState>;
  withError(error: unknown): Promise<DesktopAppState>;
  selectedWorkspaceId(): string;
  selectedSessionId(): string;
  workspaces(): DesktopAppState["workspaces"];
  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined;
  sessionFromState(sessionRef: SessionRef): SessionRecord | undefined;
  createForegroundSession(input: CreateSessionInput): Promise<DesktopAppState>;
  seedSession(snapshot: SessionSnapshot): void;
  ensureSessionSubscription(sessionRef: SessionRef): Promise<void>;
  ensureSessionReady(sessionRef: SessionRef): Promise<SessionSnapshot | undefined>;
  buildCreateSessionOptions(workspaceId: string): Promise<CreateSessionOptions | undefined>;
  updateComposerDraft(sessionRef: SessionRef, draft: string): Promise<DesktopAppState>;
  deliverBackgroundInstruction(sessionRef: SessionRef, text: string): Promise<string | undefined>;
  transcriptFor(sessionRef: SessionRef): readonly TranscriptMessage[];
}

export interface ScheduledTaskOwner {
  createScheduledTask(input: CreateScheduledTaskInput): Promise<DesktopAppState>;
  updateScheduledTask(id: string, patch: UpdateScheduledTaskInput): Promise<DesktopAppState>;
  deleteScheduledTask(id: string): Promise<DesktopAppState>;
  beginScheduledTaskInterview(): Promise<DesktopAppState>;
  fireDueScheduledTasks(now?: Date): Promise<DesktopAppState>;
  createScheduledTaskToolResult(
    parentRef: SessionRef,
    input: CreateScheduledTaskInput,
  ): Promise<AgentToolResult<CreateScheduledTaskToolDetails>>;
  listScheduledTasksToolResult(): Promise<AgentToolResult<ListScheduledTasksToolDetails>>;
  updateScheduledTaskToolResult(
    input: ScheduledTaskToolUpdate,
  ): Promise<AgentToolResult<UpdateScheduledTaskToolDetails>>;
}

const inFlightTaskIds = new Set<string>();

export function isScheduledTaskInFlight(taskId: string): boolean {
  return inFlightTaskIds.has(taskId);
}
let mutationTail: Promise<void> = Promise.resolve();

function enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(work, work);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function cloneTask(task: ScheduledTaskRecord): ScheduledTaskRecord {
  return {
    ...task,
    schedule:
      task.schedule.kind === "weekly"
        ? { ...task.schedule, days: [...task.schedule.days] }
        : { ...task.schedule },
    target: { ...task.target },
    runs: task.runs.map((run) => ({ ...run })),
  };
}

function appendRun(task: ScheduledTaskRecord, run: ScheduledTaskRun): ScheduledTaskRecord {
  return {
    ...task,
    runs: [...task.runs, run].slice(-MAX_SCHEDULED_TASK_RUNS),
  };
}

function bindingConflict(
  tasks: readonly ScheduledTaskRecord[],
  target: CreateScheduledTaskInput["target"],
  ignoreId?: string,
): boolean {
  if (target.kind !== "existing-thread") {
    return false;
  }
  return tasks.some(
    (task) =>
      task.id !== ignoreId &&
      task.status !== "completed" &&
      task.target.kind === "existing-thread" &&
      task.target.sessionId === target.sessionId,
  );
}

function nextRunOrUndefined(schedule: ScheduledTaskSchedule, from: Date): string | undefined {
  try {
    return nextRunAt(schedule, from);
  } catch {
    return undefined;
  }
}

function missingNextRunError(schedule: ScheduledTaskSchedule): string {
  return schedule.kind === "once"
    ? "One-time tasks must be scheduled in the future."
    : "Scheduled task has no next run.";
}

function isClaimable(task: ScheduledTaskRecord, now: Date): boolean {
  if (task.status !== "active" || !task.nextRunAt) {
    return false;
  }
  if (Date.parse(task.nextRunAt) > now.getTime()) {
    return false;
  }
  if (task.schedule.kind === "once" && task.lastRunAt) {
    return false;
  }
  return true;
}

function isDue(task: ScheduledTaskRecord, now: Date): boolean {
  return !inFlightTaskIds.has(task.id) && isClaimable(task, now);
}

function lastUserMessageId(
  transcript: readonly TranscriptMessage[],
  instruction: string,
  firedAt?: string,
): string | undefined {
  const minCreatedAt = firedAt ? Date.parse(firedAt) : Number.NEGATIVE_INFINITY;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind !== "message" || item.role !== "user" || item.text !== instruction) {
      continue;
    }
    const createdAt = Date.parse(item.createdAt);
    if (Number.isNaN(createdAt) || createdAt < minCreatedAt) {
      continue;
    }
    return item.id;
  }
  return undefined;
}

function pauseWithError(task: ScheduledTaskRecord, now: Date, error: string): ScheduledTaskRecord {
  return {
    ...task,
    status: "paused",
    updatedAt: nowIso(now),
    lastError: error,
    nextRunAt: undefined,
    completedAt: undefined,
  };
}

export function createScheduledTaskOwner(store: ScheduledTaskOwnerHost): ScheduledTaskOwner {
  return {
    createScheduledTask: (input) => enqueueMutation(() => createScheduledTask(store, input)),
    updateScheduledTask: (id, patch) =>
      enqueueMutation(() => updateScheduledTask(store, id, patch)),
    deleteScheduledTask: (id) => enqueueMutation(() => deleteScheduledTask(store, id)),
    beginScheduledTaskInterview: () => enqueueMutation(() => beginScheduledTaskInterview(store)),
    fireDueScheduledTasks: (now) => fireDueScheduledTasks(store, now ?? new Date()),
    createScheduledTaskToolResult: (parentRef, input) =>
      enqueueMutation(() => createScheduledTaskToolResult(store, parentRef, input)),
    listScheduledTasksToolResult: () => enqueueMutation(() => listScheduledTasksToolResult(store)),
    updateScheduledTaskToolResult: (input) =>
      enqueueMutation(() => updateScheduledTaskToolResult(store, input)),
  };
}

async function replaceAndPersist(
  store: ScheduledTaskOwnerHost,
  tasks: readonly ScheduledTaskRecord[],
  refresh: boolean,
): Promise<DesktopAppState> {
  store.replaceScheduledTasks(tasks.map(cloneTask));
  if (store.canWriteScheduledTasks()) {
    await store.persistScheduledTasks();
  }
  if (refresh) {
    return store.refreshState({
      clearLastError: true,
      persistState: false,
      markSelectedSessionViewed: false,
    });
  }
  return store.emit();
}

async function writeTask(
  store: ScheduledTaskOwnerHost,
  updated: ScheduledTaskRecord,
): Promise<void> {
  const current = store.scheduledTasks().map(cloneTask);
  const index = current.findIndex((task) => task.id === updated.id);
  if (index < 0) {
    return;
  }
  current[index] = updated;
  store.replaceScheduledTasks(current);
  await store.persistScheduledTasks();
}

function leftoverClaimedOnce(task: ScheduledTaskRecord, now: Date): ScheduledTaskRecord {
  if (
    task.status !== "active" ||
    task.schedule.kind !== "once" ||
    !task.lastRunAt ||
    inFlightTaskIds.has(task.id)
  ) {
    return task;
  }
  const failedRun: ScheduledTaskRun | undefined =
    task.target.kind === "existing-thread"
      ? {
          id: randomUUID(),
          sessionId: task.target.sessionId,
          workspaceId: task.target.workspaceId,
          firedAt: task.lastRunAt,
          instruction: task.instruction,
          outcome: "failed",
          error: "Scheduled run did not finish.",
        }
      : undefined;
  return pauseWithError(
    failedRun ? appendRun(task, failedRun) : task,
    now,
    "Scheduled run did not finish.",
  );
}

async function createScheduledTask(
  store: ScheduledTaskOwnerHost,
  input: CreateScheduledTaskInput,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!store.canWriteScheduledTasks()) {
    return store.withError("Scheduled tasks could not be loaded; repair scheduled-tasks.json.");
  }
  const title = input.title.trim();
  const instruction = input.instruction.trim();
  if (!title || !instruction) {
    return store.withError("Scheduled tasks need a title and instructions.");
  }
  const schedule = assertScheduledTaskSchedule(input.schedule);
  const target = assertScheduledTaskTarget(input.target);
  if (!store.workspaceRefFromState(target.workspaceId)) {
    return store.withError(`Unknown workspace: ${target.workspaceId}`);
  }
  if (target.kind === "existing-thread") {
    const session = store.sessionFromState({
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
    });
    if (!session) {
      return store.withError(`Unknown session: ${target.workspaceId}:${target.sessionId}`);
    }
    if (session.archivedAt) {
      return store.withError("Cannot bind a scheduled task to an archived thread.");
    }
  }
  const current = store.scheduledTasks();
  if (bindingConflict(current, target)) {
    return store.withError("This thread already has a scheduled task.");
  }
  const now = new Date();
  const next = nextRunOrUndefined(schedule, now);
  if (!next) {
    return store.withError(missingNextRunError(schedule));
  }
  const created: ScheduledTaskRecord = {
    id: randomUUID(),
    title,
    instruction,
    status: "active",
    schedule,
    target,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    nextRunAt: next,
    ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
    runs: [],
  };
  return replaceAndPersist(store, [created, ...current], true);
}

async function updateScheduledTask(
  store: ScheduledTaskOwnerHost,
  id: string,
  patch: UpdateScheduledTaskInput,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!store.canWriteScheduledTasks()) {
    return store.withError("Scheduled tasks could not be loaded; repair scheduled-tasks.json.");
  }
  const current = store.scheduledTasks();
  const existing = current.find((task) => task.id === id);
  if (!existing) {
    return store.withError(`Unknown scheduled task: ${id}`);
  }
  const title = patch.title?.trim() ?? existing.title;
  const instruction = patch.instruction?.trim() ?? existing.instruction;
  if (!title || !instruction) {
    return store.withError("Scheduled tasks need a title and instructions.");
  }
  const schedule = patch.schedule ? assertScheduledTaskSchedule(patch.schedule) : existing.schedule;
  const target = patch.target ? assertScheduledTaskTarget(patch.target) : existing.target;
  if (!store.workspaceRefFromState(target.workspaceId)) {
    return store.withError(`Unknown workspace: ${target.workspaceId}`);
  }
  if (target.kind === "existing-thread") {
    const session = store.sessionFromState({
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
    });
    if (!session || session.archivedAt) {
      return store.withError("Cannot bind a scheduled task to a missing or archived thread.");
    }
  }
  if (bindingConflict(current, target, id)) {
    return store.withError("This thread already has a scheduled task.");
  }
  const now = new Date();
  const status = patch.status ?? existing.status;
  const scheduleChanged =
    patch.schedule !== undefined && !scheduledTaskSchedulesEqual(existing.schedule, schedule);
  let nextRunAtValue = existing.nextRunAt;
  let lastRunAt = scheduleChanged ? undefined : existing.lastRunAt;
  let completedAt = existing.completedAt;
  // A one-time run in flight holds its claim until it records its result.
  const claimInFlight = inFlightTaskIds.has(id) && !scheduleChanged;
  if (
    status === "active" &&
    !claimInFlight &&
    onceActivationNeedsNewTime(schedule, lastRunAt, now)
  ) {
    return store.withError(
      "This one-time task already claimed its run. Set a new time to run it again.",
    );
  }
  if (status === "active") {
    completedAt = undefined;
    if (!scheduleChanged && existing.status === "active" && existing.nextRunAt) {
      nextRunAtValue = existing.nextRunAt;
    } else {
      nextRunAtValue = nextRunOrUndefined(schedule, now);
      if (!nextRunAtValue) {
        return store.withError(missingNextRunError(schedule));
      }
    }
  } else {
    nextRunAtValue = undefined;
    if (status === "completed") {
      completedAt = existing.completedAt ?? nowIso(now);
    } else {
      completedAt = undefined;
    }
  }
  const updated: ScheduledTaskRecord = {
    ...existing,
    title,
    instruction,
    schedule,
    target,
    status,
    updatedAt: nowIso(now),
    ...(nextRunAtValue ? { nextRunAt: nextRunAtValue } : { nextRunAt: undefined }),
    ...(lastRunAt ? { lastRunAt } : { lastRunAt: undefined }),
    ...(completedAt ? { completedAt } : { completedAt: undefined }),
  };
  return replaceAndPersist(
    store,
    current.map((task) => (task.id === id ? updated : task)),
    true,
  );
}

async function deleteScheduledTask(
  store: ScheduledTaskOwnerHost,
  id: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!store.canWriteScheduledTasks()) {
    return store.withError("Scheduled tasks could not be loaded; repair scheduled-tasks.json.");
  }
  return replaceAndPersist(
    store,
    store.scheduledTasks().filter((task) => task.id !== id),
    true,
  );
}

async function beginScheduledTaskInterview(
  store: ScheduledTaskOwnerHost,
): Promise<DesktopAppState> {
  await store.initialize();
  const workspaceId = store.selectedWorkspaceId() || store.workspaces()[0]?.id;
  if (!workspaceId) {
    return store.withError("Open a folder before creating a scheduled task.");
  }
  const state = await store.createForegroundSession({
    workspaceId,
    title: NEW_THREAD_PLACEHOLDER_TITLE,
  });
  const sessionRef = {
    workspaceId: state.selectedWorkspaceId,
    sessionId: state.selectedSessionId,
  };
  if (!sessionRef.workspaceId || !sessionRef.sessionId) {
    return store.withError("Could not open a thread for the scheduled-task interview.");
  }
  return store.updateComposerDraft(sessionRef, SCHEDULED_TASK_INTERVIEW_PROMPT);
}

async function createBackgroundSession(
  store: ScheduledTaskOwnerHost,
  workspaceId: string,
  title: string,
): Promise<SessionRef> {
  const workspace = store.workspaceRefFromState(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  const createOptions = (await store.buildCreateSessionOptions(workspaceId)) ?? {};
  const session = await store.driver.createSession(workspace, {
    ...createOptions,
    title,
  });
  store.seedSession(session);
  await store.ensureSessionSubscription(session.ref);
  await store.refreshState({
    clearLastError: true,
    persistState: false,
    emitState: false,
    markSelectedSessionViewed: false,
    publishSelectedTranscript: false,
  });
  return session.ref;
}

async function deliverInstruction(
  store: ScheduledTaskOwnerHost,
  sessionRef: SessionRef,
  instruction: string,
  firedAt?: string,
): Promise<string | undefined> {
  const deliveredId = await store.deliverBackgroundInstruction(sessionRef, instruction);
  return lastUserMessageId(store.transcriptFor(sessionRef), instruction, firedAt) ?? deliveredId;
}

interface ClaimedScheduledRun {
  readonly task: ScheduledTaskRecord;
  readonly claimedAt: string;
  readonly firedAt: string;
  readonly sessionRef: SessionRef;
}

// Claims run inside the mutation queue and are persisted before delivery, so a
// quit mid-run cannot re-fire. Delivery then runs outside the queue: it lasts as
// long as the target's turn, and that turn may itself call the scheduled-task tools.
async function fireDueScheduledTasks(
  store: ScheduledTaskOwnerHost,
  now: Date,
): Promise<DesktopAppState> {
  const claimed = await enqueueMutation(() => claimDueScheduledTasks(store, now));
  if (!claimed) {
    return store.emit();
  }
  // Re-arm and publish now and as each run settles, so other tasks keep their times and
  // their results show during a long run.
  store.rescheduleScheduledTasks();
  store.emit();
  const settled = await Promise.allSettled(
    claimed.claims.map((claim) =>
      deliverClaimedRun(store, claim).finally(() => {
        store.rescheduleScheduledTasks();
        store.emit();
      }),
    ),
  );
  // Deliver every saved claim before reporting a failure, so one bad save costs no other run.
  const failure = settled.find((result) => result.status === "rejected");
  if (claimed.error !== undefined) throw claimed.error;
  if (failure) throw failure.reason;
  return store.refreshState({
    clearLastError: true,
    persistState: false,
    markSelectedSessionViewed: false,
  });
}

async function claimDueScheduledTasks(
  store: ScheduledTaskOwnerHost,
  now: Date,
): Promise<
  { readonly claims: readonly ClaimedScheduledRun[]; readonly error?: unknown } | undefined
> {
  await store.initialize();
  if (!store.canWriteScheduledTasks()) {
    return undefined;
  }
  const leftover = store.scheduledTasks().map((task) => leftoverClaimedOnce(task, now));
  if (leftover.some((task, index) => task !== store.scheduledTasks()[index])) {
    await replaceAndPersist(store, leftover, false);
  }

  const due = leftover.filter((task) => isDue(task, now));
  if (due.length === 0) {
    return undefined;
  }

  const claims: ClaimedScheduledRun[] = [];
  try {
    for (const dueTask of due) {
      const claimed = store.scheduledTasks().find((task) => task.id === dueTask.id);
      if (!claimed || !isClaimable(claimed, now)) {
        continue;
      }
      let advancedNext: string | undefined;
      try {
        advancedNext =
          claimed.schedule.kind === "once" ? claimed.nextRunAt : nextRunAt(claimed.schedule, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeTask(store, pauseWithError(claimed, now, message));
        continue;
      }
      if (claimed.schedule.kind !== "once" && !advancedNext) {
        await writeTask(store, pauseWithError(claimed, now, "Scheduled task has no next run."));
        continue;
      }

      const firedAt = nowIso(new Date());
      let sessionRef: SessionRef | undefined;
      try {
        if (claimed.target.kind === "new-thread") {
          sessionRef = await createBackgroundSession(
            store,
            claimed.target.workspaceId,
            claimed.title,
          );
        } else {
          sessionRef = {
            workspaceId: claimed.target.workspaceId,
            sessionId: claimed.target.sessionId,
          };
          const session = store.sessionFromState(sessionRef);
          if (!session || session.archivedAt) {
            throw new Error("Scheduled task target thread is missing or archived.");
          }
        }
      } catch (error) {
        await writeTask(store, failedRunTask(store, claimed, sessionRef, firedAt, now, error));
        continue;
      }
      const claimedAt = nowIso(now);
      await writeTask(store, {
        ...claimed,
        lastRunAt: claimedAt,
        nextRunAt: advancedNext,
        updatedAt: claimedAt,
      });
      inFlightTaskIds.add(claimed.id);
      claims.push({ task: claimed, claimedAt, firedAt, sessionRef });
    }
  } catch (error) {
    // Claims already saved are still delivered; the error is reported after them.
    return { claims, error };
  }
  return { claims };
}

async function deliverClaimedRun(
  store: ScheduledTaskOwnerHost,
  claim: ClaimedScheduledRun,
): Promise<void> {
  const { task, claimedAt, firedAt, sessionRef } = claim;
  try {
    let outcome: { readonly userMessageId?: string } | { readonly error: unknown };
    try {
      outcome = {
        userMessageId: await deliverInstruction(store, sessionRef, task.instruction, firedAt),
      };
    } catch (error) {
      outcome = { error };
    }
    await enqueueMutation(async () => {
      // The task may have been edited, paused or deleted while the run was in flight.
      const current = store.scheduledTasks().find((entry) => entry.id === task.id);
      if (!current) {
        return;
      }
      const stillClaimed = current.lastRunAt === claimedAt;
      const now = new Date(claimedAt);
      if ("error" in outcome) {
        const failed = failedRunTask(store, current, sessionRef, firedAt, now, outcome.error);
        // A run that never started gives its claim back, as if it had not fired. If the
        // task was rescheduled, paused or completed meanwhile, keep that and only record the
        // failure.
        await writeTask(
          store,
          stillClaimed && current.status === "active"
            ? { ...failed, lastRunAt: task.lastRunAt }
            : { ...current, runs: failed.runs, lastError: failed.lastError },
        );
        return;
      }
      const run: ScheduledTaskRun = {
        id: randomUUID(),
        sessionId: sessionRef.sessionId,
        workspaceId: sessionRef.workspaceId,
        firedAt,
        instruction: task.instruction,
        ...(outcome.userMessageId ? { userMessageId: outcome.userMessageId } : {}),
        outcome: "started",
      };
      const withRun = { ...appendRun(current, run), lastError: undefined };
      await writeTask(
        store,
        stillClaimed && current.status === "active" && current.schedule.kind === "once"
          ? {
              ...withRun,
              status: "completed",
              completedAt: claimedAt,
              nextRunAt: undefined,
              updatedAt: claimedAt,
            }
          : withRun,
      );
    });
  } finally {
    inFlightTaskIds.delete(task.id);
  }
}

function failedRunTask(
  store: ScheduledTaskOwnerHost,
  task: ScheduledTaskRecord,
  sessionRef: SessionRef | undefined,
  firedAt: string,
  now: Date,
  error: unknown,
): ScheduledTaskRecord {
  const message = error instanceof Error ? error.message : String(error);
  const failedMessageId = sessionRef
    ? lastUserMessageId(store.transcriptFor(sessionRef), task.instruction, firedAt)
    : undefined;
  const failedRun: ScheduledTaskRun | undefined = sessionRef
    ? {
        id: randomUUID(),
        sessionId: sessionRef.sessionId,
        workspaceId: sessionRef.workspaceId,
        firedAt,
        instruction: task.instruction,
        ...(failedMessageId ? { userMessageId: failedMessageId } : {}),
        outcome: "failed",
        error: message,
      }
    : undefined;
  return pauseWithError(failedRun ? appendRun(task, failedRun) : task, now, message);
}

async function createScheduledTaskToolResult(
  store: ScheduledTaskOwnerHost,
  parentRef: SessionRef,
  input: CreateScheduledTaskInput,
): Promise<AgentToolResult<CreateScheduledTaskToolDetails>> {
  const before = new Set(store.scheduledTasks().map((task) => task.id));
  const state = await createScheduledTask(store, {
    ...input,
    originSessionId: input.originSessionId ?? parentRef.sessionId,
  });
  const created = state.scheduledTasks.find((task) => !before.has(task.id));
  if (!created || state.lastError) {
    return {
      content: [
        {
          type: "text",
          text: state.lastError ?? "create_scheduled_task failed.",
        },
      ],
      details: {
        action: "pi_gui_create_scheduled_task",
        error: state.lastError ?? "create_scheduled_task failed.",
      },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Scheduled "${created.title}" (${created.id}). Next run ${created.nextRunAt ?? "unknown"}.`,
      },
    ],
    details: {
      action: "pi_gui_create_scheduled_task",
      taskId: created.id,
      title: created.title,
      nextRunAt: created.nextRunAt,
    },
  };
}

async function listScheduledTasksToolResult(
  store: ScheduledTaskOwnerHost,
): Promise<AgentToolResult<ListScheduledTasksToolDetails>> {
  await store.initialize();
  const tasks = store.scheduledTasks().map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    nextRunAt: task.nextRunAt,
    target:
      task.target.kind === "new-thread"
        ? `new thread in ${task.target.workspaceId}`
        : `thread ${task.target.sessionId}`,
  }));
  return {
    content: [
      {
        type: "text",
        text:
          tasks.length === 0
            ? "No scheduled tasks."
            : tasks
                .map(
                  (task) =>
                    `${task.id} · ${task.title} · ${task.status}${task.nextRunAt ? ` · ${task.nextRunAt}` : ""}`,
                )
                .join("\n"),
      },
    ],
    details: {
      action: "pi_gui_list_scheduled_tasks",
      tasks,
    },
  };
}

async function updateScheduledTaskToolResult(
  store: ScheduledTaskOwnerHost,
  input: ScheduledTaskToolUpdate,
): Promise<AgentToolResult<UpdateScheduledTaskToolDetails>> {
  let patch = input.patch;
  if (input.resolveSchedule) {
    await store.initialize();
    const existing = store.scheduledTasks().find((task) => task.id === input.taskId);
    if (existing) {
      try {
        patch = { ...patch, schedule: input.resolveSchedule(existing.schedule) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: {
            action: "pi_gui_update_scheduled_task",
            taskId: input.taskId,
            error: message,
          },
        };
      }
    }
  }
  const state = await updateScheduledTask(store, input.taskId, patch);
  const task = state.scheduledTasks.find((entry) => entry.id === input.taskId);
  if (!task || state.lastError) {
    return {
      content: [{ type: "text", text: state.lastError ?? "update_scheduled_task failed." }],
      details: {
        action: "pi_gui_update_scheduled_task",
        taskId: input.taskId,
        error: state.lastError ?? "update_scheduled_task failed.",
      },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Updated scheduled task ${task.id} (${task.status}).`,
      },
    ],
    details: {
      action: "pi_gui_update_scheduled_task",
      taskId: task.id,
      status: task.status,
      nextRunAt: task.nextRunAt,
    },
  };
}
