# Skills

Users browse workspace skills, inspect a skill, and insert its command into the conversation composer.

## Sub-features

- `skills-browse`: discover a workspace skill and inspect its detail.
- `skills-try`: insert its slash command through Try.
- `skills-alias`: find a skill using its name or full command.

## How to get to it (user POV)

- Click Skills in the sidebar, or Settings → Skills and extensions, choose a skill row to open its detail page, then Try. Escape or "All skills" returns to the list.
- The page has Skills and Extensions tabs with counts, Search, a workspace picker, Refresh, and New skill. The detail page also has Open folder. Try returns to Threads with the command in the composer.
- Type `/skill` or a skill-name alias into the thread composer.

## Driving it with Playwright

Preconditions: isolated workspace containing the Demo Skill/Plan Loop fixtures created by the spec; an existing fixture thread.

- **Visible maintenance:** `.agents/skills/verify-pi-gui/scripts/prove.sh --maintenance` opens Skills, requires Demo Skill, clicks Try, and checks composer `/skill:demo-skill `. It then fills `/plan`, `/plan-loop`, and `/skill:plan-loop` and requires `slash-menu` to contain Plan Loop. It seeds those skill files in a scratch Git workspace; it does not execute the skill through a provider.
- **Core regression:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/skills-settings.spec.ts`.
- **Browse:** click the exact Skills button, require `skills-surface` and a `skills-list` containing Demo Skill (rows are grouped by Workspace, User, and This session; six per group, then Show N more), click the Demo Skill row button, and require `.skill-detail` to contain `/skill:demo-skill`. The row's switch (`Enable Demo Skill`) and the detail's `Enabled` switch toggle the skill.
- **Try:** click the exact Try button. `composer` must contain `/skill:demo-skill `.
- **Alias:** fill `composer` with `/plan`, `/plan-loop`, and `/skill:plan-loop` separately; `slash-menu` must contain Plan Loop and its full command.
- **Proof:** capture the selected skill, Try action, resulting composer value, and each alias menu. Settings-toggle coverage is mapped separately.

Extensions (the Extensions tab, the sidebar Extensions button, the extension dock, dialogs and view panel) have no feature file and no `prove.sh` lane; only `apps/desktop/tests/core/extension*.spec.ts` covers them.

## Gotchas

- Inserting a command does not prove executing the skill through a provider.
- The skill preference can intentionally hide slash commands. Check it before interpreting a missing menu as a discovery failure.
