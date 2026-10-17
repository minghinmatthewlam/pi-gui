/**
 * Tiny in-tree i18n scaffold.
 *
 * The renderer ships three locale dictionaries under `./dictionaries/*.json` and
 * reads the active locale from localStorage (so the choice follows the user
 * across launches). The default locale is `en`; missing keys fall back to the
 * English dictionary so a half-translated component still renders sensibly.
 *
 * Consumers call `t("key", { var })` inside render code. The React hook
 * `useLocale()` exposes the current locale plus a setter; when the locale
 * changes, every component that called `useLocale()` re-renders and reads the
 * new dictionary.
 */

import { useSyncExternalStore } from "react";
import enDictionary from "./dictionaries/en.json";
import zhCnDictionary from "./dictionaries/zh-CN.json";
import zhTwDictionary from "./dictionaries/zh-TW.json";

export type LocaleId = "en" | "zh-TW" | "zh-CN";

export const SUPPORTED_LOCALES: readonly LocaleId[] = ["en", "zh-TW", "zh-CN"];

export const DEFAULT_LOCALE: LocaleId = "en";

export interface LocaleDescriptor {
  readonly id: LocaleId;
  readonly nativeName: string;
  readonly englishName: string;
}

const LOCALE_STORAGE_KEY = "pi-gui.locale";

type Dictionary = Readonly<Record<string, string>>;

const DICTIONARIES: Readonly<Record<LocaleId, Dictionary>> = {
  en: enDictionary as Dictionary,
  "zh-TW": zhTwDictionary as Dictionary,
  "zh-CN": zhCnDictionary as Dictionary,
};

function readStoredLocale(): LocaleId {
  if (typeof globalThis === "undefined" || typeof globalThis.localStorage === "undefined") {
    return DEFAULT_LOCALE;
  }
  try {
    const raw = globalThis.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw && SUPPORTED_LOCALES.includes(raw as LocaleId)) {
      return raw as LocaleId;
    }
  } catch {
    // Storage can be denied (private mode, corrupt prefs); fall through to default.
  }
  return DEFAULT_LOCALE;
}

let activeLocale: LocaleId = readStoredLocale();
const listeners = new Set<() => void>();

function setActiveLocale(locale: LocaleId): void {
  if (activeLocale === locale) return;
  activeLocale = locale;
  try {
    if (typeof globalThis !== "undefined" && typeof globalThis.localStorage !== "undefined") {
      globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    }
  } catch {
    // Storage failures don't break the in-memory switch.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getLocaleSnapshot(): LocaleId {
  return activeLocale;
}

/**
 * Look up a translation for `key` in the active locale, falling back to the
 * English dictionary when the locale is missing an entry. Interpolation tokens
 * use `{name}` syntax; missing variables are left as their literal token so
 * the call site is easy to spot during translation.
 */
export function t(key: string, vars?: Readonly<Record<string, string | number>>): string {
  const locale = activeLocale;
  const primary = DICTIONARIES[locale][key];
  const fallback = primary ?? DICTIONARIES.en[key] ?? key;
  if (!vars) return fallback;
  return interpolate(fallback, vars);
}

function interpolate(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Whether the active dictionary contains a translation for `key`. */
export function hasTranslation(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DICTIONARIES[activeLocale], key);
}

/** Current locale, read inside a React component to subscribe to changes. */
export function useLocale(): LocaleId {
  return useSyncExternalStore(subscribe, getLocaleSnapshot);
}

/** Switch the active locale; persisted in localStorage. */
export function setLocale(locale: LocaleId): void {
  setActiveLocale(locale);
}

/** Native-language name of a locale (e.g. "繁體中文") for switcher labels. */
export function localeNativeName(locale: LocaleId): string {
  const key = `app.locale.${locale}`;
  return t(key) === key ? locale : t(key);
}

/** English name of a locale (e.g. "Traditional Chinese") for tooltips. */
export function localeEnglishName(locale: LocaleId): string {
  return LOCALE_DESCRIPTORS[locale].englishName;
}

/**
 * Build the descriptor list shown by the language switcher. The active locale
 * is marked, so callers can render a selected state without re-resolving names.
 */
export function listLocales(): readonly LocaleDescriptor[] {
  return SUPPORTED_LOCALES.map((id) => ({
    id,
    nativeName: localeNativeName(id),
    englishName: LOCALE_DESCRIPTORS[id].englishName,
  }));
}

const LOCALE_DESCRIPTORS: Readonly<Record<LocaleId, Omit<LocaleDescriptor, "nativeName">>> = {
  en: { id: "en", englishName: "English" },
  "zh-TW": { id: "zh-TW", englishName: "Traditional Chinese" },
  "zh-CN": { id: "zh-CN", englishName: "Simplified Chinese" },
};
