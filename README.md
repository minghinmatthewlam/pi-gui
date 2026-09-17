# pi-gui

A Codex-style desktop app for the [`pi`](https://github.com/earendil-works/pi) coding agent.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/minghinmatthewlam/pi-gui?include_prereleases&label=release)](https://github.com/minghinmatthewlam/pi-gui/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](#install)

pi-gui gives `pi` a native home on the desktop: a threaded timeline of your agent
sessions, git worktrees per thread, an integrated terminal and inline diff viewer,
and multi-agent orchestration — all backed by `pi`'s own session files as the source
of truth. It is a UI shell around [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
not a separate agent runtime: session management, model/auth setup, and agent
execution all run through upstream `pi`.

![pi-gui in action](./docs/assets/demo.gif)

<sub>Expanding a tool call, reviewing the diff panel, the integrated terminal, and a theme switch. ([higher-quality MP4](./docs/assets/demo.mp4))</sub>

## Screenshots

| Thread timeline (dark) | Thread timeline (light) |
| --- | --- |
| ![Thread view, dark theme](./docs/assets/thread-dark.png) | ![Thread view, light theme](./docs/assets/thread-light.png) |

| Inline diff viewer | Integrated terminal |
| --- | --- |
| ![Diff panel](./docs/assets/diff-dark.png) | ![Integrated terminal](./docs/assets/terminal-dark.png) |

## Features

- **Threaded timeline** — each session renders as a timeline of messages and
  collapsible tool calls, Codex-style.
- **Git worktrees per thread** — start a thread in the workspace directly (`Local`)
  or in an isolated git worktree so parallel work never collides.
- **Multi-agent orchestration** — an orchestrator thread can spin up and supervise
  child worker threads.
- **Integrated terminal** — a real PTY terminal (via `node-pty`) docked in the app.
- **Inline diff viewer** — review changed files in a side panel (toggle with
  <kbd>⌘/Ctrl</kbd>+<kbd>D</kbd>).
- **Composer niceties** — `@`-mention files, and paste or drag-and-drop image
  attachments straight into the prompt.
- **Skills & extensions** — manage `pi` skills and extensions from a dedicated view.
- **Appearance themes** — light and dark, with selectable theme presets.
- **Native notifications** — get an OS notification when an agent run finishes.
- **Session archive** — archive threads you're done with to keep the sidebar tidy.
- **Multiple providers** — connect model providers via OAuth or API key under
  **Settings → Providers**.

## Install

pi-gui is in public beta for **macOS** and **Linux (AppImage)**.

### From GitHub Releases

Download the latest `.dmg` (macOS) or `.AppImage` (Linux) from the
[Releases page](https://github.com/minghinmatthewlam/pi-gui/releases).

On macOS, drag `pi-gui.app` into `/Applications` and launch it. Releases are signed
and notarized. To update, download the newer release and replace the app.

### With Homebrew (macOS)

```bash
brew tap minghinmatthewlam/tap
brew install --cask pi-gui
```

Update with `brew upgrade --cask pi-gui`. During beta, a Homebrew upgrade may prompt
you to re-confirm macOS permissions or Dock placement.

### From source

See [Development](#development). Building from source is intended for contributors,
not as the primary install path.

## Quickstart

1. Install pi-gui and launch it.
2. Open **Settings → Providers** and connect a model provider (OAuth or API key).
3. Add a workspace (a local project folder).
4. Click **New thread**, pick `Local` or `Worktree`, and send your first prompt.

You need valid model/provider authentication that `pi` supports; pi-gui uses `pi`'s
auth and session state, so anything you've already configured with the `pi` CLI
carries over.

## Architecture

pi-gui is an Electron app organized around a tight main/preload/renderer boundary,
sitting on top of the `pi` runtime:

- **Renderer** (`apps/desktop/src`) — the React UI: timeline, composer, diff panel,
  terminal, settings. It talks to the main process only through a typed IPC surface.
- **Preload** (`apps/desktop/electron/preload.ts`) — the narrow bridge that exposes
  that IPC surface to the renderer; the renderer gets no broad Node access.
- **Main** (`apps/desktop/electron`) — the Node side: windowing, session supervision,
  worktrees, terminal PTYs, notifications, and persistence.
- **`packages/pi-sdk-driver`** — a thin adapter from the desktop app to
  `@earendil-works/pi-coding-agent`. It stays close to upstream `pi` and does not
  fork or reimplement runtime behavior.
- **JSONL session files as the source of truth** — `pi` persists each session as a
  JSONL transcript on disk; pi-gui reads those files as the authoritative record for
  closed sessions rather than keeping a divergent copy.

Supporting packages: `packages/session-driver` (shared session driver types) and
`packages/catalogs` (lightweight workspace/session catalog state).

## Development

Requires Node 20+ and [pnpm](https://pnpm.io) (managed via `corepack`). pnpm is
the supported package manager, and `pnpm-lock.yaml` is the authoritative lockfile.

```bash
corepack enable
pnpm install
```

Common commands (run from the repo root):

```bash
pnpm dev         # run the desktop app in development (electron-vite, hot reload)
pnpm build       # build all workspaces
pnpm typecheck   # type-check all workspaces
pnpm lint        # lint all workspaces
pnpm test        # run each workspace's tests (desktop runs the core E2E lane)
```

Desktop end-to-end tests use a Playwright + Electron harness and are organized into
lanes. The default `pnpm test` runs the `core` lane; to run everything:

```bash
pnpm --filter @pi-gui/desktop run test:e2e:all   # core + live + native
```

See [`apps/desktop/README.md`](./apps/desktop/README.md) for lane details and
platform-specific packaging notes. Package a Linux AppImage locally with:

```bash
pnpm --filter @pi-gui/desktop run package:linux
```

## Repository layout

- `apps/desktop` — the Electron app (renderer UI + main/preload).
- `apps/website` — the marketing/landing site.
- `packages/pi-sdk-driver` — adapter over `@earendil-works/pi-coding-agent`.
- `packages/session-driver` — shared session driver types.
- `packages/catalogs` — workspace/session catalog state.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup,
verification expectations, and the desktop test lanes. Desktop changes are expected
to be verified on the real Electron surface, not only by unit tests.

## Computer use

Native computer use is not built into pi-gui. Desktop/browser control is available
separately through the author's standalone
[`computer-use-mcp`](https://github.com/minghinmatthewlam/computer-use-mcp) server,
which any MCP-capable agent can use.

## Acknowledgements

- Built on [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
- Upstream runtime and ecosystem by [`earendil-works/pi`](https://github.com/earendil-works/pi).

## License

[MIT](./LICENSE) © Matthew Lam
