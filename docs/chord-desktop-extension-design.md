# Custom desktop extension views with Chord

Status: **implemented and verified within the documented macOS scope**, September 22, 2026. The host, private local helper, PR Review and Test Runs examples use installed Pi Coding Agent and Chord 0.87.0. Baseline, Core security/lifecycle, real-provider execution, external local-package loading and local packaged-app gates passed; see the [verification report](workspace-redesign-verification.md) for their distinct evidence and limits. The helper is not published, and the packaged app was not notarized or released. See the [author workflow](../examples/desktop-extensions/README.md) for local use.

## Decision

An existing Pi extension can register an optional desktop frontend, with Chord connecting its backend services and state to that frontend. Pi-gui owns tab placement, browser loading and the permitted desktop actions. The author owns the workflow and interface.

For example, PR Review remains a Pi extension. Its backend performs the review and saves findings; its desktop frontend draws the findings and review controls. Clicking Review calls the backend. Updated findings flow through Chord. Closing the tab disposes its frontend subscription, not the findings or backend work.

An extension without a desktop frontend keeps its existing commands, tools, dialogs and widgets. A terminal component is not converted into a web component. The optional GUI helper must gracefully report that no desktop host is present when the extension runs in terminal Pi.

## Historical feasibility proof

The installed public packages were used, rather than the cached Pico branch:

| Capability                          | Observed result                                                                                                                         | Design consequence                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Chord services and replicated state | Method calls, hydrate/update subscriptions, immutable snapshots and transaction rollback passed in Node and headless Chrome             | Reuse Chord instead of writing another service/state system                                  |
| Provider replacement                | Existing consumer handle survived replacement; retired provider cleanup and subscriber disposal passed                                  | Use Chord lifecycle inside a live backend host                                               |
| Browser core                        | Bundled and executed without Node globals                                                                                               | Chord can run in a browser frontend                                                          |
| Supplied facet artifact             | Browser-target build still produced CommonJS; direct browser execution failed with `module is not defined`                              | Supply a browser entry/build convention; do not use the Node artifact loader in the renderer |
| Stable Pi extension bootstrap       | An injected Pi EventBus registered a facet from the same extension closure; the extension loaded once; a service call changed its state | A small discovery adapter can connect existing Pi extensions to Chord                        |
| Experimental Pi exports             | Installed `./experimental/plugin` and `./client` imports failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`                                    | Do not build production against those source-only entry points                               |

These pre-implementation probes used a JSON-copying loopback adapter within the browser and an inline Pi extension. They establish Chord feasibility, not proof of the subsequently implemented Electron transport, asset containment or frontend isolation. Keep their evidence separate from the final product gates below.

Evidence scripts and result JSON are retained in `/private/tmp/pi-gui-chord-087-probe-4r9zmy/`: `run-node.mjs`, `run-browser.mjs`, `run-bootstrap.mjs`, `browser-result.json` and `bootstrap-result.json`. Public source: [Chord 0.87.0](https://github.com/earendil-works/pi/tree/v0.87.0/packages/chord), [Coding Agent package exports](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/package.json).

## Author contract

The implemented contract has two entries in the existing extension package:

1. The normal Pi extension entry registers its commands/tools and optionally calls a Pi-gui helper with a view ID, title, browser asset location and a backend facet factory. The factory closes over that same extension instance. Do not load a second backend from a parallel plugin scanner.
2. A prebuilt browser ES module mounts the custom interface into a supplied root and returns a disposer. It can use a frontend Chord facet to consume the backend's typed services and state. Its framework dependencies are bundled; it cannot assume access to the app's React instance or Node modules.

This is Pi-gui's local helper API, not an upstream Pi API or published npm package:

```ts
export default function extension(pi: ExtensionAPI) {
  // Existing Pi commands and tools remain here.
  registerDesktopView(pi, {
    id: "pr-review",
    title: "PR Review",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () => createReviewFacet(pi),
  });
}

// dist/desktop.js exports this browser entry:
export function mount(root: HTMLElement, host: DesktopViewContext): () => void {
  // Connect Chord services, render the author's UI, return cleanup.
}
```

[`@pi-gui/extension-ui`](../packages/extension-ui/README.md) is a private workspace package. `registerDesktopView` reports availability and returns a disposer; terminal Pi can report no desktop host while the extension's commands/tools continue to work. Availability acknowledges discovery, not successful source validation or backend activation. `DesktopViewContext` supplies a scoped Chord service source, theme values, an abort signal and `openFile` / `prepareTaskDraft` actions. Service tokens and domain schemas live with the extension and are shared by its entries. Backend state uses `env.replicatedState` so it belongs to the host's Chord instance. Browser dependencies are bundled separately; the author cannot assume the app's React or Node modules are available.

## Owners and flow

| Owner                  | Responsibility and interface                                                                             | Implemented location                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Author helper          | Register/replay desktop declarations through the Pi extension API; no package scanning                   | `packages/extension-ui/src/index.ts`, `browser.ts`                                          |
| Pi adapter             | Inject the per-session discovery bus before Pi loads extensions; forward registrations/lifecycle changes | `packages/pi-sdk-driver/src/desktop-extension-bridge.ts`                                    |
| Desktop extension host | Own per-session Chord backend host, registration catalog, frontend capabilities and cleanup              | `apps/desktop/electron/extensions/extension-view-owner.ts`                                  |
| Asset handler          | Validate loaded extension identity and contain browser asset reads                                       | `electron/extensions/extension-view-source.ts`, `extension-view-owner.ts`                   |
| IPC and host actions   | Validate main-frame sender/connection, scope file navigation and draft creation                          | `electron/ipc/extension-view-requests.ts`, `electron/extensions/extension-view-actions.ts`  |
| Frame controller       | Mount/unmount a view, exchange a dedicated message port, show unavailable/error states                   | `src/features/extensions/extension-view-panel.tsx`, `use-extension-views.ts`                |
| Browser bootstrap      | Supply the host-owned bridge and mount the author's ES module                                            | `electron/extensions/extension-frame-document.ts`, `packages/extension-ui/src/transport.ts` |
| Workbench              | Add/focus/close tool tabs; persist extension/view references                                             | `src/features/workbench`, `contracts/workbench.ts`                                          |

Desktop paths in the table are relative to `apps/desktop`. Dependency direction remains renderer → narrow preload → desktop host → Pi adapter. Browser-safe desktop requests live in `contracts/extension-views.ts`; the local helper owns registration/action/wire types, and the Pi adapter owns its observer interface. Portable packages never import desktop implementation. The host does not export a general Pi object to the browser.

The small EventBus adapter is **discovery only**. It transports a declaration inside the trusted Node process because released Pi does not expose a desktop registration hook. It does not recreate Chord calls, subscriptions or replicated state. Host listeners exist before extension loading, and discovery can replay the same declaration without running the extension factory again. Registration failure appears in extension diagnostics. Backend declarations carry code and remain entirely outside renderer IPC.

After Pi finishes loading, the host matches the declaration's source real path against the final loaded extension catalog, rejecting missing/ambiguous origins and duplicate IDs. It assigns task, extension, view and runtime-generation identity. Each validated view has one backend facet host per task runtime generation; multiple windows receive separate connections to that host. Replaying discovery does not reactivate the same declaration. Because existing Pi extensions are trusted Node code, source matching prevents accidental misrouting; it is not authentication against a hostile installed backend.

Opening a tab requests a connection bound by main to that task/view and initiating window. The frame sends validated JSON messages over its dedicated port; preload and main route only that connection. The adapter constructs a Chord endpoint and per-subscription state codecs rather than implementing another replication system. Main validates the registered main-frame sender and live connection, and exposes only the view's advertised services. File navigation and draft preparation are separate narrow host actions.

## Custom frontend boundary

The renderer mounts an iframe with `sandbox="allow-scripts"`, an opaque origin and no same-origin, popup or top-navigation grants. It receives neither Node nor the parent preload API. The initial port handshake targets that exact frame and checks the parent source plus connection ID; later messages use only its dedicated port. Main rejects frame navigation outside the live connection's document route. The frame controller detects frame reload and offers a fresh connection instead of reusing old capabilities.

Authors ship prebuilt browser ES modules and local assets beneath the canonical directory of the matched Pi entrypoint. Main resolves each asset's real path, rejects traversal/symlink escapes, and serves it through `pi-extension://<connection>/assets/…`. The route checks a live connection and rechecks it after file reads. The app supplies its own bundled frame bridge from `/_host/frame-bridge.js`; there is no general filesystem endpoint. Per-connection CSP allows only those scripts/assets and local styling, denies network fetches, workers and nested frames, and repeats the sandbox policy. Network/file/tool work runs in the extension backend. Mounting never installs packages, runs builds or supplies Node-style `require`.

The helper can be consumed through local workspace resolution or locally packed packages and Pi's normal extension configuration. The [author README](../examples/desktop-extensions/README.md) explains dependency placement and project trust; the host does not install or discover packages independently. The actual Electron containment checks passed; they do not sandbox the already-trusted Pi backend.

## State and lifecycle

Pi session entries remain the durable owner of extension results. Chord state is the live projection. Desktop UI storage saves tab references and small presentation preferences only. Closing a view releases its port/subscriptions and mount resources; closing it does not cancel an ongoing review.

Each open window/view gets its own connection to the task/view's backend host. Main captures the task and sender rather than trusting identities in an action payload. It validates the current task after filesystem checks and at execution in the window action queue. Draft creation first awaits explicit-target persistence of the outgoing renderer draft and abandons forwarding if its task/mount changed. Closed, navigated or crashed renderers invalidate connections. A late presentation action is rejected/unavailable; the extension retains its results. There is no automatic foreground-window fallback or new late-result inbox.

Pi extension reload invalidates old view connections before asynchronous cleanup, then rebuilds registrations against the next runtime generation. The hidden discovery extension invokes desktop notifications without awaiting authored view activation/disposal on Pi's lifecycle path. Activation has a 10-second default timeout; a host that finishes after timeout or invalidation is disposed. Backend code remains trusted and cooperative. A broken asynchronous view must not hold an ordinary Pi session start/shutdown open.

**Reload view** reconnects the browser against the existing backend; backend edits use idle `/reload`. Closing a connection releases its Chord subscriptions and rejects waiting browser requests but does not cancel already accepted backend work. Explicit cancellation propagates the request's abort signal. Runtime/backend disposal owns broader teardown. Chord replacement within a live host does not preserve an obsolete Pi extension closure, and unknown-outcome mutations are never replayed automatically.

## Practical limits and examples

The transport limits an encoded message to 2,000,000 characters, pending service requests/subscriptions to 256, and buffered subscription updates to 256. The frame controller buffers at most 128 messages before opening/mounting and allows 10 seconds to become ready. Narrow host actions have a separate 32-pending limit per connection. Overflow and activation/mount failure produce explicit errors; these limits are not a promise that arbitrary authored code will finish promptly.

[PR Review](../examples/desktop-extensions/pr-review/README.md) uses authenticated `gh`, existing local Git objects and the configured Pi model. It records versioned local findings in Pi session entries, checks revision/location identity, and prepares an unsent fix draft. Requested, Running, Incomplete and interrupted states are distinct because Pi's public submission API does not acknowledge provider admission. It neither posts a GitHub review nor fetches/merges a branch. Its current bounds include 20-second commands, 1 MiB output, 200 changed files and 20 findings.

[Test Runs](../examples/desktop-extensions/test-runs/README.md) executes fixed demonstration `node:test` suites through Pi's bash operations. It retains the last 32 KiB of output with a truncation notice, supports Stop/timeout, and restores the current Pi branch's 20 most recent run records. These are real child processes, not the repository's full checks. The browser sends suite IDs rather than shell commands. Both examples share the same author contract and support terminal commands without a desktop host.

The implemented author workflow is local edit, checks, browser rebuild and explicit reload. The helper remains private; npm publication and a dedicated **Ask Pi to improve this extension** action are not part of this implementation.

## Verification scope

The [final report](workspace-redesign-verification.md) records the passed gates and retained artifacts:

1. Actual example files and bundles ran in Electron. PR Review used a real configured provider, Pi tools and Git with fixture GitHub metadata; findings, an existing file and an unsent fix draft were inspected. Draft preservation and Stop during preparation passed separately.
2. Core and focused owner/transport tests covered task/window isolation, stale connections, malformed inputs, reload/close, failure recovery and contained browser capabilities. The packaged app loaded the frame bridge from ASAR and exchanged/reloaded Chord state.
3. Test Runs exercised real fixed test processes, streamed output, Stop/timeout and retained state through the same host contract. Offline example checks remain distinct from the desktop evidence.
4. The helper and both examples were packed and installed outside the repository, then loaded through actual Pi with no loader errors. This establishes local package loading/registration and asset presence, not npm publication.

Windows/Linux desktop behavior, notarization, publication and installation into `/Applications` were not part of this proof. Historical Chord feasibility probes remain separately labeled above.
