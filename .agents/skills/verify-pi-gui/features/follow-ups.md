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

Preconditions: explicitly enabled real auth and a working provider/model. This flow is not exercised by the default conversation proof yet.

- **Existing recipe:** `pnpm --filter @pi-gui/desktop run test:e2e:runner apps/desktop/tests/live/queued-messages.spec.ts` uses `PI_APP_REAL_AUTH=1` and `PI_APP_REAL_AUTH_SOURCE_DIR`. It currently launches in background mode; adapt its UI actions to the visible no-test-hook harness before claiming visible proof.
- **Queue:** type a follow-up during a running tool and press Enter; require a `queued-composer-message` containing that prompt.
- **Steer:** type a replacement instruction and use the platform-modified Enter shortcut. Require the response to follow the new instruction, not merely echo it in the user transcript.
- **Order:** require the assistant's steered response before the queued follow-up response, a final idle state, and no `queued-composer-messages` remaining.

## Gotchas

- A skipped real-auth spec is not a pass. Capture the unmet precondition.
- Do not infer steering success from prompt text appearing in the transcript; check assistant-only content.
- Treat this map entry as required when changing queue/steering behavior, and report it separately if not run.

## Maintenance coverage

The normal-mode `scripts/prove.sh --maintenance` now covers queue/keyboard-steer/order with assistant-only assertions. Queue-row Edit, Cancel, Delete and Steer controls also exist (`queued-composer-messages.tsx`); this journey does not yet cover those controls.
