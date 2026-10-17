# pi-gui i18n — contributor notes

> Scope-local companion to the root `AGENTS.md`. Same rules, plus
> conventions specific to files under `apps/desktop/src/lib/i18n/`.
> Lives next to `index.ts` rather than as `AGENTS.md` because the
> file creation hook in this editor blocks new `AGENTS.md` for
> explicit user consent.

## Files in this directory

- `index.ts` — the only runtime module. Exports `t`, `useLocale`,
  `setLocale`, `listLocales`, `localeNativeName`, `localeEnglishName`.
- `dictionaries/en.json` — English baseline. **Source of truth** for
  every key in the other dictionaries; if you add a key, copy the
  English string here first, then translate to the other locales.
- `dictionaries/zh-TW.json` — Traditional Chinese (Taiwan terminology:
  對話串／技能／擴充／工作區／服務商 etc.).
- `dictionaries/zh-CN.json` — Simplified Chinese (simplified glyphs).

A key in `en.json` is **required** whenever a refactor starts using a
key in any component. The other two locales fall back to `en.json`
when a key is missing, so the build never breaks for an untranslated
key — but a missing translation is still flagged in code review.

## Adding a new key

1. Pick a stable snake_case key. Group by feature first, then by label:
   `topbar.new_thread`, `settings.providers.add_endpoint`,
   `palette.filters.workspaces`.
2. Add the English string to `en.json` **first**.
3. Add the zh-TW / zh-CN strings immediately. If you cannot translate
   yet, copy the English value into both — but open a follow-up to
   come back.
4. Place the string in the consumer:

   ```tsx
   import { t } from "../../lib/i18n";
   <button aria-label={t("settings.providers.add_endpoint")}>
     {t("settings.providers.add_endpoint")}
   </button>;
   ```

5. Do **not** translate:
   - Technical identifiers: `API key`, `URL`, `OAuth`, `Provider ID`.
   - Code / CLI samples: anything resembling a shell invocation.
   - File names, branch names, model identifiers.

## Adding a new locale

1. Drop the JSON file under `dictionaries/<bcp47>.json` with **the
   same keys as `en.json`** — missing keys auto-fall-back, but the
   new locale must list every key it intends to support.
2. Register it in `index.ts`: add to `LOCALES` (or whatever the
   constant is named there).
3. Add the language to `settings-general-section.tsx` so users can
   pick it. Order matters: `en` first (default), then alphabetical.
4. Update the topbar's language `<SettingsSelect>` list.
5. Update `README.md` under "Supported locales".

## Persistence

The locale is stored at `localStorage["pi-gui.locale"]`. This is
intentionally renderer-only — the Electron main process is not aware
of the user's language choice. If a future feature needs the locale
in main, plumb it through an IPC call rather than reading
`localStorage` from the main bundle.

Playwright e2e tests assert on **English strings**. Switch to English
at test setup, or extend the test harness to translate assertions,
before adding tests that depend on a non-English locale.

## Things to NOT do

- Do not translate runtime data: provider names fetched at runtime,
  model identifiers from the API, error messages from
  `@earendil-works/pi-coding-agent`. Only translate **static UI**
  text the source author wrote.
- Do not bypass `t()` with raw strings for the chrome covered by
  dictionaries — `pnpm lint` flags it.
- Do not import JSON dictionaries from a component file. Always
  pull from `lib/i18n/index.ts` so locale switching can propagate.

## Verification

- `pnpm --filter @pi-gui/desktop typecheck` — must exit 0.
- `pnpm lint` — must exit 0 (`--max-warnings 0`).
- Manual: open the app, change Language in Settings → General,
  confirm labels update without a reload (they should, via
  `useSyncExternalStore`).

## History

- 2026-10-17: initial scaffolding with 192 keys covering topbar,
  command palette, conversation timeline, settings panels. Persistence
  via `localStorage["pi-gui.locale"]`. Renderer-only; main process
  not touched.
