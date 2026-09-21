import type { ScheduledTaskSchedule, Weekday } from "../../contracts/scheduled-tasks";

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: Weekday;
}

const weekdayByName: Readonly<Record<string, Weekday>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = weekdayByName[read("weekday")];
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    weekday: weekday ?? 0,
  };
}

function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(new Date(utc), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
    const delta = wanted - asUtc;
    if (delta === 0) {
      break;
    }
    utc += delta;
  }
  return new Date(utc);
}

function addDays(
  year: number,
  month: number,
  day: number,
  days: number,
): {
  year: number;
  month: number;
  day: number;
} {
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function nextWallClockAfter(
  from: Date,
  hour: number,
  minute: number,
  timeZone: string,
  allowedWeekdays?: readonly Weekday[],
): Date {
  const parts = zonedParts(from, timeZone);
  for (let offset = 0; offset <= 14; offset += 1) {
    const next = addDays(parts.year, parts.month, parts.day, offset);
    if (allowedWeekdays && allowedWeekdays.length > 0) {
      const candidateWeekday = ((parts.weekday + offset) % 7) as Weekday;
      if (!allowedWeekdays.includes(candidateWeekday)) {
        continue;
      }
    }
    const instant = zonedWallTimeToUtc(next.year, next.month, next.day, hour, minute, timeZone);
    if (instant.getTime() > from.getTime()) {
      return instant;
    }
  }
  const fallback = addDays(parts.year, parts.month, parts.day, 1);
  return zonedWallTimeToUtc(fallback.year, fallback.month, fallback.day, hour, minute, timeZone);
}

export function nextRunAt(schedule: ScheduledTaskSchedule, from: Date): string | undefined {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    if (Number.isNaN(at) || at <= from.getTime()) {
      return undefined;
    }
    return new Date(at).toISOString();
  }
  if (schedule.kind === "interval") {
    return new Date(from.getTime() + schedule.everyMs).toISOString();
  }
  if (schedule.kind === "daily") {
    return nextWallClockAfter(
      from,
      schedule.hour,
      schedule.minute,
      schedule.timeZone,
    ).toISOString();
  }
  return nextWallClockAfter(
    from,
    schedule.hour,
    schedule.minute,
    schedule.timeZone,
    schedule.days,
  ).toISOString();
}

export function earliestScheduledWakeAt(
  tasks: readonly { readonly status: string; readonly nextRunAt?: string }[],
  now = new Date(),
): string | undefined {
  let earliest: string | undefined;
  for (const task of tasks) {
    if (task.status !== "active" || !task.nextRunAt) {
      continue;
    }
    const at = Date.parse(task.nextRunAt);
    if (Number.isNaN(at)) {
      continue;
    }
    if (!earliest || at < Date.parse(earliest)) {
      earliest = task.nextRunAt;
    }
  }
  if (!earliest) {
    return undefined;
  }
  return Date.parse(earliest) < now.getTime() ? now.toISOString() : earliest;
}
