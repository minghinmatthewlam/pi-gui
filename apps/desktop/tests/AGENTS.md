# Desktop Test Guidelines

Apply these rules under `apps/desktop/tests/`.

- Use the lane scripts in `apps/desktop/package.json` before inventing ad hoc Playwright commands.
- Pick the smallest lane that matches the changed surface:
- `unit`: Node-level logic, storage and local Git contracts without launching Electron. Required through `pnpm check`.
- `core`: credential-free Electron UI and local runtime integration, including deterministic local extensions and injected-event regressions. Required on every PR through four Linux (Xvfb) shards with two workers each; pushes to `main` rerun it on four macOS shards, one worker per runner, so macOS-only specs gate only after merge. Local Linux background runs use three workers by default; set `PI_APP_TEST_WORKERS` to a positive integer to change that anywhere. Workers on one display share its clipboard, so run a clipboard failure alone to tell contention from a regression, then fix the contention. Use isolated fixtures; no real-auth source. Default for renderer, sidebar, composer, session, persistence, and worktree UI changes.
- `live`: actual external-provider requests. The lane command requires explicit real-auth opt-in and an existing auth source before building. Use real-provider coverage for transcript, tool-call and parallel-run behavior that depends on actual agent execution. A skipped run is not provider proof.
- `native`: macOS OS-surface flows such as keyboard shortcut routing, real clipboard paste, minimize and refocus. These are foreground-only and focus-sensitive. A stubbed picker result proves only application handling and belongs in Core; do not claim it proves OS picker selection.
- `production`: opt-in higher-fidelity smokes such as real-auth `live`, packaged-app launch, and real macOS open-panel coverage. Keep these out of the default `core` and `native` globs so fast lanes stay stable.
- `pnpm --filter @pi-gui/desktop run test:e2e` currently runs only `core`. `test:e2e:all` runs core, live, and native; it does not include production, dev, or demo specs.
- For `native`, prefer the targeted native spec by default. Expand to `test:e2e:native` only when the change touches shared native helpers, multiple native specs, or lane-wide native behavior.
- Keep `tests/production` behind dedicated scripts or direct `test:e2e:runner` invocations; do not place those specs under `tests/core` or `tests/native`.
- Prefer repo lanes over manual Computer Use. If the local Codex skill `$pi-gui-computer-use-smoke` is installed, use it only for release-readiness sweeps on the real installed app or for focus-hostile native surfaces where Playwright is the wrong proof shape.
- The reasoning is the same as the global agent philosophy: optimize for tools plus clear success criteria, not ad hoc manual steps. Playwright remains the deterministic regression signal; Computer Use is an opt-in complement for believable real-surface proof.
- Prefer shared helpers in `tests/helpers/electron-app.ts`; extend them instead of adding a second harness or new IPC glue.
- Simulate user behavior through Playwright first. Do not add IPC/state shortcuts for visible behavior unless the product surface does not exist yet; if you need one, document the gap in the spec.
- `pasteTinyPng()` proves the renderer paste handler and is suitable for background/core coverage.
- `pasteTinyPngViaClipboard()` proves real Electron clipboard paste and belongs in foreground/native coverage.
- Native failures can be environmental. Before treating a native failure as a product regression, rerun with a clean foreground window and no competing keyboard or mouse input.
- Report which evidence actually ran: fixture-backed Electron, deterministic runtime integration, real-provider conversation, native OS, or packaged artifact. For visible conversation proof without injected events, use the checked-in [verify-pi-gui skill](../../../.agents/skills/verify-pi-gui/SKILL.md); its settings smoke is not conversation proof.
- Real-auth `live` specs must opt in explicitly via `PI_APP_REAL_AUTH=1` plus `PI_APP_REAL_AUTH_SOURCE_DIR=/absolute/path/to/agent`; raw spec discovery may skip without these, but an explicitly requested live lane must fail preflight rather than report an all-skipped success.

## Flaky tests

- A flake is a bug in the test or the product. Never retry, skip, quarantine or raise a timeout to get green: find the race, fix it, and say what it was.
- Wait on the app's real state, not on what happens to be visible. Content that paints before an async step settles (an extension frame before it reports ready, a row before a pin round-trip moves it) is not readiness. When no observable state exists, expose one on the surface (for example `data-state` on `extension-view-panel`) and wait on it with a shared helper.
- Do not race product calls against wall-clock deadlines. Assert the behavior (a call returned while its work is still pending) against a fixture that makes the alternative impossible.
- If a flaky test checks nothing a user would notice, propose rewriting or removing it rather than keeping it green.
