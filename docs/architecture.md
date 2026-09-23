# Architecture and ownership

pi-gui keeps the desktop app, portable contracts, catalogs, and Pi adapter separate. Code is grouped by the component that owns behavior and mutable state. Folder placement alone is not an ownership boundary; types and repository guards enforce the important dependency rules.

The review/capture and custom extension-view additions are **implemented and verified within the documented macOS scope** as of September 22, 2026. The [final verification report](workspace-redesign-verification.md) separates baseline checks, Core Electron, real-provider workflows, external local-package loading and local packaged-app proof from the older [workspace foundation evidence](workspace-redesign-plan.md). It does not claim Windows/Linux validation or a notarized/published release.

## Execution path

The renderer calls the browser-safe `window.piApp` API exposed by preload. Electron main validates requests and routes them through [IPC registration](../apps/desktop/electron/ipc/register-desktop-ipc.ts). The [window owner](../apps/desktop/electron/windows/window-owner.ts) supplies the sender window's view and target session. Bounded desktop owners perform the operation, and the Pi SDK driver delegates agent execution to upstream Pi.

Start tracing in [main](../apps/desktop/electron/main.ts), [window owner](../apps/desktop/electron/windows/window-owner.ts), [IPC registration](../apps/desktop/electron/ipc/register-desktop-ipc.ts), [application store](../apps/desktop/electron/application/app-store.ts), and [Pi SDK driver](../packages/pi-sdk-driver/src/pi-sdk-driver.ts). Renderer, preload, and main remain separate bundles configured by [electron-vite](../apps/desktop/electron.vite.config.mjs).

## Owners and boundaries

| Owner                | Responsibility                                                                 | Enforced interface                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer features    | Interaction, presentation, and renderer-local view state                       | Depend on desktop contracts and the preload API; do not import Electron, Node, or host implementation.                                                         |
| Workbench controller | Each window's live per-task tools, selection, visibility and file references   | One reducer; explicit interactions save templates through narrow IPC. Restores and data refreshes do not broadcast or rewrite live layouts.                    |
| Review owner         | Immutable comparisons, pinned file identities, freshness and reviewed marks    | `ReviewOwner` receives only task validation, checkout lookup, userData storage and an optional checkpoint source; Git stays in its platform adapter.           |
| Checkpoint store     | Before/after trees, interval provenance and native transcript-anchor lookup    | `TurnCheckpointStore` receives portable awaited capture boundaries; all snapshot objects/index/refs belong to its separate userData Git repository.            |
| Extension view owner | One backend facet host per registered view/runtime, connections and assets     | Receives declarations from Pi's loaded catalog, validates their sources, and binds each connection to its task/runtime/window; no aggregate application state. |
| Desktop contracts    | Browser-safe requests, snapshots, and shared values                            | Depend on neither React nor host/runtime implementation.                                                                                                       |
| IPC                  | Request validation and routing                                                 | Receives grouped state, workspace, conversation, orchestration, scheduled-task, and settings operations plus narrow platform capabilities.                     |
| Window owner         | Per-window selection, snapshot projection, and serialized actions              | Captures explicit session targets from the sender and never receives writable aggregate store state.                                                           |
| Conversation owner   | Drafts, attachments, queued messages, session commands, and transcript updates | Receives only conversation maps, a runtime lookup, and conversation operations.                                                                                |
| Workspace owner      | Workspace/session lifecycle and Git worktree use cases                         | Receives cloned workspace views, explicit session setup operations, and the catalog/worktree capabilities it needs.                                            |
| Orchestration owner  | Child-thread policy, supervision, transcript evidence, and orchestration tools | Receives cloned orchestration views and bounded transcript, error, conversation, and workspace operations.                                                     |
| Scheduled-task owner | Local on-device schedules, fire, interview session, and agent tools            | Receives a bounded host for the task file, session lookup, selecting create, background create, and background instruction delivery.                           |
| Persistence owners   | UI state, attachments, catalog data, and scheduled tasks                       | Decode their own durable format before use or replacement.                                                                                                     |
| Platform adapters    | Files, worktrees, terminal, dialogs, notifications, theme, and updates         | Stay in Electron main and expose only the required capability to IPC or an owner.                                                                              |

`DesktopAppStore` is the composition point. Its aggregate state, driver, catalogs, session maps, runtime maps, worktree services, and attachment store are private. It constructs conversation, workspace, orchestration, and scheduled-task owners through bounded capability factories. The removed `AppStoreInternals` whole-store interface is prohibited by [the state-owner guard](../scripts/state-owner-boundary.test.mjs), which also rejects direct owner access to `store.state`, `store.sessionState`, and `store.runtimeByWorkspace`, and keeps `reviewed-files.json`, the checkpoint store paths and `writeFileAtomicQueued` inside their owner modules.

The window owner keeps a separate view for every Electron window. Draft, send, attachment, queue-editing, model, thinking, tree-navigation, and Stop requests use a session target captured from the IPC sender. Attachment picking captures the target before opening the native dialog. Opening New thread flushes the outgoing conversation's pending draft before navigation.

Extension host actions have the same scope requirements. The browser supplies an existing-file target or draft content, never a workspace/session/window identity. Main binds it to the live connection, rechecks the selected task after awaited reads and inside the window action queue, and sends navigation only to that window. Before draft creation, the renderer awaits explicit-target persistence of its pending composer draft and checks that the originating mount/task is still current. Navigation, renderer crash and window destruction revoke connections. A late result cannot select the foreground window as a fallback.

Window-scoped state actions remain serialized because the shared application projection is temporarily installed for the sender window while an action runs. Stop bypasses that queue and executes immediately against its captured target; placing cancellation behind the submitted prompt would prevent it from reaching the runtime until the run finished. Removing this serialization requires an equivalent multi-window regression proof, not a folder cleanup.

## Persistent data

Catalog storage owns workspace, session, worktree, and session-file metadata. Desktop persistence owns UI state, composer attachments, and scheduled tasks (`scheduled-tasks.json`). The driver and worktree manager share the same catalog instance so their writes use one coordination boundary.

UI-state and attachment decoders reject malformed fields, unsupported fields, and unsupported versions instead of dropping unknown data. Startup stops with a visible diagnostic when UI-state read, restoration, or legacy attachment migration fails, before workspace sync, pruning, or another persistence write can replace the saved bytes. A corrupt scheduled-tasks file is isolated: the rest of the app still starts, the runner stays off, and the original bytes are not overwritten.

Writes are serialized per path and use a synced temporary file followed by rename. The prior valid file becomes a `.bak`. If the primary JSON is corrupt and the backup is valid, reads recover from the backup and a later valid write retains the damaged primary as a `.corrupt.<id>` sibling. Invalid saved data without a usable backup is not overwritten or pruned.

UI-state v19 stores validated per-task workbench templates and `changes.scope`. v18 layouts without a scope migrate to Uncommitted. Before replacing an older valid state, the atomic writer retains its exact bytes in an exclusive `ui-state.pre-workbench-v<version>.<id>.json` copy, including a v18 source file; the rotating `.bak` does not replace that copy. Templates contain tool/file/scope references and small preferences, never transcripts, file bodies, terminal replay or extension results. They are read through explicit task requests, outside live state broadcasts, so another window cannot rearrange the current window. Main serializes saves and rejects stale renderer sequence numbers; renderer navigation invalidates its old sequence and pending requests.

Review marks use a separate validated `reviewed-files.json`, keyed by task, checkout, comparison scope and file content identity. The old renderer-local path-only marks are not reused or deleted. Captures use `turn-checkpoints/checkpoints.json` plus immutable trees and app-owned refs in `turn-checkpoints/objects.git`. Finalized records reject conflicting replay; restart records unfinished intervals as interrupted. Neither store copies Pi's transcript/history. Retention is bounded: reviewed marks keep the newest 5,000 acknowledgements; checkpoints keep the newest 50 finalized intervals per task and 500 overall; open intervals are never dropped, and records are not deleted when a task leaves the catalog, since removing a workspace is reversible.

Workspace sync, rename, and removal share a per-workspace mutation queue. The queue covers the full scan and catalog replacement. Focus reconciliation rereads the current workspace inside that queue, preserves its name, and skips a removed workspace. Explicit registration can add a workspace again; background metadata touches cannot. Regression tests cover rename preservation and removal during blocked synchronization.

## Pi adapter and contracts

`packages/session-driver` owns portable session contracts, `packages/catalogs` owns catalog contracts and backends, and `packages/pi-sdk-driver` adapts them to upstream Pi. Packages cannot depend on desktop implementation, and catalog code cannot depend back on the Pi adapter. [The host-boundary guard](../scripts/check-host-boundary.mjs) resolves imports, including type-only and dynamic edges, to enforce these directions.

[`turn-capture.ts`](../packages/session-driver/src/turn-capture.ts) is a portable observer contract: task/workspace, runtime/run identity, opening/closing interval IDs, native transcript anchors and outcome. The driver has no Git object-store or renderer types. Hidden ordinary Pi extension factories implement awaited capture and transcript identity; they use released hooks rather than private agent-loop changes. The capture baseline runs at `agent_start`, input transitions use `message_start`, and final capture waits for `agent_settled`; retry/continuation does not prematurely close an interval. A separate [`transcript-identity.ts`](../packages/pi-sdk-driver/src/transcript-identity.ts) hook emits `turn_end.messageEntryId` so live rows receive a stable `sourceMessageId` without replacing their renderer identity or timing.

[`packages/extension-ui`](../packages/extension-ui/README.md) is the local author helper and browser-safe Chord transport package. It owns registration, mount-context and narrow action types. The Pi adapter's [`desktop-extension-bridge.ts`](../packages/pi-sdk-driver/src/desktop-extension-bridge.ts) injects discovery before Pi loads extensions, matches against the final loaded catalog and sends runtime lifecycle notifications. It does not create frontend hosts or await authored desktop activation/cleanup on Pi's lifecycle path. The helper remains private and is not an npm release or an upstream Pi API.

The Pi adapter stays thin over upstream behavior. Required access to private Pi 0.87.1 APIs is isolated in explicit compatibility seams under [`packages/pi-sdk-driver/src/compat`](../packages/pi-sdk-driver/src/compat): one forces the early session-file rewrite while maintaining Pi's flush bookkeeping, and one persists project-scoped settings. An upstream shape change should fail at these small seams instead of spreading private-runtime assumptions through the driver.

Do not redeclare package-owned interfaces in ambient vendor files. Validate external data at the package or persistence boundary, then use the trusted contract internally.

## Review and captured turns

The renderer [`DiffPanel`](../apps/desktop/src/features/workbench/diff-panel.tsx) requests one explicit checkout and [review scope](../apps/desktop/contracts/review.ts). [`ReviewOwner`](../apps/desktop/electron/workbench/review-owner.ts) retains comparison/file identities, [`git-review.ts`](../apps/desktop/electron/platform/files/git-review.ts) owns Git reads and staging, and [`reviewed-store.ts`](../apps/desktop/electron/workbench/reviewed-store.ts) owns durable marks. Available, stale, unavailable and failed results remain distinct. Refresh can replace an immutable comparison but cannot overwrite the user's saved scope or file selection.

Uncommitted exposes HEAD→current, HEAD→index and index→current sections, retaining partially staged and net-zero changes. Stage/Unstage revalidates current content and serializes per checkout. Branch pins merge-base→HEAD and excludes dirty edits; a configured base or remote HEAD/upstream determines its base, without assuming `main`. Last turn resolves before/after trees from the independent checkpoint repository. Latest turn can resolve anew on Refresh; a transcript Review action pins an exact checkpoint via the native `sourceMessageId`. Missing captures never fall back to HEAD or a different turn.

[`TurnCheckpointStore`](../apps/desktop/electron/workbench/checkpoint-store.ts) inventories tracked and nonignored untracked paths through read-only source Git calls and records raw bytes/modes in the app-owned bare repository. It scrubs inherited Git routing variables, does not run clean filters, and does not follow file symlinks. Source index, objects, refs, HEAD and working files remain untouched, including linked worktrees. A transition closes one interval and opens the next with the same snapshot. Concurrent runs carry overlap provenance; an interval comparison cannot attribute edits exclusively to Pi or claim filesystem atomicity.

Capture defaults are 2 seconds, 10,000 files, 64 MiB total and 16 MiB per file. Unsupported sparse/conflict/submodule states and exceeded limits are unavailable. Review lists cap at 2,000 files, content at 8 MiB and patches at 1 MiB, with 32 MiB/10-second working-byte preparation and explicit partial coverage. Live review/capture requires the checkout root; stored turns can outlive that checkout. The review owner retains 16 in-memory comparisons; stale/evicted handles require Refresh. Uncommitted and Branch reviews list index and tree entries only for the changed paths, so repository size alone does not exhaust Git output limits.

Boundaries serialize per checkout, and each capture's 2-second budget starts when that capture starts; the driver's longer deadline (10 seconds in the desktop app) only stops a stuck boundary. Capture stays awaited at every boundary so the before tree precedes any tool and Last turn is final when a run reports finished. After a checkout's first capture, the store keeps its inventory in memory and rereads only files whose inode, mode, size or timestamps changed; files touched within 2 seconds are always reread. A checkout too slow for its first in-budget capture builds that inventory in the background (60-second budget, retried at most every 15 minutes after a failure), so its later turns become available. Each boundary writes `checkpoints.json` once. Background maintenance (after dropped records or 200 boundaries, at most hourly) forgets the in-memory inventories, deletes refs no retained interval needs, and runs `git gc --prune` in `objects.git`; refs and objects younger than one hour survive, which protects in-flight captures.

## Custom extension frontend boundary

The [view host](../apps/desktop/electron/extensions/extension-view-owner.ts) validates each declaration against Pi's loaded extension sources and creates one backend Chord facet host per view/task/runtime generation. Each renderer mount receives its own connection; closing the view disposes subscriptions, not accepted backend work or saved extension results. Pi custom entries remain the durable domain owner. Chord handles services/state through the local transport adapter, with separate state codecs and validated JSON at the wire boundary.

[`extension-view-panel.tsx`](../apps/desktop/src/features/extensions/extension-view-panel.tsx) mounts an opaque-origin `allow-scripts` iframe and transfers one scoped message port. The app-owned bootstrap imports the author's prebuilt module and supplies only services, theme, abort signal and file/draft actions. The `pi-extension://<connection>/` protocol serves contained assets from below the matched entry's canonical directory, with a per-connection CSP denying network fetches, workers and nested frames. Review, extension-view, workbench-template and draft-persistence IPC registers through [`mainFrameHandler`](../apps/desktop/electron/ipc/main-frame-ipc.ts), which rejects any sender other than the owned window's main frame; [the IPC guard](../scripts/ipc-main-frame-boundary.test.mjs) rejects hand-copied frame checks and raw `ipcMain` use outside the allowlisted registration module. The renderer boundary rejects runtime imports of the extension-ui `transport` and `browser` entry points. With frame-navigation restrictions these protect the parent API; no Node or broad preload surface reaches the frame.

Runtime invalidation revokes capabilities before asynchronous cleanup. Backend activation defaults to a 10-second timeout; late activation is disposed. The frame has a 10-second ready deadline and 128-message pre-mount buffers. The transport bounds messages at 2,000,000 encoded characters and pending calls/subscriptions/updates at 256; host actions have a separate 32-pending limit. Disconnect rejects browser waits, while explicit cancellation and backend lifetime remain separate. No unknown-outcome operation is automatically replayed.

The [local author workflow](../examples/desktop-extensions/README.md) covers the file-based [PR Review](../examples/desktop-extensions/pr-review/README.md) and [Test Runs](../examples/desktop-extensions/test-runs/README.md) examples. Browser edits use a checked-in build and Reload view; backend edits use an idle Pi reload. These use Pi's ordinary discovery/trust path without a second installer or marketplace; independently installed local tarballs also passed actual Pi loading. npm publication and a dedicated extension-authoring task button are not implemented. See the [extension design](chord-desktop-extension-design.md) for example limits and the [verification report](workspace-redesign-verification.md) for completed proof.

## Current placement

```text
apps/desktop/
  contracts/             browser-safe desktop API and values
  electron/
    main.ts              process composition and platform wiring
    preload.ts           narrow renderer transport
    application/         private aggregate store and projection helpers
    windows/             per-window views and action serialization
    ipc/                 validation and request routing
    conversation/        session commands, drafts, transcript, visibility
    workspace/           workspace, session, and worktree use cases
    orchestration/       child-thread policy and supervision
    scheduled-tasks/     local schedules, fire, and agent tools
    workbench/           immutable reviews, reviewed marks, turn checkpoint store
    extensions/          registered view hosts, contained assets, narrow host actions
    persistence/         validated UI-state, attachment, and scheduled-task storage
    platform/            main-only platform adapters
  src/
    app/                 screen composition
    features/            conversation, threads, scheduled-tasks, workbench, settings, extensions
    ui/                  shared visual primitives
    lib/                 general renderer helpers
    styles/              global tokens and base styles

packages/
  session-driver/        portable session contracts
  catalogs/              catalog contracts and storage
  pi-sdk-driver/         upstream Pi adapter and compatibility seams
  extension-ui/          local desktop-view author helper and Chord wire adapter
```

A workspace command starts in renderer `features/threads`, crosses preload and validated IPC, and runs through the workspace owner. The window owner then resolves a valid view for that window. Conversation and orchestration code cannot mutate workspace state through a shared store escape hatch.

## Product and support tooling

Desktop packaging and its test fixtures stay under `apps/desktop`; the marketing site stays under `apps/website`; repository policy and guard scripts stay at the root. Product captures are produced by desktop-owned scripts, while Remotion source and video rendering stay under `video`.

The root commands make that ownership explicit: `marketing:demo` updates the README demo, `marketing:capture` produces showcase captures through the desktop app, and `marketing:render` renders the Remotion showcase. Generated historical media and user artifacts must not be removed as dependency cleanup. Packaging dependencies also require packaged-runtime verification before removal because bundling and pnpm staging can need packages that have no direct source import.

## Proof

Use [baseline checks](ci-baseline.md), [desktop lane commands](../apps/desktop/README.md), and the [verification skill](../.agents/skills/verify-pi-gui/SKILL.md). `check:architecture` enforces renderer, contract-authority, and host dependency rules. `test:guards` includes rejected fixtures for those boundaries and state-owner access.

Report evidence at its actual level: static/type checks, unit tests, fixture-backed Electron, deterministic runtime integration, real-provider conversation, native OS behavior, or packaged artifact. Desktop user flows are complete only after the affected surface runs in Electron. A settings smoke, skipped provider test, or passing package build does not prove conversation behavior.

## Timeline viewport

`use-timeline-viewport.ts` owns the conversation's scroll intent, active-session measurements,
visible range, saved reading anchors, and programmatic scroll writes. `timeline-layout.ts`
contains pure offset/anchor calculations. The timeline renders that range and reports sizes;
search requests navigation through the owner. The timeline-owner guard
rejects direct scroll writes in these consumers.

Streaming publication is batched at 50 ms per session while the store applies every event
immediately. Discrete events publish immediately. Row estimates are cached separately from
measurements; scrolling does not rebuild text estimates. A growing measured row keeps its
last size provisionally until measured again, avoiding a one-frame jump to an estimate.
Long messages and attachments do not disable virtualization. Search explicitly mounts the
same row renderer's full range; its bar sits outside the scroll pane.

Use the Core `timeline-pinning` and `timeline-viewport` specs for position
contracts. `context-rail` covers turn timing markers. The viewport spec records frame intervals during a 700-line growing response;
timing is diagnostic, not a shared-runner CI threshold. The real-provider verification recipe
also checks reading during active streaming and retains `scroll-frames.json`. Row anchors
preserve offsets; they do not preserve the exact word after reflow within a large message.
