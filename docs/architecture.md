# Architecture and ownership

pi-gui keeps the desktop app, portable contracts, catalogs, and Pi adapter separate. Code is grouped by the component that owns behavior and mutable state. Folder placement alone is not an ownership boundary; types and repository guards enforce the important dependency rules.

## Execution path

The renderer calls the browser-safe `window.piApp` API exposed by preload. Electron main validates requests and routes them through [IPC registration](../apps/desktop/electron/ipc/register-desktop-ipc.ts). The [window owner](../apps/desktop/electron/windows/window-owner.ts) supplies the sender window's view and target session. Bounded desktop owners perform the operation, and the Pi SDK driver delegates agent execution to upstream Pi.

Start tracing in [main](../apps/desktop/electron/main.ts), [window owner](../apps/desktop/electron/windows/window-owner.ts), [IPC registration](../apps/desktop/electron/ipc/register-desktop-ipc.ts), [application store](../apps/desktop/electron/application/app-store.ts), and [Pi SDK driver](../packages/pi-sdk-driver/src/pi-sdk-driver.ts). Renderer, preload, and main remain separate bundles configured by [electron-vite](../apps/desktop/electron.vite.config.mjs).

## Owners and boundaries

| Owner                | Responsibility                                                                 | Enforced interface                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Renderer features    | Interaction, presentation, and renderer-local view state                       | Depend on desktop contracts and the preload API; do not import Electron, Node, or host implementation.                                     |
| Desktop contracts    | Browser-safe requests, snapshots, and shared values                            | Depend on neither React nor host/runtime implementation.                                                                                   |
| IPC                  | Request validation and routing                                                 | Receives grouped state, workspace, conversation, orchestration, scheduled-task, and settings operations plus narrow platform capabilities. |
| Window owner         | Per-window selection, snapshot projection, and serialized actions              | Captures explicit session targets from the sender and never receives writable aggregate store state.                                       |
| Conversation owner   | Drafts, attachments, queued messages, session commands, and transcript updates | Receives only conversation maps, a runtime lookup, and conversation operations.                                                            |
| Workspace owner      | Workspace/session lifecycle and Git worktree use cases                         | Receives cloned workspace views, explicit session setup operations, and the catalog/worktree capabilities it needs.                        |
| Orchestration owner  | Child-thread policy, supervision, transcript evidence, and orchestration tools | Receives cloned orchestration views and bounded transcript, error, conversation, and workspace operations.                                 |
| Scheduled-task owner | Local on-device schedules, fire, interview session, and agent tools            | Receives a bounded host for the task file, session lookup, selecting create, background create, and background instruction delivery.       |
| Persistence owners   | UI state, attachments, catalog data, and scheduled tasks                       | Decode their own durable format before use or replacement.                                                                                 |
| Platform adapters    | Files, worktrees, terminal, dialogs, notifications, theme, and updates         | Stay in Electron main and expose only the required capability to IPC or an owner.                                                          |

`DesktopAppStore` is the composition point. Its aggregate state, driver, catalogs, session maps, runtime maps, worktree services, and attachment store are private. It constructs conversation, workspace, orchestration, and scheduled-task owners through bounded capability factories. The removed `AppStoreInternals` whole-store interface is prohibited by [the state-owner guard](../scripts/state-owner-boundary.test.mjs), which also rejects direct owner access to `store.state`, `store.sessionState`, and `store.runtimeByWorkspace`.

The window owner keeps a separate view for every Electron window. Draft, send, attachment, queue-editing, model, thinking, tree-navigation, and Stop requests use a session target captured from the IPC sender. Attachment picking captures the target before opening the native dialog. Opening New thread flushes the outgoing conversation's pending draft before navigation.

Window-scoped state actions remain serialized because the shared application projection is temporarily installed for the sender window while an action runs. Stop bypasses that queue and executes immediately against its captured target; placing cancellation behind the submitted prompt would prevent it from reaching the runtime until the run finished. Removing this serialization requires an equivalent multi-window regression proof, not a folder cleanup.

## Persistent data

Catalog storage owns workspace, session, worktree, and session-file metadata. Desktop persistence owns UI state, composer attachments, and scheduled tasks (`scheduled-tasks.json`). The driver and worktree manager share the same catalog instance so their writes use one coordination boundary.

UI-state and attachment decoders reject malformed fields, unsupported fields, and unsupported versions instead of dropping unknown data. Startup stops with a visible diagnostic when UI-state read, restoration, or legacy attachment migration fails, before workspace sync, pruning, or another persistence write can replace the saved bytes. A corrupt scheduled-tasks file is isolated: the rest of the app still starts, the runner stays off, and the original bytes are not overwritten.

Writes are serialized per path and use a synced temporary file followed by rename. The prior valid file becomes a `.bak`. If the primary JSON is corrupt and the backup is valid, reads recover from the backup and a later valid write retains the damaged primary as a `.corrupt.<id>` sibling. Invalid saved data without a usable backup is not overwritten or pruned.

Workspace sync, rename, and removal share a per-workspace mutation queue. The queue covers the full scan and catalog replacement. Focus reconciliation rereads the current workspace inside that queue, preserves its name, and skips a removed workspace. Explicit registration can add a workspace again; background metadata touches cannot. Regression tests cover rename preservation and removal during blocked synchronization.

## Pi adapter and contracts

`packages/session-driver` owns portable session contracts, `packages/catalogs` owns catalog contracts and backends, and `packages/pi-sdk-driver` adapts them to upstream Pi. Packages cannot depend on desktop implementation, and catalog code cannot depend back on the Pi adapter. [The host-boundary guard](../scripts/check-host-boundary.mjs) resolves imports, including type-only and dynamic edges, to enforce these directions.

The Pi adapter stays thin over upstream behavior. Required access to private Pi 0.85.1 APIs is isolated in explicit compatibility seams under [`packages/pi-sdk-driver/src/compat`](../packages/pi-sdk-driver/src/compat): one forces the early session-file rewrite while maintaining Pi's flush bookkeeping, and one persists project-scoped settings. An upstream shape change should fail at these small seams instead of spreading private-runtime assumptions through the driver.

Do not redeclare package-owned interfaces in ambient vendor files. Validate external data at the package or persistence boundary, then use the trusted contract internally.

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
