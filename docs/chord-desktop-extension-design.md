# Custom desktop extension views with Chord

Status: proposed design, grounded in installed Pi Coding Agent and Chord 0.87.0 on September 22, 2026. The dependency upgrade is implementation work; this view host is not implemented. See the [workspace plan](workspace-redesign-plan.md) for product priorities.

## Decision

Keep the released Pi Coding Agent and its existing extensions. Add an optional desktop frontend to an extension, with Chord connecting its backend services and state to that frontend. Pi-gui owns tab placement, browser loading and the permitted desktop actions. The author owns the workflow and interface.

For example, PR Review remains a Pi extension. Its backend performs the review and saves findings; its desktop frontend draws the findings and review controls. Clicking Review calls the backend. Updated findings flow through Chord. Closing the tab disposes its frontend subscription, not the findings or backend work.

An extension without a desktop frontend keeps its existing commands, tools, dialogs and widgets. A terminal component is not converted into a web component. The optional GUI helper must gracefully report that no desktop host is present when the extension runs in terminal Pi.

## What was actually proved

The installed public packages were used, rather than the cached Pico branch:

| Capability                          | Observed result                                                                                                                         | Design consequence                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Chord services and replicated state | Method calls, hydrate/update subscriptions, immutable snapshots and transaction rollback passed in Node and headless Chrome             | Reuse Chord instead of writing another service/state system                                  |
| Provider replacement                | Existing consumer handle survived replacement; retired provider cleanup and subscriber disposal passed                                  | Use Chord lifecycle inside a live backend host                                               |
| Browser core                        | Bundled and executed without Node globals                                                                                               | Chord can run in a browser frontend                                                          |
| Supplied facet artifact             | Browser-target build still produced CommonJS; direct browser execution failed with `module is not defined`                              | Supply a browser entry/build convention; do not use the Node artifact loader in the renderer |
| Stable Pi extension bootstrap       | An injected Pi EventBus registered a facet from the same extension closure; the extension loaded once; a service call changed its state | A small discovery adapter can connect existing Pi extensions to Chord                        |
| Experimental Pi exports             | Installed `./experimental/plugin` and `./client` imports failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`                                    | Do not build production against those source-only entry points                               |

The browser test used a JSON-copying loopback adapter within the browser. It proves Chord's browser behavior, not Electron transport, filesystem asset containment or frontend isolation. The bootstrap used an inline extension. These remaining boundaries have explicit implementation gates below.

Evidence scripts and result JSON are retained in `/private/tmp/pi-gui-chord-087-probe-4r9zmy/`: `run-node.mjs`, `run-browser.mjs`, `run-bootstrap.mjs`, `browser-result.json` and `bootstrap-result.json`. Public source: [Chord 0.87.0](https://github.com/earendil-works/pi/tree/v0.87.0/packages/chord), [Coding Agent package exports](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/package.json).

## Author contract

Provide two entries in the existing extension package:

1. The normal Pi extension entry registers its commands/tools and optionally calls a Pi-gui helper with a view ID, title, browser asset location and a backend facet factory. The factory closes over that same extension instance. Do not load a second backend from a parallel plugin scanner.
2. A prebuilt browser ES module mounts the custom interface into a supplied root and returns a disposer. It can use a frontend Chord facet to consume the backend's typed services and state. Its framework dependencies are bundled; it cannot assume access to the app's React instance or Node modules.

Illustrative proposed API, not an upstream Pi API:

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

The helper and `DesktopViewContext` are new Pi-gui contracts. The latter supplies a scoped connection, theme values and only the supported host actions. Service tokens and domain schemas live with the extension and are shared by its entries. Optional Pi-gui controls help authors match spacing, colors and keyboard behavior; there is no fixed list of allowed UI blocks.

## Owners and flow

| Owner                  | Responsibility and interface                                                                                   | Proposed location                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Author helper          | Register/replay desktop declarations through the Pi extension API; no package scanning                         | A small public `packages/extension-ui` package after the second extension validates the contract |
| Pi adapter             | Inject the per-session discovery bus before Pi loads extensions; forward typed registrations/lifecycle changes | `packages/pi-sdk-driver`, extending its existing resource-loader options narrowly                |
| Desktop extension host | Own per-session Chord backend host, registration catalog, frontend capabilities and cleanup                    | `apps/desktop/electron/extensions/extension-view-owner.ts`                                       |
| Asset handler          | Serve only registered, validated browser assets                                                                | Desktop host platform adapter; no general file-read endpoint                                     |
| Frame controller       | Mount/unmount a view, exchange a dedicated message port, show unavailable/error states                         | `apps/desktop/src/features/extensions/extension-view.tsx`                                        |
| Workbench              | Add/focus/close tool tabs; persist extension/view references                                                   | Existing proposed workbench owner                                                                |

Dependency direction remains renderer → narrow preload → desktop host → Pi adapter. Portable registration/lifecycle contracts belong in `packages/session-driver`; that package does not import desktop, React or a Node loader. The host never exports a general Pi object to the browser.

The small EventBus adapter is **discovery only**. It transports a declaration inside the trusted Node process because released Pi does not expose a desktop registration hook. It does not recreate Chord calls, subscriptions or replicated state. Host listeners exist before extension loading, and discovery can replay the same declaration without running the extension factory again. Registration failure appears in extension diagnostics. Backend declarations carry code and remain entirely outside renderer IPC.

After Pi finishes loading, the host matches the declaration's source real path against the final loaded extension catalog, rejecting missing/ambiguous origins and duplicate IDs. It assigns its own task, extension, view and generation identity. The backend facet is activated only once after validation. Because existing Pi extensions are trusted Node code, source matching prevents accidental misrouting; it is not authentication against a hostile installed backend.

Opening a tab requests a connection bound by main to that task/view and initiating window. The frame sends Chord JSON service messages over its dedicated port; preload and main route only that connection. Main validates the sender and connection generation and exposes only that view's advertised services. Chord performs service/state handling. File navigation and preparing a fix-task draft are separate narrow host services, not unrestricted IPC access.

## Custom frontend boundary

Use a sandboxed iframe with scripts enabled and an opaque origin. Do not grant same-origin access, Node, the parent preload API, popups or top navigation. The frame controller binds its initial message-port handshake to the actual frame and mount generation; subsequent operations travel only over that port.

Authors ship prebuilt browser modules and local assets. For the first pilot, assets must be beneath the canonical directory of the matched Pi entrypoint. Main resolves every served asset's real path, rejects traversal/symlink escapes, and serves it through a dedicated read-only asset route. A later package-root convention must resolve from Pi's selected package, not assume optional catalog metadata is an authenticated root. The frame's content policy permits only those scripts/assets and required local styling. Direct network access is disabled; network/file/tool work runs in the extension backend. No runtime package installation, build commands or Node-style `require` are part of mounting a view.

This introduces executable frontend code deliberately. Browser containment and narrow capabilities must be verified before user-installed views are enabled. It is not a claim to sandbox the already-trusted Pi backend.

## State and lifecycle

Pi session entries remain the durable owner of extension results. Chord state is the live projection. Desktop UI storage saves tab references and small presentation preferences only. Closing a view releases its port/subscriptions and mount resources; closing it does not cancel an ongoing review.

Each Pi session owns a separate backend host. Each open window/view gets its own connection; actions retain their original target across task switches. A delayed fix-task action returns to the initiating window and does not steal selection. Closed windows invalidate their connections.

Pi extension reload is a broader boundary than Chord provider replacement: invalidate old view connections, settle pending actions as unavailable, dispose the host, let Pi reload once, then rebuild registrations and reconnect. Do this when the session is idle or through the explicit reload flow. Chord's seamless replacement can be used within a still-valid host; it does not make an old Pi extension closure safe after Pi invalidates it. No unknown-outcome mutation is automatically replayed.

## Implementation gates

1. Complete the Pi upgrade and daily coding verification first.
2. Build one file-based PR Review extension and mount its prebuilt frontend in Electron. Prove a backend operation and live result across the real frame/preload/main boundary.
3. Prove task/window isolation, stale connections, close/reopen, reload/disable and malformed requests. Prove the frame cannot access the parent API, escape asset paths, navigate the app or use direct network access. Extend the renderer guard only for the audited frame host, without a general dynamic-import exemption.
4. Add a second workflow, such as an approval queue, to validate the author contract without app-specific patches. Then publish the helper and browser build example.

This keeps custom interfaces possible now while limiting Pi-gui's new API to the desktop responsibilities that upstream does not supply.
