# Thread switching and continuity

Users keep independent conversations and drafts, switch while an agent works, and return to the same history after restarting the app.

## Sub-features

- `thread-switch-running`: leave Bravo while its real tool is running and view Alpha.
- `thread-isolation`: each selected thread shows its own assistant text and draft.
- `thread-background-completion`: Bravo finishes while Alpha is selected.
- `thread-restart`: both real conversations and their distinct drafts survive app restart.
- `thread-archive-restore`: archive and restore Bravo without losing the conversation or draft.

## How to get to it (user POV)

- Click a thread row in the workspace sidebar.
- Hover a thread and use Archive; expand Archived and use Restore. Archive is also in the thread-actions menu and on Shift+Cmd+A; see [archive](archive.md). The default recipe drives only the hover route.
- Quit and reopen the app, then select either thread.

## Driving it with Playwright

Preconditions: Alpha and Bravo created through the visible composer by the default conversation proof, not injected fixtures.

- **Switch:** click the `.session-row__select` button within the row whose `data-session-id` was read from the active UI. Titles may change automatically; do not depend on generated titles.
- **While running:** after Bravo starts its tool, select Alpha and require Bravo's running indicator to remain set. Verify Alpha's assistant marker and draft; require Bravo's marker absent from Alpha's assistant messages.
- **Background completion:** wait for Bravo's running indicator to clear while Alpha stays selected. Select Bravo, require its assistant marker, and require Alpha's marker absent.
- **Drafts:** enter distinct Alpha/Bravo drafts, switch in both directions, and require the corresponding composer values.
- **Archive:** hover Bravo, click its Archive label, require Alpha selected; expand Archived, hover Bravo and Restore. Verify Bravo's draft on selection.
- **Restart:** close only the owned Electron process and relaunch with the same private profile and agent directory. Require Bravo still selected, then visit both rows and check each assistant marker and draft.
- **Evidence:** retain action traces, per-checkpoint screenshot/ARIA pairs, restart doctor records, completed feature IDs, and process cleanup records.

## Gotchas

- Re-seeding the agent directory between launches invalidates persistence testing.
- Opening New thread and typing without submitting does not prove thread creation.
- The background-completion check means another conversation is selected; the app window stays visible throughout.
