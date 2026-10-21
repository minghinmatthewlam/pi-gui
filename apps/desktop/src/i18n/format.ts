/*
 * Locale-aware formatting for values that are not copy — numbers and dates. These
 * follow the active app locale rather than the runtime default, which is Chromium's
 * UI language and can disagree with the language the app is actually showing.
 *
 * Formatters are cached per locale: `Intl` construction is the expensive part, and
 * these run inside list rendering.
 */
import type { AppLocale } from "./catalog";

const numberFormats = new Map<AppLocale, Intl.NumberFormat>();
const dateTimeFormats = new Map<AppLocale, Intl.DateTimeFormat>();

function numberFormatFor(locale: AppLocale): Intl.NumberFormat {
  const cached = numberFormats.get(locale);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.NumberFormat(locale);
  numberFormats.set(locale, formatter);
  return formatter;
}

function dateTimeFormatFor(locale: AppLocale): Intl.DateTimeFormat {
  const cached = dateTimeFormats.get(locale);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(locale);
  dateTimeFormats.set(locale, formatter);
  return formatter;
}

/** Digits grouped the way the locale groups them, e.g. "1,234". */
export function formatNumber(locale: AppLocale, value: number): string {
  return numberFormatFor(locale).format(value);
}

/** A date and time in the locale: "11/10/2026, 3:04:05 PM" vs "2026/10/11 15:04:05". */
export function formatDateTime(locale: AppLocale, value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    // Unparseable input is shown as-is rather than as "Invalid Date".
    return typeof value === "string" ? value : "";
  }
  return dateTimeFormatFor(locale).format(date);
}
