# Desktop extension author helper

The existing Pi extension owns the backend. An optional browser module owns the
view. This package connects them through Chord without scanning or loading a
second extension instance.

```ts
import { registerDesktopView } from "@pi-gui/extension-ui";
import { defineFacet } from "@earendil-works/chord";

export default function extension(pi) {
  registerDesktopView(pi, {
    id: "review",
    title: "Review",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "review-backend",
        setup(env) {
          // Use env.replicatedState and provide your shared service token here.
          // Close over the same Pi extension's commands, tools, and saved state.
        },
      }),
  });
}
```

`registerDesktopView` returns an object with `available` and `dispose()`. Terminal
Pi reports `available === false`. Availability acknowledges discovery; the desktop
validates the loaded extension source and browser assets before activating the
backend. Discovery replays the same declaration, and session shutdown unregisters
it. The helper does not invoke the backend factory.

The browser entry exports `mount(root, host)`, returning a cleanup function or a
promise of one. `DesktopViewContext` is exported from
`@pi-gui/extension-ui/browser`. Its `services` is a Chord `RemoteServiceSource`, so
the frontend can create its own facet host with `serviceSources: [host.services]`.
Use `env.use(Service)` during setup, then subscribe to state in `env.onActivate`.
Bundle the browser's framework and Chord dependencies. Backend facets must create
state with `env.replicatedState`, which uses the host's Chord instance.

`host.actions.openFile({ path, line?, column? })` opens a scoped file target.
`host.actions.prepareTaskDraft({ title, prompt, files? })` prepares a task draft.
Neither accepts a workspace, session, or window identity. The desktop binds actions
to the initiating connection. The host supplies theme colors and an `AbortSignal`
that reports connection loss; the frontend should stop using old service handles
when that signal aborts.

`@pi-gui/extension-ui/transport` provides server and client connections over an
ordered JSON message channel. Each connection owns a Chord endpoint; Chord owns
service dispatch and replicated state. The adapter validates complete messages,
uses a separate state codec per subscription, and buffers updates until hydration
is installed. Closing a connection releases subscriptions and rejects waiting
client requests. Accepted backend work continues, and late responses are discarded.
An explicit request cancellation propagates its abort signal to the backend method.
Connection teardown never disposes the shared backend host.

The package build emits `dist/frame-bridge.js`, a self-contained browser module for
the app-owned frame bootstrap. It exports `createChordClientConnection` and
`parseDesktopHostAction`. The desktop supplies and scopes the channel; this package
does not expose Electron, Node, filesystem access, or general IPC to the browser.

Run `pnpm --filter @pi-gui/extension-ui test` for registration, action validation,
transport lifecycle, malformed-message, and separate-browser-bundle checks. The
bundle test executes two distinct browser-target modules in Node to prove the
Chord module boundary; desktop tests separately prove the real iframe/IPC flow.

Desktop development starts `pnpm --filter @pi-gui/extension-ui watch` alongside
the other shared-package watchers. Each TypeScript emit is followed by a browser
bridge rebuild, so edits update both the normal modules and the self-contained
frame entry. The watcher closes both compiler and bundler resources on shutdown.
