export const SCHEDULED_TASKS_FILE_VERSION = 1;
export const MIN_SCHEDULE_INTERVAL_MS = 60_000;
export const MAX_SCHEDULE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SCHEDULED_TASK_RUNS = 40;
export const SCHEDULED_TASK_INTERVIEW_PROMPT =
  "Let's set up a scheduled task together. First, explain how scheduled tasks work in pi-gui. Then interview me to figure out what I need scheduled and when it should run.";

export type ScheduledTaskStatus = "active" | "paused" | "completed";
export type ScheduledTaskFilter = "all" | ScheduledTaskStatus;
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ScheduledTaskSchedule =
  | { readonly kind: "once"; readonly at: string }
  | {
      readonly kind: "daily";
      readonly hour: number;
      readonly minute: number;
      readonly timeZone: string;
    }
  | {
      readonly kind: "weekly";
      readonly days: readonly Weekday[];
      readonly hour: number;
      readonly minute: number;
      readonly timeZone: string;
    }
  | { readonly kind: "interval"; readonly everyMs: number };

export type ScheduledTaskTarget =
  | { readonly kind: "new-thread"; readonly workspaceId: string }
  | { readonly kind: "existing-thread"; readonly workspaceId: string; readonly sessionId: string };

export interface ScheduledTaskRun {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly firedAt: string;
  readonly instruction: string;
  readonly userMessageId?: string;
  readonly outcome: "started" | "failed";
  readonly error?: string;
}

export interface ScheduledTaskRecord {
  readonly id: string;
  readonly title: string;
  readonly instruction: string;
  readonly status: ScheduledTaskStatus;
  readonly schedule: ScheduledTaskSchedule;
  readonly target: ScheduledTaskTarget;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly completedAt?: string;
  readonly originSessionId?: string;
  readonly lastError?: string;
  readonly runs: readonly ScheduledTaskRun[];
}

export interface CreateScheduledTaskInput {
  readonly title: string;
  readonly instruction: string;
  readonly schedule: ScheduledTaskSchedule;
  readonly target: ScheduledTaskTarget;
  readonly originSessionId?: string;
}

export interface UpdateScheduledTaskInput {
  readonly title?: string;
  readonly instruction?: string;
  readonly schedule?: ScheduledTaskSchedule;
  readonly target?: ScheduledTaskTarget;
  readonly status?: ScheduledTaskStatus;
}

export interface ScheduledTaskOrigin {
  readonly taskId: string;
  readonly title: string;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_ALIASES: Readonly<Record<string, Weekday>> = {
  sun: 0,
  sunday: 0,
  "0": 0,
  mon: 1,
  monday: 1,
  "1": 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  "2": 2,
  wed: 3,
  wednesday: 3,
  "3": 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  "4": 4,
  fri: 5,
  friday: 5,
  "5": 5,
  sat: 6,
  saturday: 6,
  "6": 6,
};

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function onceActivationNeedsNewTime(
  schedule: ScheduledTaskSchedule,
  lastRunAt: string | undefined,
  now: Date,
): boolean {
  return schedule.kind === "once" && Boolean(lastRunAt) && Date.parse(schedule.at) <= now.getTime();
}

export function isWeekday(value: unknown): value is Weekday {
  return (
    value === 0 ||
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6
  );
}

export function parseWeekday(value: unknown): Weekday | undefined {
  if (isWeekday(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) {
    return value as Weekday;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return WEEKDAY_ALIASES[value.trim().toLowerCase()];
}

export function parseClockTime(value: unknown): { hour: number; minute: number } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    return undefined;
  }
  return { hour, minute };
}

export function assertScheduledTaskSchedule(
  value: unknown,
  name = "schedule",
): ScheduledTaskSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "once") {
    const at = typeof record.at === "string" ? record.at.trim() : "";
    if (!at || Number.isNaN(Date.parse(at))) {
      throw new TypeError(`${name}.at must be an ISO timestamp`);
    }
    return { kind: "once", at: new Date(at).toISOString() };
  }
  if (kind === "daily" || kind === "weekly") {
    const hour = record.hour;
    const minute = record.minute;
    const timeZone =
      typeof record.timeZone === "string" && record.timeZone.trim()
        ? record.timeZone.trim()
        : hostTimeZone();
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new TypeError(`${name}.hour must be an integer 0-23`);
    }
    if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new TypeError(`${name}.minute must be an integer 0-59`);
    }
    if (kind === "daily") {
      return { kind: "daily", hour, minute, timeZone };
    }
    if (!Array.isArray(record.days) || record.days.length === 0) {
      throw new TypeError(`${name}.days must be a non-empty weekday list`);
    }
    const days: Weekday[] = [];
    for (const entry of record.days) {
      const day = parseWeekday(entry);
      if (day === undefined) {
        throw new TypeError(`${name}.days must contain weekdays`);
      }
      if (!days.includes(day)) {
        days.push(day);
      }
    }
    days.sort((left, right) => left - right);
    return { kind: "weekly", days, hour, minute, timeZone };
  }
  if (kind === "interval") {
    const everyMs = record.everyMs;
    if (
      typeof everyMs !== "number" ||
      !Number.isInteger(everyMs) ||
      everyMs < MIN_SCHEDULE_INTERVAL_MS ||
      everyMs > MAX_SCHEDULE_INTERVAL_MS
    ) {
      throw new TypeError(
        `${name}.everyMs must be an integer between ${MIN_SCHEDULE_INTERVAL_MS} and ${MAX_SCHEDULE_INTERVAL_MS}`,
      );
    }
    return { kind: "interval", everyMs };
  }
  throw new TypeError(`${name}.kind must be once, daily, weekly, or interval`);
}

export function assertScheduledTaskTarget(value: unknown, name = "target"): ScheduledTaskTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  if (!workspaceId) {
    throw new TypeError(`${name}.workspaceId must not be empty`);
  }
  if (record.kind === "new-thread") {
    return { kind: "new-thread", workspaceId };
  }
  if (record.kind === "existing-thread") {
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    if (!sessionId) {
      throw new TypeError(`${name}.sessionId must not be empty`);
    }
    return { kind: "existing-thread", workspaceId, sessionId };
  }
  throw new TypeError(`${name}.kind must be new-thread or existing-thread`);
}

export function formatClockTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) {
    return "";
  }
  if (names.length === 1) {
    return names[0]!;
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function formatScheduledTaskRecurrence(schedule: ScheduledTaskSchedule): string {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    if (Number.isNaN(at)) {
      return "Once";
    }
    return `Once at ${new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  if (schedule.kind === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % (24 * 60) === 0) {
      const days = minutes / (24 * 60);
      return days === 1 ? "Every day" : `Every ${days} days`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours === 1 ? "Every hour" : `Every ${hours} hours`;
    }
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  const time = formatClockTime(schedule.hour, schedule.minute);
  if (schedule.kind === "daily") {
    return `Daily at ${time}`;
  }
  const names = [...schedule.days]
    .sort((left, right) => left - right)
    .map((day) => WEEKDAY_SHORT[day]!);
  return `${joinNames(names)} at ${time}`;
}

export function formatScheduledTaskNextRun(nextRunAt: string, now = new Date()): string {
  const timestamp = Date.parse(nextRunAt);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  const diffMs = timestamp - now.getTime();
  if (diffMs <= 0) {
    return "Due now";
  }
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return "Next run in under a minute";
  }
  if (diffMinutes < 60) {
    return `Next run in ${diffMinutes} minute${diffMinutes === 1 ? "" : "s"}`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `Next run in ${diffHours} hour${diffHours === 1 ? "" : "s"}`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `Next run in ${diffDays} day${diffDays === 1 ? "" : "s"}`;
}

export function formatScheduledTaskRowMeta(task: ScheduledTaskRecord, now = new Date()): string {
  const recurrence = formatScheduledTaskRecurrence(task.schedule);
  if (task.status === "completed") {
    return recurrence;
  }
  if (task.status === "paused") {
    return `${recurrence} · Paused`;
  }
  if (!task.nextRunAt) {
    return recurrence;
  }
  return `${recurrence} · ${formatScheduledTaskNextRun(task.nextRunAt, now)}`;
}

export function nonCompletedBindingForSession(
  tasks: readonly ScheduledTaskRecord[],
  sessionId: string,
): ScheduledTaskRecord | undefined {
  return tasks.find(
    (task) =>
      task.status !== "completed" &&
      task.target.kind === "existing-thread" &&
      task.target.sessionId === sessionId,
  );
}

export function filterScheduledTasks(
  tasks: readonly ScheduledTaskRecord[],
  filter: ScheduledTaskFilter,
  query = "",
): readonly ScheduledTaskRecord[] {
  const normalized = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filter !== "all" && task.status !== filter) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return [task.title, task.instruction, formatScheduledTaskRecurrence(task.schedule)].some(
      (value) => value.toLowerCase().includes(normalized),
    );
  });
}

interface OriginMessage {
  readonly id: string;
  readonly kind: string;
  readonly role?: string;
  readonly text?: string;
  readonly createdAt: string;
}

export function scheduledOriginsByMessageId(
  tasks: readonly ScheduledTaskRecord[],
  workspaceId: string,
  sessionId: string,
  messages: readonly OriginMessage[],
): ReadonlyMap<string, ScheduledTaskOrigin> {
  const runs = tasks
    .flatMap((task) =>
      task.runs
        .filter((run) => run.workspaceId === workspaceId && run.sessionId === sessionId)
        .map((run) => ({ run, task })),
    )
    .sort((left, right) => left.run.firedAt.localeCompare(right.run.firedAt));
  const userMessages = messages.filter(
    (message) =>
      message.kind === "message" &&
      message.role === "user" &&
      typeof message.text === "string" &&
      message.text.length > 0,
  );
  const used = new Set<string>();
  const origins = new Map<string, ScheduledTaskOrigin>();
  for (const { run, task } of runs) {
    const hinted =
      run.userMessageId &&
      userMessages.find(
        (message) =>
          message.id === run.userMessageId &&
          message.text === run.instruction &&
          !used.has(message.id),
      );
    const matched =
      hinted ??
      userMessages.find((message) => {
        if (used.has(message.id) || message.text !== run.instruction) {
          return false;
        }
        const createdAt = Date.parse(message.createdAt);
        const firedAt = Date.parse(run.firedAt);
        if (Number.isNaN(createdAt) || Number.isNaN(firedAt)) {
          return false;
        }
        return createdAt >= firedAt;
      });
    if (!matched) {
      continue;
    }
    used.add(matched.id);
    origins.set(matched.id, { taskId: task.id, title: task.title });
  }
  return origins;
}

export { WEEKDAY_NAMES };
