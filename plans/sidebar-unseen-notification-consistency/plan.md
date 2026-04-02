# Plan: desktop notification + unseen-dot consistency

## Goal
Use one shared "actively viewed session" rule for both desktop notification suppression and sidebar unseen-dot clearing so the two surfaces cannot drift.

## Confirmed Product Semantics
- A session counts as actively viewed only when all of these are true:
- `activeView === "threads"`
- the selected workspace/session matches the event session
- the desktop window exists, is visible, is not minimized, and is focused
- If a selected session completes while the window is hidden or unfocused, that session is not actively viewed and should behave like any other unseen completion: notification plus blue dot.

## Root Cause
1. Notification suppression and viewed-marking had drifted onto different predicates, so desktop notifications and the sidebar blue dot could disagree about whether a session was actively being viewed.
2. `hasUnseenUpdate` was also derived in two different places:
- `app-store-session-state.ts`
- `app-store-utils.ts`
3. The real runtime bug was deeper than the store mismatch: `packages/pi-sdk-driver/src/session-supervisor.ts` did not advance `record.updatedAt` on `agent_end`.
4. That meant a run could start while the session was actively viewed, set `lastViewedAt` during the running state, and then finish later with a stale completion snapshot timestamp. Notification suppression still evaluated the completion as not actively viewed, but unseen derivation saw no newer update and left the blue dot cleared.
5. The old live lane also overstated confidence because most notification assertions were synthetic and `test:live:*` launches hidden windows by default, which is semantically incompatible with focus-aware "actively viewed" checks unless a foreground or deterministic seam is used intentionally.

## Success Criteria
1. Focused selected session completes in Threads view: no desktop notification, no unseen blue dot.
2. Different session completes while another session is selected: desktop notification appears and the completed session shows the unseen blue dot.
3. Selected session completion while not actively viewed follows the same predicate: desktop notification appears and the selected session shows the unseen blue dot.
4. Notification suppression and viewed-marking both depend on the same shared active-view predicate.
5. `hasUnseenUpdate` derivation is centralized so event updates and full refreshes cannot disagree.

## Implemented Fix
1. Kept `session-visibility.ts` as the shared source of truth for "actively viewed session", with a narrow test-only override for deterministic live assertions.
2. Centralized unseen derivation in `hasSessionUnseenUpdate()` and used it from both:
- `buildSessionRecord()` in `app-store-utils.ts`
- `updateSessionRecord()` in `app-store-session-state.ts`
3. Simplified notification suppression so it keys directly off the shared active-view predicate instead of a second-order `hasUnseenUpdate` gate.
4. Fixed the real runtime path by advancing `record.updatedAt` on `agent_end` before emitting `runCompleted`/`runFailed` and the follow-up `sessionUpdated` snapshot.
5. Kept the deterministic notification matrix for focus-aware coverage, and added one real existing-session regression that starts while the session is actively viewed and completes after switching away.

## Verification
Real surface: the running Electron desktop app in Playwright, with both deterministic session-event coverage and a real provider-backed existing-session completion regression.

Commands run:
- `pnpm --filter @pi-gui/desktop typecheck`
- `pnpm --filter @pi-gui/desktop run test:live:notifications`
- `pnpm --filter @pi-gui/desktop run test:live:parallel`
- `pnpm --filter @pi-gui/desktop run test:e2e:live`

## Risks
- Focus-sensitive assertions still require either a foreground window or the deterministic visibility override; hidden background windows alone are not a valid stand-in for "previously viewed but now inactive."
- `apps/desktop/electron/app-store.ts` already contains unrelated transcript-persistence changes, so notification/unseen edits should stay scoped and avoid churn there unless the product logic changes again.
