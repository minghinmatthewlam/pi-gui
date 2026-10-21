# apps/desktop i18n scaffold

The renderer ships three locale dictionaries in `dictionaries/` (`en.json`,
`zh-TW.json`, `zh-CN.json`) and a small reactive store in `index.ts`. The
`useLocale()` hook subscribes components to the active locale, so a switch in
Settings flips every translated string on next render.

## Public API

- `t(key, vars?)` — look up a string in the active dictionary and fall back to
  English. `{name}` tokens in the template are interpolated from `vars`; missing
  variables are left literal so missing data is obvious in QA.
- `useLocale()` — returns the active `LocaleId`. Calling this subscribes the
  component to locale changes (the renderer re-renders on every switch).
- `setLocale(id)` — persist + switch. Stored under `localStorage` key
  `pi-gui.locale`.
- `listLocales()` — descriptor list used by the Language switcher.
- `localeNativeName(id)` / `localeEnglishName(id)` — helpers for tooltips.

## Conventions

- Keys are `snake_case`, namespaced by the section they describe
  (`topbar.*`, `palette.*`, `settings.appearance.*`, `settings.notifications.*`,
  …). When in doubt, mirror the JSX tree: a heading under `Settings › General ›
Agent` belongs at `settings.general.agent.*`.
- The English dictionary is the source of truth — copy the literal string out
  of the JSX, do not paraphrase. The English values also drive the fallback
  when a non-English dictionary is missing a key, so every key referenced from
  the renderer MUST exist in `en.json`.
- Keep the `LocaleId` union in sync with the supported set: today
  `en | zh-TW | zh-CN`. Adding a locale means adding the dictionary file,
  extending the union, and updating `listLocales()`.
- Components that show translated UI MUST call `useLocale()` so they re-render
  on switch. The store is implemented with `useSyncExternalStore`, mirroring
  `apps/desktop/src/ui/active-theme.ts`.
- Do NOT put dynamic strings in dictionaries (provider names, model labels,
  error messages from the runtime, …). Only translate the static UI chrome.
- For interpolated values, prefer short, descriptive names:
  `t("palette.files.empty.type_to_search", { count })`.

## Adding a new key

1. Pick the most specific existing namespace (or extend one — keep names
   short: `settings.notifications.background_completion.title`).
2. Add the entry to **all three** dictionaries. The English value is the
   exact string that was in the JSX before the refactor. Traditional and
   Simplified Chinese values must respect the conventions in this repo
   (thread = 對話串/会话串, workspace = 工作區/工作区, worktree =
   工作樹/工作树, skill = 技能, extension = 擴充/扩展, provider =
   服務商/服务商, fork = 分岔/分叉, composer = 撰寫區/撰写区).
3. Replace the JSX literal with `t("your.new.key")`. Use `vars: { name }` for
   interpolated values; the placeholder syntax is `{name}`.
4. For lists of buttons / tabs / sections, prefer keeping the id stable and
   resolving the label through `t()` at render time (see
   `palette-sections.ts` → `buildCommandFilters`).
5. If the new string lives in a component that wasn't already subscribing,
   add `useLocale()` at the top of the component so it refreshes on switch.
6. Run `pnpm --filter @pi-gui/desktop typecheck` and `pnpm lint`.

## Adding a new locale

1. Copy `dictionaries/en.json` to `dictionaries/<id>.json` and translate.
2. Add `<id>` to `LocaleId`, `SUPPORTED_LOCALES`, and `LOCALE_DESCRIPTORS` in
   `index.ts`. Set `englishName` to the language's English name; `nativeName`
   is resolved via the `app.locale.<id>` key in the dictionary.
3. Add an `app.locale.<id>` entry to all three dictionaries (the existing
   locale names are localized, e.g. `app.locale.zh-TW` resolves to "繁體中文"
   in the zh-TW dictionary).

## What is intentionally NOT translated

- Provider / model / extension names — they are runtime data.
- File paths, branch names, workspace names — runtime data.
- Error messages coming from the runtime (`api.setActiveView` failures, etc.).
- Keyboard key glyphs (`↑`, `⌘`, `↩`, `Tab`, `Esc`) — they are part of the
  shortcut legend, not prose.
- `data-testid` and similar test hooks.

## Out of scope for now

- Persisting locale through the Electron bridge. The current build keeps the
  choice in `localStorage`, which survives reloads in the renderer but not a
  full main-process reinstall. Hoisting it into `DesktopAppState` would
  require touching the persistence layer in `apps/desktop/electron/`, which
  the parent explicitly deferred.
