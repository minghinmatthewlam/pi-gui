# pi-gui

Electron desktop shell for `pi` sessions.

This repo packages a desktop UI around `@mariozechner/pi-coding-agent`. It is not a standalone coding agent runtime. The app depends on the upstream `pi` package for session management, model/auth setup, and agent execution.

![pi-gui demo](./docs/readme/demo.gif)

## Status

- Beta (macOS arm64, Linux AppImage)
- Public source repo

## Install

### From GitHub Releases

Download the latest `.dmg` or `.AppImage` from [Releases](https://github.com/minghinmatthewlam/pi-gui/releases).

Signed and notarized beta releases are the primary direct install path. Drag `pi-gui.app` into `/Applications`, then launch it normally.

Linux releases ship as AppImages.

To update a DMG install, download the latest release and replace the app in `/Applications`.

### With Homebrew

Install from [`minghinmatthewlam/homebrew-tap`](https://github.com/minghinmatthewlam/homebrew-tap):

```bash
brew tap minghinmatthewlam/tap
brew install --cask pi-gui
```

To update a Homebrew install:

```bash
brew upgrade --cask pi-gui
```

Homebrew upgrades may behave more like reinstall than in-place patching on macOS. During beta, you may need to re-confirm Dock placement or some permission prompts after upgrading.

### From Source

See [Development](#development) below. Source install is intended for contributors and local development, not the primary end-user install path.

## What It Does

- Opens local workspaces in a desktop shell
- Lists and resumes `pi` sessions associated with each workspace
- Creates new sessions and sends prompts through the `pi` runtime
- Persists desktop UI state such as selected workspace, selected session, and composer draft

## Prerequisites

- Valid model/provider authentication supported by `pi`

On first launch, go to **Settings > Providers** to connect your AI provider via OAuth.

## Development

Install dependencies:

```bash
corepack enable
pnpm install
```

Run the desktop app in development:

```bash
pnpm dev
```

Build everything:

```bash
pnpm build
```

Run the default test suite:

```bash
pnpm test
```

Desktop E2E lanes and setup are documented in [`apps/desktop/README.md`](./apps/desktop/README.md). The default desktop test command runs the `core` lane; use `pnpm --filter @pi-gui/desktop run test:e2e:all` when you need `core`, `live`, and `native`.

Package a Linux AppImage locally:

```bash
pnpm --filter @pi-gui/desktop run package:linux
```

Production-like packaged-app checks:

```bash
pnpm --filter @pi-gui/desktop run test:prod:packaged-smoke
```

Release automation expects these GitHub Actions secrets for signed/notarized macOS builds:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Regenerate the README demo assets:

```bash
pnpm --filter @pi-gui/desktop demo:readme
```

## Repository Layout

- `apps/desktop`: Electron app and renderer UI
- `packages/session-driver`: shared session driver types
- `packages/catalogs`: lightweight workspace/session catalog state
- `packages/pi-sdk-driver`: adapter from the desktop app to `@mariozechner/pi-coding-agent`

## Known Limitations

- The app currently relies on upstream `pi` behavior and local auth state.
- Live end-to-end validation may require model credentials not stored in this repo.
- Homebrew beta upgrades may require macOS to re-confirm some app permissions or Dock placement.

## Acknowledgements

- Built on top of [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- Upstream runtime and ecosystem by [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)

## License

MIT. See [LICENSE](./LICENSE).
