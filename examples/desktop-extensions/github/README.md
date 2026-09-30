# GitHub

One Pi extension that ties GitHub into pi-gui two ways: a side-panel view of the
current repository's pull requests and issues for you, and a `github_read` tool
the model can use to read one issue or pull request.

- **Pull requests**: open, closed/merged, and **Needs attention** (failing CI or
  changes requested). Rows show state, title, number, author, updated time,
  branch, CI status, draft badge and review decision. Expanding a PR lists its
  failing checks and diff size when available.
- **Issues**: open and closed, with labels, author, comments and updated time.
  Expanding an issue shows a plain-text excerpt of its description.
- **Open on GitHub** opens the PR or issue in the browser (`host.actions.openUrl`).
- **Start thread** prepares an editable draft in a new task: "Fix #216: …" for an
  issue, "Fix failing CI on PR #223" for a PR with failing checks, "Address
  review on PR #…" for requested changes, otherwise "Review PR #…". Nothing is
  sent, and nothing is posted to GitHub.
- **`github_read({ kind: "issue" | "pr", number })`**: in any thread, "look at
  issue 216" lets the model read that issue's title, state, labels, body and last
  five comments; for a PR also its branch, review state, checks and changed files.
  The text is quoted as GitHub content, not instructions, and capped at 16k
  characters. It only reads.

## Data

The backend runs the local `gh` CLI in the task's folder with fixed arguments,
a 20 second timeout and an 8 MiB output cap. The view runs it only while open:
when it mounts with no data or data older than a minute, and on **Refresh**. It
runs `gh repo view`, then `gh pr list` and `gh issue list` for open (50) and
closed (25) items. The tool runs `gh repo view` and `gh issue|pr view <number>`.
The browser can only ask for a refresh; it never supplies arguments.

- `gh` not installed: the view says so, with a **Get the GitHub CLI** button.
- Not a GitHub repository, or `gh` not signed in: the view says so. The tool
  passes `gh`'s own message to the model.

`/github` prints a summary in a terminal Pi session.

## Build and verify

```sh
node examples/desktop-extensions/github/build.mjs
pnpm --dir examples/desktop-extensions/github typecheck
pnpm --dir examples/desktop-extensions/github test
```

The tests use `test/fake-gh.mjs`, a stand-in `gh` that answers from
`test/fixtures/pi-gui.json`. Load the example like the others: add
`/absolute/path/to/pi-gui/examples/desktop-extensions/github/index.ts` to
`extensions` in `.pi/settings.json`, refresh extensions, then choose **GitHub**
under **Add tab (+) → Extension views**. The Electron test is
`apps/desktop/tests/core/extension-github-view.spec.ts`.
