# Queued follow-ups and steering

Users can queue another prompt while an agent works or steer the current run. These are important advanced conversation paths and are separate from ordinary send/stop proof.

## Sub-features

- `follow-up-queue`: Enter queues a prompt during an active run.
- `follow-up-steer`: the platform-modified Enter shortcut redirects the current run.
- `follow-up-order`: queued work runs after the current response, with no stuck queue entries. A message queued just as a reply ends starts as the next turn once the thread is idle; a queued steer goes before follow-ups.
- `follow-up-layout`: long queued text, even one unbroken token, wraps and scrolls inside a height-capped queue list so the composer and send button stay on screen.

## How to get to it (user POV)

- While a thread runs, type in its composer and press Enter to queue.
- Use Cmd+Enter on macOS (Control+Enter elsewhere) to steer the active run. A steer is added to the transcript at once and never appears in the queue list.
- Clicking the send button with text in the composer also queues. Each queued item has Steer, Edit and Delete buttons, except that a queued message carrying Add to Chat annotations reads "<text> · N annotations" (or "1 annotation") and has no Edit; its Delete label uses the raw message text, not that preview. Stop run (empty composer) clears the whole queue.

## Driving it with Playwright

Preconditions: explicitly enabled real auth and a working provider/model. Default conversation proof covers ordinary send/stop, not queue/steer. Visible maintenance proof is `scripts/prove.sh --maintenance`.

- **Visible recipe:** `.agents/skills/verify-pi-gui/scripts/prove.sh --maintenance` launches without test mode or test hooks. After a long tool run starts, type a follow-up and press Enter; require a `queued-composer-message` containing that prompt. Type a steer marker and press the platform-modified Enter shortcut (`Control+Enter` here, `Cmd+Enter` on macOS). Require `STEER_DONE` and `FOLLOW_UP_DONE` once each in assistant-only timeline text, the steered reply before the follow-up, idle, and no remaining queued messages. The per-item Steer/Edit/Delete buttons and Stop clearing the queue are not driven.
- **Existing live spec:** `pnpm --filter @pi-gui/desktop run test:e2e:runner apps/desktop/tests/live/queued-messages.spec.ts` uses `PI_APP_REAL_AUTH=1` and `PI_APP_REAL_AUTH_SOURCE_DIR`. It currently launches in background mode; do not treat it as the visible proof.
- **Queue edge cases:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/queued-messages.spec.ts` covers per-item editing, follow-ups versus steers in the timeline, and the long-token layout. The end-of-reply queue race is proven only by the driver test `packages/pi-sdk-driver/test/queue-after-settle.test.mts`; live UI timing cannot force it.

## Gotchas

- A skipped real-auth spec is not a pass. Capture the unmet precondition.
- Do not infer steering success from prompt text appearing in the transcript; check assistant-only content.
- Treat this map entry as required when changing queue/steering behavior, and report it separately if not run.
