/*
 * Scheduled-task copy and locale-aware values.
 *
 * This lives in the renderer rather than in `contracts/`: desktop contracts may not
 * depend on the translator, and everything here is user-facing copy — recurrence
 * sentences, weekday names, clock times and dates. `contracts/scheduled-tasks.ts`
 * keeps only the schedule data, parsing and validation.
 *
 * `Intl` instances are cached per locale and style; these run inside list rendering.
 */
import { formatDateTime, type AppLocale, type Translate } from "../../i18n";
import type {
  ScheduledTaskFilter,
  ScheduledTaskRecord,
  ScheduledTaskSchedule,
} from "../../../contracts/scheduled-tasks";

/** A known Sunday. Index 0 of a week is Sunday, which is what `Weekday` means. */
const REFERENCE_SUNDAY_UTC = Date.UTC(2024, 0, 7);

const weekdayFormats = new Map<AppLocale, Intl.DateTimeFormat>();
const clockFormats = new Map<AppLocale, Intl.DateTimeFormat>();
const onceFormats = new Map<AppLocale, Intl.DateTimeFormat>();
const listFormats = new Map<AppLocale, Intl.ListFormat>();

/**
 * Wall-clock values are formatted with `timeZone: "UTC"` on purpose: an hour/minute
 * pair has no date behind it, so it must not be shifted by the machine's zone.
 */
function weekdayFormat(locale: AppLocale): Intl.DateTimeFormat {
  const cached = weekdayFormats.get(locale);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  weekdayFormats.set(locale, formatter);
  return formatter;
}

function clockFormat(locale: AppLocale): Intl.DateTimeFormat {
  const cached = clockFormats.get(locale);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  clockFormats.set(locale, formatter);
  return formatter;
}

/** Absolute instants are formatted in the viewer's zone, like any other timestamp. */
function onceFormat(locale: AppLocale): Intl.DateTimeFormat {
  const cached = onceFormats.get(locale);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  onceFormats.set(locale, formatter);
  return formatter;
}

function listFormat(locale: AppLocale): Intl.ListFormat {
  const cached = listFormats.get(locale);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  listFormats.set(locale, formatter);
  return formatter;
}

/** Abbreviated weekday names in the locale, Sunday first — the order `Weekday` uses. */
export function weekdayShortNames(locale: AppLocale): readonly string[] {
  const format = weekdayFormat(locale);
  return Array.from({ length: 7 }, (_, day) =>
    format.format(REFERENCE_SUNDAY_UTC + day * 86_400_000),
  );
}

/** "10:00 PM" where the locale reads that way, "22:00" where it does not. */
export function formatClockTime(locale: AppLocale, hour: number, minute: number): string {
  return clockFormat(locale).format(Date.UTC(2024, 0, 7, hour, minute));
}

export function formatScheduledTaskRecurrence(
  schedule: ScheduledTaskSchedule,
  t: Translate,
  locale: AppLocale,
): string {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    if (Number.isNaN(at)) {
      return t("scheduledTasks.recurrence.once");
    }
    return t("scheduledTasks.recurrence.onceAt", { time: onceFormat(locale).format(at) });
  }
  if (schedule.kind === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % (24 * 60) === 0) {
      return t("scheduledTasks.recurrence.everyDay", { count: minutes / (24 * 60) });
    }
    if (minutes % 60 === 0) {
      return t("scheduledTasks.recurrence.everyHour", { count: minutes / 60 });
    }
    return t("scheduledTasks.recurrence.everyMinute", { count: minutes });
  }
  const time = formatClockTime(locale, schedule.hour, schedule.minute);
  if (schedule.kind === "daily") {
    return t("scheduledTasks.recurrence.dailyAt", { time });
  }
  const names = [...schedule.days]
    .sort((left, right) => left - right)
    .map((day) => weekdayShortNames(locale)[day]!);
  return t("scheduledTasks.recurrence.weeklyAt", {
    days: listFormat(locale).format(names),
    time,
  });
}

export function formatScheduledTaskNextRun(
  nextRunAt: string,
  t: Translate,
  now = new Date(),
): string {
  const timestamp = Date.parse(nextRunAt);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  const diffMs = timestamp - now.getTime();
  if (diffMs <= 0) {
    return t("scheduledTasks.nextRun.dueNow");
  }
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return t("scheduledTasks.nextRun.underMinute");
  }
  if (diffMinutes < 60) {
    return t("scheduledTasks.nextRun.minutes", { count: diffMinutes });
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return t("scheduledTasks.nextRun.hours", { count: diffHours });
  }
  return t("scheduledTasks.nextRun.days", { count: Math.floor(diffHours / 24) });
}

export function formatScheduledTaskRowMeta(
  task: ScheduledTaskRecord,
  t: Translate,
  locale: AppLocale,
  now = new Date(),
): string {
  const recurrence = formatScheduledTaskRecurrence(task.schedule, t, locale);
  if (task.status === "completed") {
    return recurrence;
  }
  if (task.status === "paused") {
    return `${recurrence} · ${t("scheduledTasks.paused")}`;
  }
  if (!task.nextRunAt) {
    return recurrence;
  }
  return `${recurrence} · ${formatScheduledTaskNextRun(task.nextRunAt, t, now)}`;
}

export function filterScheduledTasks(
  tasks: readonly ScheduledTaskRecord[],
  filter: ScheduledTaskFilter,
  query: string,
  t: Translate,
  locale: AppLocale,
): readonly ScheduledTaskRecord[] {
  const normalized = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filter !== "all" && task.status !== filter) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return [
      task.title,
      task.instruction,
      formatScheduledTaskRecurrence(task.schedule, t, locale),
    ].some((value) => value.toLowerCase().includes(normalized));
  });
}
