# Desktop App

Codex-style Electron shell for `pi`, with Playwright E2E coverage organized by test lane.

## Setup

Install workspace dependencies once:

```bash
pnpm install
```

Build the desktop app:

```bash
pnpm --filter @pi-gui/desktop build
```

Run the app in development:

```bash
pnpm --filter @pi-gui/desktop dev
```

Live agent tests use your existing `pi` runtime and provider auth. If local `pi` runs do not work, the `live` lane will not be meaningful either.

## Test Lanes

Use the smallest lane that matches the changed surface.

- `core`
  Background-friendly Electron UI coverage. This is the default lane for renderer, sidebar, composer, persistence, settings, skills, and worktree UI behavior.

  ```bash
  pnpm --filter @pi-gui/desktop run test:e2e
  pnpm --filter @pi-gui/desktop run test:e2e:core
  ```

- `live`
  Real runtime/provider coverage. Use this when the change depends on an actual run, transcript item, tool call, or background notification.

  ```bash
  pnpm --filter @pi-gui/desktop run test:e2e:live
  ```

- `native`
  macOS OS-surface coverage such as folder pickers, image pickers, and real clipboard paste. This lane is foreground-only and can take focus.

  ```bash
  pnpm --filter @pi-gui/desktop run test:e2e:native
  ```

Run all desktop lanes:

```bash
pnpm --filter @pi-gui/desktop run test:e2e:all
```

## Focus And Foreground Rules

- `core` and most `live` scripts set `PI_APP_TEST_MODE=background` for you. Agents normally should not set that env var manually.
- `native` scripts set `PI_APP_TEST_MODE=foreground` for you and may steal focus.
- If a native test fails, rerun it with a clean foreground window before assuming the product is broken.
- Picker tests rely on macOS Accessibility/UI scripting. If folder or image picker automation cannot type into the dialog, check system Accessibility permissions first.

## Targeted Commands

Use a targeted script while iterating, then rerun the matching lane before closing.

```bash
pnpm --filter @pi-gui/desktop run test:core:worktrees
pnpm --filter @pi-gui/desktop run test:core:persistence
pnpm --filter @pi-gui/desktop run test:live:tool-calls
pnpm --filter @pi-gui/desktop run test:native:paste
pnpm --filter @pi-gui/desktop run test:native:open-folder
pnpm --filter @pi-gui/desktop run test:native:attach-image
```

## Test Conventions

- Shared helpers live in [`tests/helpers/electron-app.ts`](./tests/helpers/electron-app.ts). Extend them instead of adding another Electron harness.
- Prefer real clicks, typing, keyboard shortcuts, and visible assertions.
- Avoid direct IPC shortcuts for visible behavior unless the user surface does not exist yet. If you must use one, document why the surface gap exists.
- `pasteTinyPng()` drives the renderer paste handler directly and is appropriate for background-safe coverage.
- `pasteTinyPngViaClipboard()` uses Electron clipboard plus `webContents.paste()` and is appropriate for foreground/native coverage.

## Lane Map

- `tests/core`: deterministic in-window behavior
- `tests/live`: real agent/runtime behavior
- `tests/native`: macOS OS-surface behavior

Future agents should start by reading this file, `apps/desktop/tests/AGENTS.md`, and the scripts in `apps/desktop/package.json`.
