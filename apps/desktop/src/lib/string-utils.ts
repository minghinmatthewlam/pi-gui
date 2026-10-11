import type { Translate } from "../i18n";

export function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatRelativeTime(value: string, t: Translate): string {
  if (!value) {
    return "";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMinutes < 1) return t("time.now");
  if (diffMinutes < 60) return t("time.minute", { count: diffMinutes });
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return t("time.hour", { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return t("time.day", { count: diffDays });
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return t("time.week", { count: diffWeeks });
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return t("time.month", { count: diffMonths });
  const diffYears = Math.floor(diffDays / 365);
  return t("time.year", { count: diffYears });
}
