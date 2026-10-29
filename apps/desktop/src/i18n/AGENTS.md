# Desktop i18n

The desktop app ships its own translation layer under `apps/desktop/src/i18n/`, with
no i18n framework and no build step. English is the source of truth and the fallback.
Every other language is a partial copy of the same keys: a key a locale leaves out
renders in English.

## Files

| File                | Job                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `messages/en.ts`    | English copy. `MessageKey` is derived from it, so it defines the key set.                  |
| `messages/<tag>.ts` | One file per other language, typed `Partial<Messages>`.                                    |
| `catalog.ts`        | The locale registry: the only place a language is declared.                                |
| `preference.ts`     | The user's choice (`"system"` or a locale id) and how it resolves.                         |
| `translate.ts`      | Pure translation: interpolation, plural forms, fallback chain.                             |
| `plural.ts`         | The CLDR plural categories shared by the message type, the translator and the copy checks. |
| `index.tsx`         | React binding: `I18nProvider`, `useI18n()`, `useTranslation()`.                            |

## Adding copy

1. Add the key to `messages/en.ts`. That is all a UI change has to do: other locales
   render the English copy until a translator adds the key.
2. Call `t("area.thing")`, or `const { t } = useTranslation()` in a component.
   `t()` accepts only keys that exist in `en.ts`, so a typo fails `tsc`.
3. Keys are dotted and flat so `t()` stays a checked literal. Group by surface:
   `settings.notifications.*`, `secondarySurface.*`.

## Adding or finishing a language

```sh
pnpm i18n:new fr "Français"     # or: node scripts/new-locale.mjs fr "Français"
pnpm i18n:check fr              # lists keys that are missing or still read English
pnpm i18n:check                 # the same report for every non-English catalog
```

`i18n:new` writes `messages/fr.ts` (every plain key, English values, as a starting
point) and registers the locale in `catalog.ts`. Translate the values; delete any entry
you do not translate rather than leaving it in English. `i18n:check` is a report, not
a gate: it exits 0 however much is untranslated and is not part of `pnpm check`.

The scaffolded matcher claims every tag with the same primary language. A
script- or region-specific locale (`zh-Hant`, `pt-PT`) must sit ahead of the broader
one in `LOCALES` and match on `script` or `region`, since the first match wins.

Doing it by hand is the same two edits: write `messages/<tag>.ts`, then import it and
add one `LOCALES` entry. The Settings picker, system-language detection, the `t()`
key union, and the copy checks all read the registry.

## Plurals

Give the plain key plus the CLDR categories English uses:

```ts
"models.count": "{count} models",
"models.count_one": "{count} model",
"models.count_other": "{count} models",
```

```tsx
t("models.count", { count: models.length });
```

`translate.ts` asks `Intl.PluralRules` for the category and prefers whatever the
active locale defined, so:

- English adds `_one` / `_other`.
- A language whose grammar has one category (Chinese, Japanese) translates only the
  plain key; every count then reuses it.
- A language with `few` / `many` (Russian, Polish, Arabic) adds those suffixes.
  `Messages` accepts any CLDR category for a key English gives plural forms to.

When a locale has no copy for a counted key, the English copy is picked with English
plural rules. A key with no plural variants ignores `count`, so adding plurals to existing copy is
never a breaking change.

## Dates, times and numbers

Do not call `toLocaleString()` / `toLocaleDateString()` without a locale, and do not
hardcode `"en-US"`. Those follow Chromium's UI language, which can disagree with the
language the app is showing. Pass `locale` from `useTranslation()` to `Intl`.

## Conventions

- Labels are written in the language itself: `"简体中文"`, not `"Chinese"`.
- Match system tags through `languageTagParts()` (`{ primary, script, region }`), not
  `startsWith`, so a script-sensitive locale (`zh-Hant`, `sr-Latn`) can claim its own
  tags.
- Set `dir: "rtl"` on the `LOCALES` entry for a right-to-left language; the provider
  mirrors it onto `<html dir>`.
- `tests/unit/i18n.spec.ts` enforces unique ids, tag shape, no keys that English does
  not have, and placeholders matching English. `tests/unit/renderer-copy.spec.ts`
  fails on literal English in the JSX of translated surfaces; add a surface there once
  it is translated.
- The provider follows a choice made in another window (`storage` event) and an OS
  language change while the preference is `"system"` (`languagechange`).

## Coverage

- Translated: Settings (every section and the Settings navigation) and the shell
  around it (`src/app/secondary-surface.tsx`).
- Still English: every other renderer surface, and the Electron main process (native
  menus, dialogs, OS notifications). The preference lives in renderer `localStorage`,
  which the main process cannot read, so main needs its own locale channel.
