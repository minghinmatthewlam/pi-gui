# Settings and persistence

Users change app preferences in Settings and expect them to survive returning to the app and restarting it.

## Sub-features

- `settings-open`: reach Settings and return to the app.
- `settings-skill-commands`: toggle skill command availability.
- `settings-persistence`: retain the preference after restarting Electron.

## How to get to it (user POV)

- Click Settings in the sidebar; click Back to app to leave.
- Use the app's Settings shortcut (Meta+, on macOS; Control+, elsewhere), covered separately by `composer-controls.spec.ts`.

## Driving it with Playwright

Preconditions: isolated built app; no provider login needed.

- **Persist preference:** run `.agents/skills/verify-pi-gui/scripts/prove.sh --smoke`. It clicks Settings, walks Appearance, Providers, Models, Notifications, and General, flips the checkbox named `Enable skill slash commands`, opens Skills and New thread, then asserts the opposite checkbox value after a complete restart.
- **Shortcut entry:** run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/composer-controls.spec.ts`; inspect the shortcut case and `settings-surface` visibility. The bundled smoke covers only the sidebar entry.
- **Behavioral effect:** run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/skills-settings.spec.ts`; disabling the preference hides `slash-menu` for `/skill`, enabling it restores the seeded skill in the menu.
- **Proof:** inspect before/change/restart screenshots, action traces, restart ARIA snapshot, identity and cleanup JSON. The second process must read the changed checkbox value.

## Gotchas

- A changed checkbox in one window does not prove persistence.
- The smoke preserves its isolated profile as evidence; it does not modify the user's profile.
- Notification permission tests use OS-boundary doubles in core. They do not prove real macOS authorization.
