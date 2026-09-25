import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  assertScheduledTaskSchedule,
  assertScheduledTaskTarget,
  hostTimeZone,
  parseClockTime,
  parseWeekday,
  type CreateScheduledTaskInput,
  type ScheduledTaskSchedule,
  type ScheduledTaskStatus,
  type UpdateScheduledTaskInput,
  type Weekday,
} from "../../contracts/scheduled-tasks";

export const createScheduledTaskToolName = "create_scheduled_task";
export const createScheduledTaskAction = "pi_gui_create_scheduled_task";
export const listScheduledTasksToolName = "list_scheduled_tasks";
export const listScheduledTasksAction = "pi_gui_list_scheduled_tasks";
export const updateScheduledTaskToolName = "update_scheduled_task";
export const updateScheduledTaskAction = "pi_gui_update_scheduled_task";

export interface CreateScheduledTaskToolDetails {
  readonly action: typeof createScheduledTaskAction;
  readonly taskId?: string;
  readonly title?: string;
  readonly nextRunAt?: string;
  readonly error?: string;
}

export interface ListScheduledTasksToolDetails {
  readonly action: typeof listScheduledTasksAction;
  readonly tasks?: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly nextRunAt?: string;
    readonly target: string;
  }[];
  readonly error?: string;
}

export interface UpdateScheduledTaskToolDetails {
  readonly action: typeof updateScheduledTaskAction;
  readonly taskId: string;
  readonly status?: string;
  readonly nextRunAt?: string;
  readonly error?: string;
}

export interface ScheduledTaskRuntimeBridge {
  readonly createScheduledTask: (
    ctx: ExtensionContext,
    input: CreateScheduledTaskInput,
  ) => Promise<AgentToolResult<CreateScheduledTaskToolDetails>>;
  readonly listScheduledTasks: (
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<ListScheduledTasksToolDetails>>;
  readonly updateScheduledTask: (
    ctx: ExtensionContext,
    input: ScheduledTaskToolUpdate,
  ) => Promise<AgentToolResult<UpdateScheduledTaskToolDetails>>;
}

export interface ScheduledTaskToolUpdate {
  readonly taskId: string;
  readonly patch: UpdateScheduledTaskInput;
  /** Applies the tool's schedule fields on top of the task's current schedule. */
  readonly resolveSchedule?: (existing: ScheduledTaskSchedule) => ScheduledTaskSchedule;
}

type ScheduledToolDetails =
  CreateScheduledTaskToolDetails | ListScheduledTasksToolDetails | UpdateScheduledTaskToolDetails;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringParam(params: unknown, key: string): string | undefined {
  if (!isRecord(params) || typeof params[key] !== "string") {
    return undefined;
  }
  const value = params[key].trim();
  return value || undefined;
}

function parseRepeatSchedule(params: unknown): CreateScheduledTaskInput["schedule"] {
  if (!isRecord(params)) {
    throw new Error("create_scheduled_task requires schedule fields.");
  }
  const repeat = stringParam(params, "repeat") ?? stringParam(params, "kind");
  const timeZone =
    stringParam(params, "timezone") ?? stringParam(params, "timeZone") ?? hostTimeZone();
  if (repeat === "once") {
    const at = stringParam(params, "at");
    return assertScheduledTaskSchedule({ kind: "once", at });
  }
  if (repeat === "interval") {
    const everyMinutes = params.every_minutes ?? params.everyMinutes;
    const everyMs =
      typeof everyMinutes === "number"
        ? Math.round(everyMinutes * 60_000)
        : typeof params.everyMs === "number"
          ? params.everyMs
          : undefined;
    return assertScheduledTaskSchedule({ kind: "interval", everyMs });
  }
  const clock = parseClockTime(params.time) ?? {
    hour: typeof params.hour === "number" ? params.hour : undefined,
    minute: typeof params.minute === "number" ? params.minute : undefined,
  };
  if (repeat === "weekly") {
    const days = Array.isArray(params.days)
      ? params.days
          .map((entry) => parseWeekday(entry))
          .filter((entry): entry is Weekday => entry !== undefined)
      : [];
    return assertScheduledTaskSchedule({
      kind: "weekly",
      days,
      hour: clock.hour,
      minute: clock.minute,
      timeZone,
    });
  }
  if (repeat === "daily" || repeat === undefined) {
    return assertScheduledTaskSchedule({
      kind: "daily",
      hour: clock.hour,
      minute: clock.minute,
      timeZone,
    });
  }
  throw new Error("repeat must be once, daily, weekly, or interval.");
}

function parseTarget(
  params: unknown,
  fallbackWorkspaceId: string | undefined,
): CreateScheduledTaskInput["target"] {
  const workspaceId =
    stringParam(params, "workspace_id") ??
    stringParam(params, "workspaceId") ??
    fallbackWorkspaceId;
  const sessionId = stringParam(params, "session_id") ?? stringParam(params, "sessionId");
  if (sessionId) {
    return assertScheduledTaskTarget({
      kind: "existing-thread",
      workspaceId,
      sessionId,
    });
  }
  return assertScheduledTaskTarget({
    kind: "new-thread",
    workspaceId,
  });
}

function parseStatus(value: unknown): ScheduledTaskStatus | undefined {
  return value === "active" || value === "paused" || value === "completed" ? value : undefined;
}

function parseCreateInput(
  params: unknown,
  fallbackWorkspaceId: string | undefined,
): CreateScheduledTaskInput {
  const title = stringParam(params, "title");
  const instruction =
    stringParam(params, "instruction") ??
    stringParam(params, "prompt") ??
    stringParam(params, "what");
  if (!title || !instruction) {
    throw new Error("create_scheduled_task requires title and instruction.");
  }
  return {
    title,
    instruction,
    schedule: parseRepeatSchedule(params),
    target: parseTarget(params, fallbackWorkspaceId),
  };
}

function parseUpdate(taskId: string, params: unknown): ScheduledTaskToolUpdate {
  if (!isRecord(params)) {
    return { taskId, patch: {} };
  }
  const patch: UpdateScheduledTaskInput = {
    ...(stringParam(params, "title") ? { title: stringParam(params, "title") } : {}),
    ...(stringParam(params, "instruction") || stringParam(params, "prompt")
      ? { instruction: stringParam(params, "instruction") ?? stringParam(params, "prompt") }
      : {}),
    ...(parseStatus(params.status) ? { status: parseStatus(params.status) } : {}),
  };
  const hasSchedule =
    stringParam(params, "repeat") ||
    stringParam(params, "kind") ||
    params.time !== undefined ||
    params.days !== undefined ||
    params.every_minutes !== undefined ||
    params.at !== undefined ||
    params.timezone !== undefined;
  const withTarget =
    stringParam(params, "workspace_id") || stringParam(params, "session_id")
      ? { ...patch, target: parseTarget(params, stringParam(params, "workspace_id")) }
      : patch;
  return hasSchedule
    ? {
        taskId,
        patch: withTarget,
        resolveSchedule: (existing) => parseRepeatSchedule(mergeScheduleFields(existing, params)),
      }
    : { taskId, patch: withTarget };
}

/**
 * Fill the schedule fields an update leaves out from the task's current schedule, so
 * "move it to 9:00" keeps a weekly task's days and time zone. Without an explicit repeat,
 * days, every_minutes and at imply weekly, interval and once.
 */
function mergeScheduleFields(
  existing: ScheduledTaskSchedule,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const repeat =
    stringParam(params, "repeat") ??
    stringParam(params, "kind") ??
    (params.days !== undefined
      ? "weekly"
      : params.every_minutes !== undefined
        ? "interval"
        : params.at !== undefined
          ? "once"
          : existing.kind);
  const usesClock = repeat === "daily" || repeat === "weekly";
  if (!usesClock && (params.time !== undefined || params.timezone !== undefined)) {
    throw new Error(`time and timezone do not apply to a ${repeat} schedule; pass repeat.`);
  }
  const merged: Record<string, unknown> = { ...params, repeat };
  if (repeat === "once" && existing.kind === "once" && params.at === undefined) {
    merged.at = existing.at;
  }
  if (
    repeat === "interval" &&
    existing.kind === "interval" &&
    params.every_minutes === undefined &&
    params.everyMinutes === undefined &&
    params.everyMs === undefined
  ) {
    merged.everyMs = existing.everyMs;
  }
  if ((repeat === "daily" || repeat === "weekly") && "timeZone" in existing) {
    if (params.time === undefined && params.hour === undefined && params.minute === undefined) {
      merged.hour = existing.hour;
      merged.minute = existing.minute;
    }
    if (params.timezone === undefined && params.timeZone === undefined) {
      merged.timeZone = existing.timeZone;
    }
  }
  if (repeat === "weekly" && existing.kind === "weekly" && params.days === undefined) {
    merged.days = existing.days;
  }
  return merged;
}

function createCreateScheduledTaskTool(
  bridge: ScheduledTaskRuntimeBridge,
  fallbackWorkspaceId: (ctx: ExtensionContext) => string | undefined,
): ToolDefinition<any, ScheduledToolDetails> {
  return {
    name: createScheduledTaskToolName,
    label: "Create scheduled task",
    description:
      "Create a local pi-gui scheduled task that runs on this device while the app is open.",
    promptSnippet:
      "create_scheduled_task: save a local recurring or one-shot pi-gui task after interviewing the user.",
    promptGuidelines: [
      "Interview the user first. Call create_scheduled_task only when you know the title, instruction, and timing.",
      "Scheduled tasks run on this device while pi-gui is open. There is no cloud scheduler.",
      "Use repeat once, daily, weekly, or interval. Weekly needs days like ['mon','wed','fri'] and time '21:00'. Interval uses every_minutes.",
      "Omit session_id to start a new thread on each run. Pass session_id to keep using the current thread.",
    ],
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
        instruction: {
          type: "string",
          description: "What pi should do when the task runs.",
        },
        repeat: {
          type: "string",
          description: "once, daily, weekly, or interval.",
        },
        at: { type: "string", description: "ISO timestamp for a one-shot run." },
        time: { type: "string", description: "HH:MM local time for daily or weekly runs." },
        days: {
          type: "array",
          items: { type: "string" },
          description: "Weekdays for weekly runs, e.g. mon, wed, fri.",
        },
        every_minutes: {
          type: "number",
          description: "Interval in minutes for repeat=interval. Minimum 1.",
        },
        timezone: { type: "string", description: "IANA timezone. Defaults to this device." },
        workspace_id: {
          type: "string",
          description: "Workspace id. Defaults to the current folder.",
        },
        session_id: {
          type: "string",
          description: "Existing thread id. Omit to run in a new thread each time.",
        },
      },
      required: ["title", "instruction", "repeat"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const input = parseCreateInput(params, fallbackWorkspaceId(ctx));
        return bridge.createScheduledTask(ctx, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { action: createScheduledTaskAction, error: message },
        };
      }
    },
  };
}

function createListScheduledTasksTool(
  bridge: ScheduledTaskRuntimeBridge,
): ToolDefinition<any, ScheduledToolDetails> {
  return {
    name: listScheduledTasksToolName,
    label: "List scheduled tasks",
    description: "List local pi-gui scheduled tasks on this device.",
    promptSnippet: "list_scheduled_tasks: list saved local pi-gui schedules.",
    promptGuidelines: ["Use list_scheduled_tasks before updating a task if you need the task id."],
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return bridge.listScheduledTasks(ctx);
    },
  };
}

function createUpdateScheduledTaskTool(
  bridge: ScheduledTaskRuntimeBridge,
): ToolDefinition<any, ScheduledToolDetails> {
  return {
    name: updateScheduledTaskToolName,
    label: "Update scheduled task",
    description: "Update, pause, resume, or complete a local pi-gui scheduled task.",
    promptSnippet: "update_scheduled_task: change a saved local schedule by task id.",
    promptGuidelines: [
      "Use a task_id returned by list_scheduled_tasks or create_scheduled_task.",
      "Set status to paused, active, or completed.",
    ],
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Scheduled task id." },
        title: { type: "string" },
        instruction: { type: "string" },
        status: { type: "string", description: "active, paused, or completed." },
        repeat: { type: "string" },
        at: { type: "string" },
        time: { type: "string" },
        days: { type: "array", items: { type: "string" } },
        every_minutes: { type: "number" },
        timezone: { type: "string" },
        workspace_id: { type: "string" },
        session_id: { type: "string" },
      },
      required: ["task_id"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskId = stringParam(params, "task_id") ?? stringParam(params, "taskId");
      if (!taskId) {
        return {
          content: [{ type: "text", text: "update_scheduled_task requires task_id." }],
          details: {
            action: updateScheduledTaskAction,
            taskId: "",
            error: "update_scheduled_task requires task_id.",
          },
        };
      }
      try {
        return bridge.updateScheduledTask(ctx, parseUpdate(taskId, params));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { action: updateScheduledTaskAction, taskId, error: message },
        };
      }
    },
  };
}

export function createScheduledTaskRuntimeTools(
  bridge: ScheduledTaskRuntimeBridge,
  fallbackWorkspaceId: (ctx: ExtensionContext) => string | undefined,
): readonly ToolDefinition<any, ScheduledToolDetails>[] {
  return [
    createCreateScheduledTaskTool(bridge, fallbackWorkspaceId),
    createListScheduledTasksTool(bridge),
    createUpdateScheduledTaskTool(bridge),
  ];
}

export function createScheduledTaskRuntimeExtension(
  bridge: ScheduledTaskRuntimeBridge,
  fallbackWorkspaceId: (ctx: ExtensionContext) => string | undefined,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createScheduledTaskRuntimeTools(bridge, fallbackWorkspaceId)) {
      pi.registerTool(tool);
    }
  };
}
