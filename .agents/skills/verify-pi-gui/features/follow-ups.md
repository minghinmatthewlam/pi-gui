# Queued follow-ups and steering

Users can queue another prompt while an agent works or steer the current run. These are important advanced conversation paths and are separate from ordinary send/stop proof.

## Sub-features

- `follow-up-queue`: Enter queues a prompt during an active run.
- `follow-up-steer`: the platform-modified Enter shortcut redirects the current run.
- `follow-up-order`: queued work runs after the current response, with no stuck queue entries.

## How to get to it (user POV)

- While a thread runs, type in its composer and press Enter to queue.
- Use Cmd+Enter on macOS (Control+Enter elsewhere) to steer the active run.

## Driving it with Playwright

Preconditions: explicitly enabled real auth and a working provider/model. Default conversation proof covers ordinary send/stop, not queue/steer. Visible maintenance proof is `scripts/prove.sh --maintenance`.

- **Visible recipe:** `.agents/skills/verify-pi-gui/scripts/prove.sh --maintenance` launches without test mode or test hooks. After a long tool run starts, type a follow-up and press Enter; require a `queued-composer-message` containing that prompt. Type a steer marker and press the platform-modified Enter shortcut (`Control+Enter` here, `Cmd+Enter` on macOS). Require `STEER_DONE` then `FOLLOW_UP_DONE` in assistant-only timeline text, idle, and no remaining queued messages.
- **Existing live spec:** `pnpm --filter @pi-gui/desktop run test:e2e:runner apps/desktop/tests/live/queued-messages.spec.ts` uses `PI_APP_REAL_AUTH=1` and `PI_APP_REAL_AUTH_SOURCE_DIR`. It currently launches in background mode; do not treat it as the visible proof.

## Gotchas

- A skipped real-auth spec is not a pass. Capture the unmet precondition.
- Do not infer steering success from prompt text appearing in the transcript; check assistant-only content.
- Treat this map entry as required when changing queue/steering behavior, and report it separately if not run.
