# Archive and restore

Users hide a thread from the active sidebar and recover it from the Archived group.

## Sub-features

- `archive-hover`: reveal the archive action and archive an active thread.
- `archive-expand`: expand the collapsed Archived group.
- `archive-restore`: restore a thread to the active list.

## How to get to it (user POV)

- Hover a thread row and click its Archive action (tooltip shows ⇧⌘A).
- Or choose Archive thread from the thread-actions menu (header Thread actions button, right-click a row, or Cmd-K), or press Shift+Cmd+A (Shift+Control+A elsewhere) on the selected thread. There is no confirmation.
- Expand Archived (collapsed by default), hover the archived row, and click Restore, or right-click it and choose Restore thread. Restore has no shortcut.

## Driving it with Playwright

Preconditions: isolated workspace with fixture threads Thread one and Thread two.

- **Primary proof:** the default conversation recipe archives and restores a real thread; see [thread continuity](thread-continuity.md).
- **Additional regression:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/archive.spec.ts`. Menu and shortcut routes: `apps/desktop/tests/core/thread-menu.spec.ts`.
- **Archive:** hover the active `.session-row` for Thread two and click `getByLabel('Archive Thread two')`. Because Thread two was selected, the topbar switches to Thread one (selection only moves when the archived thread was selected) and `.archived-thread-group` appears collapsed.
- **Expand/restore:** click `.archived-thread-group__toggle`, require `aria-expanded="true"`, then hover the archived row and click `getByLabel('Restore Thread two')`. Archived rows always show their folder, so the full label is `Restore <title> in <folder>`; the locator relies on substring matching.
- **Proof:** Thread two returns to the active session list, the now-empty archived group disappears, and read-only state confirms `archivedAt` is cleared. Capture before/archive/restore states and the actions.

## Gotchas

- The action starts invisible until hover; do not force-click it to bypass the behavior under test.
- Seeded thread creation is not part of archive proof. Archiving is not deletion.
