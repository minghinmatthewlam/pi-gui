# Scheduled tasks

Users create local on-device schedules from the Scheduled sidebar, a thread menu, or an agent tool, then see a labeled user bubble when a due task fires.

## Sub-features

- `scheduled-list`: open Scheduled, create a manual task, filter Active, persist after restart.
- `scheduled-interview`: Create with pi prefills the interview draft and does not send.
- `scheduled-fire`: a due task sends its instruction and labels **Sent by scheduled task**.
- `scheduled-tool`: `create_scheduled_task` / `list_scheduled_tasks` / `update_scheduled_task` mutate the same records.

## How to get to it (user POV)

- Click Scheduled in the sidebar.
- Choose Create ▾ → Set up manually, or Create with pi.
- From a thread, open the header ⋯ and choose Add scheduled task… / Edit scheduled task….

## Driving it with Playwright

Preconditions: isolated profile and fixture folder. Core coverage is credential-free; do not fake `auth.json` / `~/.pi`.

- **Run:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/scheduled-tasks.spec.ts apps/desktop/tests/core/scheduled-task-runtime-tools.spec.ts`.
- **List/create:** click Scheduled, Set up manually, fill title and instruction, Create. Active should show the row and next-run copy. Pause, then restart the same profile.
- **Interview:** Create with pi. Composer must contain the interview prompt and the transcript must have no assistant row.
- **Fire:** bind a due once/interval task to the selected thread, call the test-mode fire hook, require `sent-by-scheduled-task`.
- **Tool:** `runScheduledTaskRuntimeTool` with `create_scheduled_task`. The snapshot must contain the new task id.

This is fixture-backed Electron proof, not real-provider interview execution. A live tool-call interview belongs only behind `PI_APP_REAL_AUTH=1`.

## Gotchas

- Tasks run only while pi-gui is open on this device.
- Fire of `new-thread` must not steal the selected session.
- Corrupt `scheduled-tasks.json` must not block the rest of the app.
