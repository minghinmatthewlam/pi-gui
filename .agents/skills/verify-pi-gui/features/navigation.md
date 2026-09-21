# Folders and threads

Users switch folders and conversations in the sidebar and recover the selected thread and unfinished draft after reopening the app.

## Sub-features

- `navigation-sidebar`: select threads across folders.
- `navigation-recency`: The sidebar header customize icon opens Grouping, with Time or Workspace. Time is the default: date buckets (Today / Last 7 Days / Last 30 Days / Older) across folders, five threads then Show more, no folder header once that folder has a thread. Workspace nests threads under each folder, sorted by last user message. Send bumps recency; open/focus/viewed do not. ⌘1…⌘9 follow the visible sidebar rows, pinned threads first. Holding Command (Ctrl on Windows and Linux) paints those badges; release hides them.
- `navigation-restart`: preserve selected folder, thread, and composer draft.
- `navigation-new-thread`: open the new-thread composer.
- `navigation-pinning`: pin/unpin, reorder pinned threads, and preserve pin state across restart.
- `navigation-pinning-running`: pin/unpin immediately while a composer prompt is still running.

## How to get to it (user POV)

- Select a folder/thread in the sidebar.
- Send in a thread and confirm it moves to the top of Today. Opening the same thread must leave its bucket unchanged. ⌘1 stays the first pinned thread, or the first visible row when nothing is pinned. Empty date buckets stay hidden.
- Hover a thread and click Pin; click its Unpin icon in the Pinned section.
- Click New thread in the sidebar or use the new-thread keyboard shortcut (Meta+Shift+O on macOS; Control+Shift+O elsewhere).
- Open a folder through the OS folder picker; this is a separate native entry.

## Driving it with Playwright

Preconditions: isolated profile and two fixture folders for sidebar switching.

- **Switch/restart:** run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/navigation.spec.ts`. It selects Alpha/Beta sessions through the sidebar, asserts `.topbar__session`, and checks `composer` draft and `.session-row--active` after restart.
- **New-thread entry:** run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/composer-controls.spec.ts`; `new-thread-composer` must become visible and focused after the shortcut.
- **Folder picker:** use `pnpm --filter @pi-gui/desktop run test:prod:open-folder-real` for the actual native dialog; reserve foreground input. Core `initialWorkspaces` is fixture setup, not picker proof.
- **Visible maintenance:** `.agents/skills/verify-pi-gui/scripts/prove.sh --maintenance` starts threads with New thread and Start thread until the Today bucket shows `Show more Today`, then clicks Show less Today. It also pins and unpins the active row while that run still reports running. It does not insert sessions through IPC.
- **Pinning:** run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/sidebar-ordering.spec.ts apps/desktop/tests/core/stop-running-prompt.spec.ts`. The first spec covers ordering, pin persistence after relaunch, unpinning and repinning. The second holds the real submit IPC open with a controlled driver, clicks Unpin and Pin, and requires each change while the row still reports running; Stop must still work afterward. This is fixture-backed Electron proof; `--maintenance` adds the live-provider pin/unpin.
- **Recency list:** run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/sidebar-recency.spec.ts`. The customize icon’s Grouping submenu defaults to Time and stays only as wide as Time and Workspace. Threads from mixed folders share Today / Last 7 Days / Last 30 Days / Older, five per bucket then Show more, with no folder header for a folder that has threads. Workspace grouping nests those threads under the folder in last-send order and that choice survives restart. Click does not bump. Send bumps Today. `Meta+1` / `Control+1` selects the first pinned thread, then the other visible rows. Holding Meta or Control paints those badges and release removes them. A newer send does not take slot 1 from a pin. The core spec seeds sessions through IPC. `--maintenance` is the New thread path for Show more Today, then switches Grouping to Workspace so the folder row (and its actions menu) is on screen.
- **Proof:** record the selected row, topbar title, draft before shutdown and after relaunch, with action traces. Cover sidebar and keyboard entries separately when claiming both.

## Gotchas

- `createNamedThread` uses IPC; this existing spec proves selection/draft behavior, not user-driven thread creation or provider execution.
- The recency spec also seeds sessions through IPC and older `catalogs.json` / `lastInteractedAt` timestamps; it proves list shape and shortcuts, not New thread.
- Injected transcript deltas establish renderer behavior only; real run proof belongs in live.
- Testing unpin only while idle or after restart misses action-queue blocking. Require the pin change before the active prompt completes. For live-provider confirmation, exercise the same controls during a real running follow-up and check that the run continues; the default conversation recipe does not currently include this checkpoint.
