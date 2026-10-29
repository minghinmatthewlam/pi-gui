/*
 * The locale registry: the one place a language is declared. Everything else —
 * the Settings picker, system-language detection, the `t()` locale type, and the
 * copy checks in tests/unit/i18n.spec.ts — derives from this list.
 */
import { en, type Messages } from "./messages/en";
import { zhCN } from "./messages/zh-CN";

export type { MessageKey, Messages } from "./messages/en";

export interface LocaleDefinition {
  /** BCP 47 tag; also the value persisted as the user's locale preference. */
  readonly id: string;
  /** Shown in Settings, written in the language itself ("简体中文", not "Chinese"). */
  readonly label: string;
  /**
   * Copy for this locale. Only English must be complete: any key a locale leaves
   * out renders the English copy, so a UI change never has to wait on translators.
   */
  readonly messages: Partial<Messages>;
  /** Whether an OS language tag should select this locale, e.g. "zh-Hans-CN". */
  readonly matchesSystemTag: (languageTag: string) => boolean;
  /** Writing direction. Omit for left-to-right; set `"rtl"` for Arabic, Hebrew, … */
  readonly dir?: "ltr" | "rtl";
}

/** Locale used for every fallback, and the one the key type is authored against. */
export const defaultLocale = "en" as const;

/**
 * To add a language, run `pnpm i18n:new <tag> "<label>"`: it writes the catalog file
 * and adds the entry below. By hand it is the same two edits — write
 * `messages/<tag>.ts` as a `Partial<Messages>`, then import it below and add one entry
 * here. Nothing else needs to change; see ./AGENTS.md for the full workflow.
 */
export const LOCALES = [
  {
    id: "en",
    label: "English",
    messages: en,
    matchesSystemTag: (languageTag) => languageTagParts(languageTag).primary === "en",
  },
  {
    id: "zh-CN",
    label: "简体中文",
    messages: zhCN,
    // Every Chinese tag lands on Simplified until a zh-Hant locale is registered
    // ahead of this one and claims the traditional script.
    matchesSystemTag: (languageTag) => languageTagParts(languageTag).primary === "zh",
  },
] as const satisfies readonly LocaleDefinition[];

export type AppLocale = (typeof LOCALES)[number]["id"];

export const appLocaleIds: readonly AppLocale[] = LOCALES.map((locale) => locale.id);

export function localeDefinition(locale: AppLocale): LocaleDefinition {
  return LOCALES.find((definition) => definition.id === locale) ?? LOCALES[0];
}

/**
 * Splits a BCP 47 tag into its primary language plus, when present, its script
 * and region subtags: "zh-Hant-TW" → `{ primary: "zh", script: "hant", region: "tw" }`.
 * Subtags come back lower-cased, so comparisons never depend on how the OS cased it.
 *
 * Locales use this instead of `startsWith` so a script-sensitive locale (zh-Hant,
 * sr-Latn) can be registered without the earlier entry swallowing its tag.
 */
export function languageTagParts(languageTag: string): {
  readonly primary: string;
  readonly script?: string;
  readonly region?: string;
} {
  const subtags = languageTag.trim().toLowerCase().split("-");
  const script = subtags.find((subtag, index) => index > 0 && /^[a-z]{4}$/.test(subtag));
  const region = subtags.find((subtag, index) => index > 0 && /^([a-z]{2}|\d{3})$/.test(subtag));
  return { primary: subtags[0] ?? "", script, region };
}

/** The writing direction a locale renders in; left-to-right unless it opts out. */
export function textDirectionFor(locale: AppLocale): "ltr" | "rtl" {
  return localeDefinition(locale).dir ?? "ltr";
}

/** The first registered locale whose system-tag matcher accepts `languageTag`. */
export function matchSystemLocale(languageTag: string): AppLocale | undefined {
  const normalized = languageTag.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return LOCALES.find((locale) => locale.matchesSystemTag(normalized))?.id;
}
