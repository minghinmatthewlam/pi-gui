# GitHub (prototype)

A side-panel view of the current repository's pull requests and issues, with a
one-click way to turn one into an unsent task draft.

- **Pull requests**: open, closed/merged, and **Needs attention** (failing CI or
  changes requested). Rows show state, title, number, author, updated time,
  branch, CI status, draft badge and review decision. Expanding a PR lists its
  failing checks and diff size when available.
- **Issues**: open and closed, with labels, author, comments and updated time.
  Expanding an issue shows a plain-text excerpt of its description.
- **Start thread** prepares an editable draft in a new task: "Fix #216: …" for an
  issue, "Fix failing CI on PR #223" for a PR with failing checks, "Address
  review on PR #…" for requested changes, otherwise "Review PR #…". Nothing is
  sent, and nothing is posted to GitHub.
- **Open on GitHub** is shown disabled: views cannot open URLs yet.

## Data

The backend runs the local `gh` CLI in the task's folder with fixed arguments,
a 20 second timeout and an 8 MiB output cap: `gh repo view`, then `gh pr list`
and `gh issue list` for open (50) and closed (25) items. The browser can only ask
for a refresh; it never supplies arguments.

- `gh` not installed: the view explains this and shows the bundled snapshot in
  `fixtures/pi-gui-snapshot.json` (pi-gui's own PRs and issues, captured
  2026-09-30), labelled "Snapshot from …".
- `PI_GUI_GITHUB_FIXTURE=/path/to/snapshot.json`: always use that snapshot.
  The desktop test uses this so it never contacts GitHub.
- Not a GitHub repository, or `gh` not signed in: the view says so.

`/github` prints the same summary in a terminal Pi session.

## Build and verify

```sh
node examples/desktop-extensions/github/build.mjs
node node_modules/typescript/bin/tsc -p examples/desktop-extensions/github/tsconfig.json
node --experimental-strip-types --test examples/desktop-extensions/github/test/*.test.mts
```

Load it like the other examples: add
`/absolute/path/to/pi-gui/examples/desktop-extensions/github/index.ts` to
`extensions` in `.pi/settings.json`, refresh extensions, then choose **GitHub**
under **Add tab (+) → Extension views**. The Electron test is
`apps/desktop/tests/core/extension-github-view.spec.ts`.
