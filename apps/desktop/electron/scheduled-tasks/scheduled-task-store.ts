import {
  MAX_SCHEDULED_TASK_RUNS,
  SCHEDULED_TASKS_FILE_VERSION,
  assertScheduledTaskSchedule,
  assertScheduledTaskTarget,
  type ScheduledTaskRecord,
  type ScheduledTaskRun,
  type ScheduledTaskStatus,
} from "../../contracts/scheduled-tasks";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";

export interface ScheduledTasksFile {
  readonly version: typeof SCHEDULED_TASKS_FILE_VERSION;
  readonly tasks: readonly ScheduledTaskRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(field: string): never {
  throw new Error(`Invalid scheduled-tasks field ${field}; original data was retained.`);
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      fail(`${path}.${key} (unsupported field)`);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(field);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    fail(field);
  }
  return value.trim();
}

function decodeRun(value: unknown, path: string): ScheduledTaskRun {
  if (!isRecord(value)) {
    fail(path);
  }
  knownKeys(
    value,
    [
      "id",
      "sessionId",
      "workspaceId",
      "firedAt",
      "instruction",
      "userMessageId",
      "outcome",
      "error",
    ],
    path,
  );
  const outcome = value.outcome;
  if (outcome !== "started" && outcome !== "failed") {
    fail(`${path}.outcome`);
  }
  return {
    id: requireString(value.id, `${path}.id`),
    sessionId: requireString(value.sessionId, `${path}.sessionId`),
    workspaceId: requireString(value.workspaceId, `${path}.workspaceId`),
    firedAt: requireString(value.firedAt, `${path}.firedAt`),
    instruction: requireString(value.instruction, `${path}.instruction`),
    ...(optionalString(value.userMessageId, `${path}.userMessageId`)
      ? { userMessageId: optionalString(value.userMessageId, `${path}.userMessageId`) }
      : {}),
    outcome,
    ...(optionalString(value.error, `${path}.error`)
      ? { error: optionalString(value.error, `${path}.error`) }
      : {}),
  };
}

function decodeStatus(value: unknown, path: string): ScheduledTaskStatus {
  if (value !== "active" && value !== "paused" && value !== "completed") {
    fail(path);
  }
  return value;
}

export function decodeScheduledTaskRecord(value: unknown, path = "tasks[]"): ScheduledTaskRecord {
  if (!isRecord(value)) {
    fail(path);
  }
  knownKeys(
    value,
    [
      "id",
      "title",
      "instruction",
      "status",
      "schedule",
      "target",
      "createdAt",
      "updatedAt",
      "nextRunAt",
      "lastRunAt",
      "completedAt",
      "originSessionId",
      "lastError",
      "runs",
    ],
    path,
  );
  let schedule;
  let target;
  try {
    schedule = assertScheduledTaskSchedule(value.schedule, `${path}.schedule`);
  } catch {
    fail(`${path}.schedule`);
  }
  try {
    target = assertScheduledTaskTarget(value.target, `${path}.target`);
  } catch {
    fail(`${path}.target`);
  }
  const status = decodeStatus(value.status, `${path}.status`);
  const nextRunAt = optionalString(value.nextRunAt, `${path}.nextRunAt`);
  const completedAt = optionalString(value.completedAt, `${path}.completedAt`);
  if (status === "active" && !nextRunAt) {
    fail(`${path}.nextRunAt`);
  }
  if (status !== "active" && nextRunAt) {
    fail(`${path}.nextRunAt`);
  }
  if (status === "completed" && !completedAt) {
    fail(`${path}.completedAt`);
  }
  if (status !== "completed" && completedAt) {
    fail(`${path}.completedAt`);
  }
  if (!Array.isArray(value.runs)) {
    fail(`${path}.runs`);
  }
  const runs = value.runs.map((entry, index) => decodeRun(entry, `${path}.runs[${index}]`));
  return {
    id: requireString(value.id, `${path}.id`),
    title: requireString(value.title, `${path}.title`),
    instruction: requireString(value.instruction, `${path}.instruction`),
    status,
    schedule,
    target,
    createdAt: requireString(value.createdAt, `${path}.createdAt`),
    updatedAt: requireString(value.updatedAt, `${path}.updatedAt`),
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(optionalString(value.lastRunAt, `${path}.lastRunAt`)
      ? { lastRunAt: optionalString(value.lastRunAt, `${path}.lastRunAt`) }
      : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(optionalString(value.originSessionId, `${path}.originSessionId`)
      ? { originSessionId: optionalString(value.originSessionId, `${path}.originSessionId`) }
      : {}),
    ...(optionalString(value.lastError, `${path}.lastError`)
      ? { lastError: optionalString(value.lastError, `${path}.lastError`) }
      : {}),
    runs: runs.slice(-MAX_SCHEDULED_TASK_RUNS),
  };
}

export function decodeScheduledTasksFile(value: unknown): ScheduledTasksFile {
  if (!isRecord(value)) {
    throw new Error("Invalid scheduled-tasks: expected an object; original data was retained.");
  }
  knownKeys(value, ["version", "tasks"], "scheduled-tasks");
  if (value.version !== SCHEDULED_TASKS_FILE_VERSION) {
    fail("version");
  }
  if (!Array.isArray(value.tasks)) {
    fail("tasks");
  }
  return {
    version: SCHEDULED_TASKS_FILE_VERSION,
    tasks: value.tasks.map((entry, index) => decodeScheduledTaskRecord(entry, `tasks[${index}]`)),
  };
}

export async function readScheduledTasksFile(filePath: string): Promise<{
  readonly tasks: readonly ScheduledTaskRecord[];
  readonly recovered: boolean;
}> {
  const result = await readJsonWithBackup(filePath);
  if (result.value === undefined && !result.corrupted) {
    return { tasks: [], recovered: false };
  }
  if (result.corrupted && !result.recovered) {
    throw new Error(
      `Invalid scheduled-tasks at ${filePath}; original data was retained. Repair or restore the file before continuing.`,
    );
  }
  const decoded = decodeScheduledTasksFile(result.value);
  return { tasks: decoded.tasks, recovered: result.recovered };
}

export async function writeScheduledTasksFile(
  filePath: string,
  tasks: readonly ScheduledTaskRecord[],
): Promise<void> {
  const payload: ScheduledTasksFile = {
    version: SCHEDULED_TASKS_FILE_VERSION,
    tasks,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  decodeScheduledTasksFile(payload);
  await writeFileAtomicQueued(filePath, serialized, decodeScheduledTasksFile);
}
