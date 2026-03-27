# Desktop Test Guidelines

Apply these rules under `apps/desktop/tests/`.

- Use the lane scripts in `apps/desktop/package.json` before inventing ad hoc Playwright commands.
- Pick the smallest lane that matches the changed surface:
- `core`: background-friendly UI flows inside the Electron window. Default for renderer, sidebar, composer, session, persistence, and worktree UI changes.
- `live`: real provider/runtime runs. Use for transcript, tool-call, parallel-run, and notification behavior that depends on actual agent execution.
- `native`: macOS OS-surface flows such as folder pickers, image pickers, and real clipboard paste. These are foreground-only and focus-sensitive.
- `pnpm --filter @pi-gui/desktop run test:e2e` currently runs only `core`. Use `test:e2e:all` only when you need all lanes.
- Prefer shared helpers in `tests/helpers/electron-app.ts`; extend them instead of adding a second harness or new IPC glue.
- Simulate user behavior through Playwright first. Do not add IPC/state shortcuts for visible behavior unless the product surface does not exist yet; if you need one, document the gap in the spec.
- `pasteTinyPng()` proves the renderer paste handler and is suitable for background/core coverage.
- `pasteTinyPngViaClipboard()` proves real Electron clipboard paste and belongs in foreground/native coverage.
- Native failures can be environmental. Before treating a native failure as a product regression, rerun with a clean foreground window and no competing keyboard or mouse input.
