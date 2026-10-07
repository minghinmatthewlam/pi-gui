# Settings and persistence

Users change app preferences in Settings and expect them to survive returning to the app and restarting it.

Settings is one shell: a sidebar with Back to app, a Search box, and grouped pages. App: General (model settings scope, Enable skill slash commands, shell path), Appearance, Notifications, Keyboard shortcuts. Agent: Providers, Models, MCP servers (all three need an open workspace; Providers and MCP servers always show a workspace picker, Models only in Per repo scope). MCP servers lists the global `mcp.json` and the project's `.pi/mcp.json` servers, each with an `Enable <name>` switch (Remove on global servers only), an Add server form (Name, What it does, Command or URL), and a Code mode "Always on" switch (`Code mode always on`). Customize: Skills and extensions, which keeps the Settings sidebar but renders `skills-surface` / `extensions-surface` instead of `settings-surface`. Escape leaves Settings unless a dialog is open or Search has text (the first Escape clears Search). Extensions has a "pi-gui tools" group with app-wide switches such as "Enable Scheduled tasks", and a "Built into pi" group for pi's own add-ons (MCP, code mode, tool search). Settings reopens on the last page visited in this session. A restart reopens the last view (Settings, Skills, Extensions or Scheduled), but the Settings page itself resets to General after a restart or in a new window.

## Sub-features

- `settings-open`: reach Settings and return to the app.
- `settings-skill-commands`: toggle skill command availability.
- `settings-persistence`: retain the preference after restarting Electron.

## How to get to it (user POV)

- Click Settings in the sidebar; click Back to app to leave.
- Cmd-K lists Settings and "Settings: <page>" entries; the sidebar Skills and Extensions buttons open Customize inside this shell.
- Use the app's Settings shortcut (Meta+, on macOS; Control+, elsewhere), covered separately by `composer-controls.spec.ts`.

## Driving it with Playwright

Preconditions: isolated built app; no provider login needed.

- **Persist preference:** run `.agents/skills/verify-pi-gui/scripts/prove.sh --smoke`. It clicks the exact Settings button, visits six of the seven App and Agent pages checking each header (it skips MCP servers), toggles the switch named `Enable skill slash commands`, goes Back to app to open Skills and New thread, and asserts the opposite switch value after a complete restart. It does not drive Search, Escape, or the Customize entry.
- **Shortcut entry:** run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/composer-controls.spec.ts`; inspect the shortcut case and `settings-surface` visibility. The bundled smoke covers only the sidebar entry.
- **Behavioral effect:** run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/skills-settings.spec.ts`; disabling the preference hides `slash-menu` for `/skill`, enabling it restores the seeded skill in the menu.
- **Per-page regressions:** `settings-appearance.spec.ts`, `settings-general.spec.ts`, `provider-settings.spec.ts`, `model-scope-toggle.spec.ts`, `notification-settings.spec.ts`, `mcp-settings.spec.ts` (add, switch and remove a server, Code mode, and refusing a server Settings cannot run) under `apps/desktop/tests/core`. `extensions.spec.ts` covers the Thread orchestration switch surviving restart; no spec turns off Enable Scheduled tasks or proves its tools disappear.
- **Proof:** inspect before/change/restart screenshots, action traces, restart ARIA snapshot, identity and cleanup JSON. The second process must read the changed switch value.

## Gotchas

- A changed checkbox in one window does not prove persistence.
- The smoke preserves its isolated profile as evidence; it does not modify the user's profile.
- Notification permission tests use OS-boundary doubles in core. They do not prove real macOS authorization.
