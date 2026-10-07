# Review panel

Users review what changed in a thread's checkout, by turn, by working-tree state, or against a branch, and stage or mark files from the same panel.

## Sub-features

- `review-open`: open Review beside the conversation.
- `review-scopes`: switch between Last Turn, Uncommitted, Unstaged, Staged and Branch, and see the matching files and diff.
- `review-files`: filter the changed-file tree, stage or unstage a file, and mark a file reviewed.
- `review-refresh`: pick up outside edits when the window regains focus, without blanking the panel.

## How to get to it (user POV)

- Press Cmd+R (Ctrl+R elsewhere), or open the side panel's Review tab ("Review uncommitted, branch or turn changes"). Settings > Keyboard shortcuts lists it as Toggle review.
- The toolbar has a `Review scope` menu (Last Turn, Uncommitted, Unstaged, Staged, Branch; Selected Turn appears only while that scope is active), added/removed line totals, a `Refresh` button (tooltip "Refresh comparison"; an outdated comparison also shows a banner with its own `Refresh comparison` button), a `Review options` menu that names the comparison and can switch to another checkout (the thread's own reads `Current task · <branch>`), and `Show file tree` / `Hide file tree`. Branch adds a `Base branch` box (placeholder `Repository default`) and Compare.
- The file tree has `Filter changed files`, per-file Stage / Unstage buttons on Uncommitted, Staged and Unstaged (none on turn or Branch scopes), and a `Mark <path> reviewed` checkbox. The diff header has `Open in Files`. An empty comparison reads "No changes" (or "No changes in the captured files." for a turn).
- Working scopes and Branch reload quietly when the window regains focus; Last Turn does not.
- A write tool row in the transcript has a `View <path> in changes` button that opens its change in Review.

## Driving it with Playwright

Preconditions: isolated profile and a disposable Git repository. No provider is needed; `review-turns.spec.ts` uses a local deterministic provider while pi still runs its real write tool.

- **Core regression:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/review-layout.spec.ts apps/desktop/tests/core/review-scopes.spec.ts apps/desktop/tests/core/review-auto-refresh.spec.ts apps/desktop/tests/core/review-turns.spec.ts apps/desktop/tests/core/review-ux.spec.ts`. Layout covers the tree beside the diff, filtering and Staged/Unstaged; scopes covers Uncommitted, Branch with a missing base, stale comparisons, incomplete coverage and another checkout; auto-refresh covers focus refresh without blanking; turns covers Last Turn capturing real tool edits; ux covers reviewed marks across relaunch and the write-row button.
- **Related:** `changed-files.spec.ts`, `turn-changes-card.spec.ts` and `workbench-tabs.spec.ts` cover the changes card and side panel tabs that lead into Review.
- No `prove.sh` lane opens Review. A conversation or maintenance pass says nothing about it.

## Gotchas

- Reviewed marks belong to a file revision; editing the file clears the mark.
- An outdated comparison refuses to mark or stage newer content until it is refreshed.
