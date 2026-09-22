---
name: testing-windows-desktop
description: End-to-end test the pi-gui Electron desktop app on Windows. Use when verifying Windows compatibility (dev launcher, PATH, folder picker, integrated terminal / node-pty) or any apps/desktop change on Windows.
---

# Testing the pi-gui desktop app on Windows

## Setup

- Ensure pnpm is available: `corepack enable` then `corepack prepare pnpm@<version from package.json> --activate`.
- Install: `pnpm install` (repo root).
- Launch the app for GUI testing: `pnpm --filter @pi-gui/desktop dev`. Optionally set `PI_APP_USER_DATA_DIR` to an isolated temp dir.
- A working launch prints `starting electron app...` and the renderer dev server (`http://localhost:5173`) and must NOT print `spawn pnpm ENOENT`.

## What renders where

- Empty state: sidebar (New thread / Threads / Skills / Extensions / Settings) + "Open a folder to start".
- Navigation (Settings / Skills / Threads) is a good cheap proof the renderer is interactive.

## Integrated terminal (node-pty / ConPTY) — IMPORTANT gotcha

- The Terminal item in the Open side panel menu is disabled until there is an **active session**: `terminalAvailable={Boolean(selectedSessionKey)}` in `apps/desktop/src/app/App.tsx`.
- Creating a session through the live UI requires a **connected provider/model**. Without provider credentials you CANNOT reach the terminal via the GUI ("No models available" blocks send).
- Workaround that needs no credentials: run a **headless Playwright spec in background test mode**. Use helpers from `apps/desktop/tests/helpers/electron-app.ts`: `launchDesktop(userDataDir, { initialWorkspaces, testMode: "background" })` -> `createNamedThread(window, ...)` -> open Terminal from the Open side panel menu (or press Ctrl+J) -> type a command -> assert `.xterm-rows` text.
- Use a **cross-platform command**: `echo <marker>` works in both `cmd.exe` (Windows default shell via `defaultShellForPlatform()`) and POSIX shells. The existing `tests/core/integrated-terminal.spec.ts` uses `printf`/`pwd`, which do NOT exist in `cmd.exe` — that lane runs on macOS CI only, so don't expect it to pass as-is on Windows.
- Run a single spec: `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/<spec>.spec.ts`. Delete any temporary spec you add after the run.

## Native Windows folder picker

- "Open first folder" opens the real Windows folder dialog (itself a Windows-compat proof).
- Computer-use `type` action may DROP uppercase letters and `:` in the dialog's path field (e.g. `C:\Users\Administrator` becomes `\sers\dministrator`). Workaround: put the path on the clipboard (`Set-Clipboard -Value "<path>"`) and `Ctrl+V` into the Folder field, then Select Folder.

## Cosmetic (not functional) macOS-centric labels on Windows

- Settings shortcut hints may show `Cmd+…` and the integrated-terminal shell field placeholder may read `/bin/zsh`. Display-only; the actual default shell resolves to `cmd.exe`.

## Reporting

- Record GUI interactions with annotations (setup / test_start / assertion). Do not record shell-only runs.
- Mark the live-UI terminal test `untested` (not failed) when blocked by missing provider credentials, and note the headless spec result separately.

## Devin Secrets Needed

- None required for launch / navigation / folder picker / headless terminal test.
- A provider API key (e.g. an LLM provider configured under Settings > Providers) is required only to create a session through the **live UI** and thus exercise the terminal through the GUI.
