# Extension dock

Extensions can publish status text and widgets beside the composer. Users expand the dock to inspect that output. Reloading extension resources rebuilds the dock and collapses it, even if the new content is identical.

## Entry and proof

The normal-mode `scripts/prove.sh --maintenance` seeds a scratch project extension before launch. It checks `extension-dock-summary`, clicks `extension-dock-toggle`, reads `extension-dock-body`, submits `/reload` through the composer, observes the reload activity, and requires the restored summary with no expanded body.

The runtime UI has an instance identity (`electron/conversation/session-state-map.ts`); `src/app/App.tsx` scopes expansion to that identity. Ordinary status/widget changes keep the same identity, whereas reset/recreation gets a new one. The assertion must not depend on catching an intermediate empty frame.

## Limits

This proves local extension discovery, visible dock output, expansion and reload collapse. Preserving expansion across ordinary status/widget updates is a remaining live coverage gap. It does not cover extension installation, dialogs, arbitrary command compatibility, or third-party extension safety. Existing fixture-backed `extension-dock.spec.ts` and `extension-dock-reload.spec.ts` additionally exercise status updates, disable/enable and rebuild behavior. Their test-mode proof is distinct from the normal-mode maintenance journey.
