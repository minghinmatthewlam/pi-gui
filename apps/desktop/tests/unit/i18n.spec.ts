import { expect, test } from "@playwright/test";
import {
  LOCALES,
  appLocaleIds,
  defaultLocale,
  languageTagParts,
  localeDefinition,
  matchSystemLocale,
  textDirectionFor,
  type AppLocale,
  type LocaleDefinition,
  type MessageKey,
} from "../../src/i18n/catalog";
import { localePreferences, resolveLocale, type LocalePreference } from "../../src/i18n/preference";
import { catalogs, interpolate, resolveMessage, translatorFor } from "../../src/i18n/translate";
import { isPluralVariantKey } from "../../src/i18n/plural";
import { formatDateTime, formatNumber } from "../../src/i18n/format";
import { formatRelativeTime } from "../../src/lib/string-utils";
import { en } from "../../src/i18n/messages/en";

const englishKeys = Object.keys(en).sort() as readonly MessageKey[];
const localeIds = LOCALES.map((locale) => locale.id);

/**
 * Plural variants are optional per language: a locale whose grammar has one plural
 * category translates the plain key and `translate.ts` reuses it at every count.
 */
const requiredKeys = englishKeys.filter((key) => !isPluralVariantKey(key));

/** Every key a locale must cover, plus the plural refinements it chose to add. */
function localeKeys(localeId: AppLocale): readonly string[] {
  return Object.keys(catalogs[localeId]);
}

function placeholders(template: string): readonly string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

function isPartial(locale: { readonly id: string }): boolean {
  return (locale as LocaleDefinition).partial === true;
}

test("the locale registry is well formed and covers its own preferences", () => {
  expect(LOCALES.length).toBeGreaterThan(0);
  // The first entry is the locale everything falls back to.
  expect(LOCALES[0].id).toBe(defaultLocale);
  expect(new Set(localeIds).size, "locale ids are unique").toBe(LOCALES.length);
  // "system" is the only preference that is not a locale.
  expect([...localePreferences]).toEqual(["system", ...appLocaleIds]);

  for (const locale of LOCALES) {
    const reason = `locale ${locale.id}`;
    expect(locale.label.trim(), `${reason} label`).not.toBe("");
    // BCP 47-ish: a primary subtag, then optional subtags ("zh-CN", "pt-BR").
    expect(locale.id, `${reason} looks like a language tag`).toMatch(
      /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    );
    expect(localeDefinition(locale.id as AppLocale).id, reason).toBe(locale.id);
    expect(Object.keys(catalogs), `${reason} has a catalog`).toContain(locale.id);
  }
});

test("every shipped locale translates every key, with no stale extras", () => {
  for (const locale of LOCALES) {
    const keys = localeKeys(locale.id)
      .filter((key) => !isPluralVariantKey(key))
      .sort();
    const reason = `locale ${locale.id}`;
    if (isPartial(locale)) {
      expect(requiredKeys, `${reason} defines an unknown key`).toEqual(
        expect.arrayContaining(keys),
      );
    } else {
      // The failure message is the checklist of what is left to translate.
      expect(keys, `${reason} is missing keys`).toEqual(requiredKeys);
    }
    for (const key of keys) {
      const copy = catalogs[locale.id][key as MessageKey] ?? "";
      expect(copy.trim(), `${reason} ${key}`).not.toBe("");
    }
  }
});

test("translations keep every placeholder the English source uses", () => {
  for (const locale of LOCALES) {
    for (const [key, source] of Object.entries(en)) {
      const translated = catalogs[locale.id][key as MessageKey];
      if (translated === undefined) continue;
      expect(placeholders(translated), `locale ${locale.id} ${key}`).toEqual(placeholders(source));
    }
  }
});

test("interpolate substitutes known names and leaves unknown ones alone", () => {
  expect(interpolate("Search {title}", { title: "settings" })).toBe("Search settings");
  expect(interpolate("{a} {b}", { a: 1 })).toBe("1 {b}");
  expect(interpolate("no placeholders")).toBe("no placeholders");
  const quoted = interpolate("No matches for “{query}”", { query: "zz" });
  expect(quoted).toBe("No matches for “zz”");
});

test("a translator reads its own catalog, and falls back to the default locale", () => {
  expect(translatorFor("en")("topbar.newThread")).toBe("New thread");
  expect(translatorFor("zh-CN")("topbar.newThread")).toBe("新会话");
  expect(translatorFor("ja")("topbar.newThread")).toBe("新しいスレッド");
  const sections = translatorFor("en")("secondarySurface.sectionsLabel", { title: "Settings" });
  expect(sections).toBe("Settings sections");
  // A half-translated catalog renders the default locale's copy instead of `undefined`…
  expect(resolveMessage({}, "topbar.newThread")).toBe("New thread");
  // …and an unknown key falls back to the key itself, never to `undefined`.
  expect(resolveMessage({}, "totally.unknown" as MessageKey)).toBe("totally.unknown");
});

test("resolveLocale follows the system language unless a locale is chosen", () => {
  const cases: readonly (readonly [LocalePreference, readonly string[], AppLocale])[] = [
    ["system", ["zh-CN", "en-US"], "zh-CN"],
    ["system", ["zh-Hans-CN"], "zh-CN"],
    ["system", ["ja-JP", "en-US"], "ja"],
    ["system", ["JA", "zh-CN"], "ja"],
    ["system", ["en-US", "zh-CN"], "en"],
    ["system", [], "en"],
    // A language we do not ship reads the default locale. "xx" is reserved for no
    // linguistic content, so registering a real language never invalidates this case.
    ["system", ["xx-XX"], "en"],
    ["en", ["zh-CN"], "en"],
    ["zh-CN", ["en-US"], "zh-CN"],
    ["ja", ["en-US"], "ja"],
  ];
  for (const [preference, systemLanguages, expected] of cases) {
    const reason = `${preference} ${systemLanguages}`;
    expect(resolveLocale(preference, systemLanguages), reason).toBe(expected);
  }
});

test("a counted message picks the CLDR plural form of the active locale", () => {
  const english = translatorFor("en");
  expect(english("turnChanges.editedFiles", { count: 1 })).toBe("Edited 1 file");
  expect(english("turnChanges.editedFiles", { count: 4 })).toBe("Edited 4 files");
  expect(english("queuedComposer.annotations", { count: 1 })).toBe("1 annotation");
  expect(english("queuedComposer.annotations", { count: 3 })).toBe("3 annotations");
  // Chinese has one plural category, so the other forms are simply unused there.
  const chinese = translatorFor("zh-CN");
  expect(chinese("turnChanges.editedFiles", { count: 1 })).toBe("已编辑 1 个文件");
  expect(chinese("turnChanges.editedFiles", { count: 4 })).toBe("已编辑 4 个文件");
  const japanese = translatorFor("ja");
  for (const count of [0, 1, 4]) {
    expect(japanese("turnChanges.editedFiles", { count })).toBe(`${count}個のファイルを編集`);
  }
  expect(japanese("files.editor.close", { name: "日本語 {name}.md" })).toBe(
    "日本語 {name}.md を閉じる",
  );
  // A count on a string without plural forms still resolves the plain message.
  expect(english("sidebar.worktree", { count: 3 })).toBe("Worktree");
});

test("relative timestamps are translated and stay terse", () => {
  const english = translatorFor("en");
  const chinese = translatorFor("zh-CN");
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  // English keeps the abbreviations the list rows were designed around.
  expect(formatRelativeTime(minutesAgo(0), english)).toBe("now");
  expect(formatRelativeTime(minutesAgo(5), english)).toBe("5m");
  expect(formatRelativeTime(minutesAgo(3 * 60), english)).toBe("3h");
  expect(formatRelativeTime(minutesAgo(2 * 24 * 60), english)).toBe("2d");
  expect(formatRelativeTime(minutesAgo(10 * 24 * 60), english)).toBe("1w");
  expect(formatRelativeTime(minutesAgo(45 * 24 * 60), english)).toBe("1mo");
  expect(formatRelativeTime(minutesAgo(400 * 24 * 60), english)).toBe("1y");

  expect(formatRelativeTime(minutesAgo(0), chinese)).toBe("刚刚");
  expect(formatRelativeTime(minutesAgo(5), chinese)).toBe("5分钟前");
  expect(formatRelativeTime(minutesAgo(3 * 60), chinese)).toBe("3小时前");
  expect(formatRelativeTime(minutesAgo(10 * 24 * 60), chinese)).toBe("1周前");

  // Unparseable or empty input is passed through instead of rendering "NaN".
  expect(formatRelativeTime("not a date", english)).toBe("not a date");
  expect(formatRelativeTime("", english)).toBe("");
});

test("numbers and dates follow the active locale, not the runtime default", () => {
  expect(formatNumber("en", 1234567)).toBe("1,234,567");

  // The shipped locales order date fields differently, which is the point of
  // threading the locale through instead of calling toLocaleString().
  const instant = new Date("2026-10-11T15:04:05Z");
  expect(formatDateTime("zh-CN", instant)).not.toBe(formatDateTime("en", instant));
  expect(formatDateTime("zh-CN", instant)).toContain("2026");
  expect(formatDateTime("en", "not a date")).toBe("not a date");
});

test("language tags split into primary, script and region subtags", () => {
  expect(languageTagParts("zh-Hant-TW")).toEqual({ primary: "zh", script: "hant", region: "tw" });
  expect(languageTagParts("zh-CN")).toEqual({ primary: "zh", script: undefined, region: "cn" });
  expect(languageTagParts("EN-us")).toEqual({ primary: "en", script: undefined, region: "us" });
  expect(languageTagParts("")).toEqual({ primary: "", script: undefined, region: undefined });
});

test("every locale declares a writing direction, defaulting to left-to-right", () => {
  for (const locale of LOCALES) {
    expect(textDirectionFor(locale.id as AppLocale), `locale ${locale.id}`).toBe(
      locale.dir ?? "ltr",
    );
  }
});

test("system-tag matching is registered per locale, not hardcoded", () => {
  expect(matchSystemLocale("ZH-hant")).toBe("zh-CN");
  expect(matchSystemLocale("  en-GB  ")).toBe("en");
  expect(matchSystemLocale(" ja-JP ")).toBe("ja");
  expect(matchSystemLocale("javanese")).toBeUndefined();
  expect(matchSystemLocale("de-DE")).toBeUndefined();
  expect(matchSystemLocale("")).toBeUndefined();
});
