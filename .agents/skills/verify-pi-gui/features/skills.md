# Skills

Users browse workspace skills, inspect a skill, and insert its command into the conversation composer.

## Sub-features

- `skills-browse`: discover a workspace skill and inspect its detail.
- `skills-try`: insert its slash command through Try.
- `skills-alias`: find a skill using its name or full command.

## How to get to it (user POV)

- Click Skills in the sidebar, choose a skill, then Try.
- Type `/skill` or a skill-name alias into the thread composer.

## Driving it with Playwright

Preconditions: isolated workspace containing the Demo Skill/Plan Loop fixtures created by the spec; an existing fixture thread.

- **Visible maintenance:** `.agents/skills/verify-pi-gui/scripts/prove.sh --maintenance` opens Skills, requires Demo Skill, clicks Try, and checks composer `/skill:demo-skill `. It then fills `/plan`, `/plan-loop`, and `/skill:plan-loop` and requires `slash-menu` to contain Plan Loop. It seeds those skill files in a scratch Git workspace; it does not execute the skill through a provider.
- **Core regression:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/skills-settings.spec.ts`.
- **Browse:** click the exact Skills button, require `skills-list` to contain Demo Skill, click the Demo Skill button, and require `.skill-detail` to contain `/skill:demo-skill`.
- **Try:** click the exact Try button. `composer` must contain `/skill:demo-skill `.
- **Alias:** fill `composer` with `/plan`, `/plan-loop`, and `/skill:plan-loop` separately; `slash-menu` must contain Plan Loop and its full command.
- **Proof:** capture the selected skill, Try action, resulting composer value, and each alias menu. Settings-toggle coverage is mapped separately.

## Gotchas

- Inserting a command does not prove executing the skill through a provider.
- The skill preference can intentionally hide slash commands. Check it before interpreting a missing menu as a discovery failure.
