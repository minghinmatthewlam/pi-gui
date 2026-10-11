# Desktop i18n

The desktop app ships its own translation layer under `apps/desktop/src/i18n/` — no
i18n framework, no build step. English is the source of truth; every other language
is a copy of the same key set.

## Files

| File                | Job                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `messages/en.ts`    | English copy. `MessageKey` is derived from it, so it defines the key set.                  |
| `messages/<tag>.ts` | One file per other language.                                                               |
| `catalog.ts`        | The locale registry: the only place a language is declared.                                |
| `preference.ts`     | The user's choice (`"system"` or a locale id) and how it resolves.                         |
| `translate.ts`      | Pure translation: interpolation, plural forms, fallback chain.                             |
| `plural.ts`         | The CLDR plural categories shared by the message type, the translator and the copy checks. |
| `format.ts`         | Locale-aware numbers and dates, for values that are not copy.                              |
| `index.tsx`         | React binding: `I18nProvider`, `useI18n()`, `useTranslation()`.                            |

## Adding a language

```sh
pnpm i18n:new fr "Français"     # or: node scripts/new-locale.mjs fr "Français"
pnpm i18n:check fr              # lists the copy that still reads English
```

That writes `messages/fr.ts` (every key, English values) and registers the locale in
`catalog.ts`, marked `partial: true`. `partial` is what keeps the app built while a
translation is unfinished: missing or untranslated keys fall back to English instead
of failing `pnpm check`.

To finish a language:

1. Replace the values in `messages/<tag>.ts`.
2. Drop `partial: true` from its `catalog.ts` entry and tighten `Partial<Messages>`
   to `Messages`. Both together hand the locale to the completeness check in
   `tests/unit/i18n.spec.ts`, whose failure message is the list of keys left.
3. Run `pnpm check`.

Doing it by hand is the same four edits: copy `messages/en.ts`, translate, add one
`LOCALES` entry, import it. Nothing else — the Settings picker, system-language
detection, the `t()` key union, and the copy checks all read the registry.

## Adding copy

1. Add the key to `messages/en.ts` and, if it takes values, to every other catalog
   (`zh-CN.ts` is typed `Messages`, so `tsc` refuses to build until every plain key is
   filled in; plural variants stay optional).
2. Call `t("area.thing")` — or `{ t } = useTranslation()` outside the JSX.
3. Keys are dotted and flat so `t()` stays a checked literal. Group by surface:
   `settings.notifications.*`, `sidebar.*`, `recency.*`.

## Plurals

Give the plain key plus the CLDR categories English uses:

```ts
"turnChanges.editedFiles": "Edited {count} files",
"turnChanges.editedFiles_one": "Edited {count} file",
"turnChanges.editedFiles_other": "Edited {count} files",
```

```tsx
t("turnChanges.editedFiles", { count: files.length });
```

`translate.ts` asks `Intl.PluralRules` for the category and prefers whatever the
active locale defined, so:

- English (and friends) add `_one` / `_other`.
- A language whose grammar has one category — Chinese, Japanese — translates only the
  plain key; every count then reuses it. No variant keys, and `pnpm check` stays green.
- A language with `few` / `many` (Russian, Polish, Arabic) adds those suffixes instead.

A scaffolded catalog repeats English's variants; delete the ones the language does not
use rather than leaving them in English. A key with no plural variants ignores `count`,
so adding plurals to existing copy is never a breaking change.

## Dates, times and numbers

Never call `toLocaleString()` / `toLocaleDateString()` with no locale, and never hardcode
`"en-US"`. Those follow the runtime default — Chromium's UI language — which can disagree
with the language the app is showing.

- Timestamps that read as copy (`"5m"`, `"刚刚"`) go through
  `formatRelativeTime(value, t)` in `src/lib/string-utils.ts`, with the units in the
  `time.*` keys.
- Everything else uses `formatNumber(locale, value)` / `formatDateTime(locale, value)`
  from `format.ts`, both reading `locale` off `useTranslation()`.

## Conventions

- Labels are written in the language itself: `"简体中文"`, not `"Chinese"`.
- Match system tags through `languageTagParts()` (`{ primary, script, region }`),
  never `startsWith` — a script-sensitive locale (`zh-Hant`, `sr-Latn`) has to be
  able to claim its own tags.
- Set `dir: "rtl"` on the `LOCALES` entry for a right-to-left language; the provider
  mirrors it onto `<html dir>`.
- Tests in `tests/unit/i18n.spec.ts` enforce: unique ids, tag shape, no unknown keys,
  every non-partial locale covering every key, and placeholders matching English.

## What this layer does not cover yet

- The Electron main process (`apps/desktop/electron/`): native menus, native dialogs
  and OS notifications are still English. The renderer's preference lives in
  `localStorage`, which the main process cannot read, so this needs its own
  locale channel.
- The rest of the scheduled-tasks UI (view header, filter tabs, editor labels and
  placeholders in `src/features/scheduled-tasks/`) is still hardcoded English. Its
  display formatting is already localised in `scheduled-task-display.ts` — copy that
  needs a translator belongs in the renderer, never in `contracts/`.
- The main process still formats its own timestamps (`electron/conversation/app-store-timeline.ts`,
  `electron/scheduled-tasks/scheduled-task-schedule.ts`) against the runtime default.
