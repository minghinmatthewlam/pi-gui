# PR Review desktop extension

A normal, file-based Pi extension with an optional custom desktop view. It reviews the current branch's real GitHub PR through the configured Pi model. Findings are saved locally in Pi session entries. It does not publish a review, edit files, fetch branches, or install anything.

## Build and load

From the repository root, with the existing dependencies and `@pi-gui/extension-ui` workspace package built:

```sh
node examples/desktop-extensions/pr-review/build.mjs
node examples/desktop-extensions/pr-review/test.mjs
node node_modules/typescript/bin/tsc -p examples/desktop-extensions/pr-review/tsconfig.json
```

Add this example's absolute `index.ts` path through the existing Pi extension configuration, then reload the idle session. Do not load `desktop.ts` as a Pi extension. `dist/desktop.js` is the prebuilt browser entry served by the desktop host. The helper discovers the view from this same extension instance; there is no second backend loader.

The backend needs `git`, authenticated `gh`, and a local checkout of the PR head. The PR head, base, and merge-base objects must already exist locally. Errors from missing GitHub access, a missing PR, unavailable Git objects, and unsupported large diffs are shown in the panel. This example bounds Git/GitHub commands to 20 seconds and 1 MiB of output, and supports at most 200 changed files and 20 findings.

## Workflow

1. Open **PR Review**, then **Refresh PR**. The view displays the real repository, PR, head revision, and changed files.
2. Click **Review with Pi**. The extension submits a normal Pi review turn and exposes only its snapshot-reading and findings-recording tools for that review. The previous tool selection is restored when the run settles. `/pr-review` invokes the same operation in terminal Pi.
3. Pi reads diffs and source at the captured Git commit, even if a working file changes meanwhile. Its recording tool validates the review ID, head, changed-file locations, and line bounds. An empty list means Pi recorded no actionable findings; a response without the recording tool is **Incomplete**.
4. After the actual run settles, select a finding's file link or **Prepare fix task**. The latter creates an editable draft with PR/head/review/finding provenance. It does not send the draft. The host binds file and draft actions to this view's original task and checkout.
5. Refresh detects PR/base movement and a different local checkout. Previous findings stay visible, and preparing a fix requires the reviewed revision to remain current. Local uncommitted changes are shown separately because the review covers committed PR content.

Findings reference existing files and line numbers at the PR head. A deleted-file-only finding cannot use a head location in this small example. Git output over the limit fails visibly; it is not silently truncated and presented as a full review.

## Author contract

- `index.ts` owns Pi hooks, commands, tools, lifetime, and the Chord backend facet. Chord stays external to the backend; mutable state is created with `env.replicatedState`.
- `contract.ts` shares the service token and JSON domain types. The browser calls `refresh`, `request`, and `prepareFix` through its scoped Chord source.
- `repository.ts` runs bounded, argument-based Git/GitHub reads. The browser receives no command execution capability.
- `desktop.ts` is independently bundled browser code. `mount(root, host)` returns a disposer, observes the host abort signal, consumes theme values, and uses only `openFile` and `prepareTaskDraft` host actions.
- Versioned `pi-gui.pr-review.v1` entries are the durable owner. Chord is the live projection. Branch restoration reads `getBranch()`. A request or run with no settlement restores as **Interrupted**, never as a live or successful operation.

Pi 0.87's `sendUserMessage` API returns `void`; an accepted service call means **Requested**, not provider admission. The matching `before_agent_start` confirms a running review. A preflight rejection appears through Pi's extension runtime diagnostics; this example does not automatically retry a request with an unknown outcome. Reload after resolving a preflight error restores it as interrupted. The final outcome comes from `agent_before_settle`, with status persisted only at `agent_settled`, after retries and continuations finish.

## Verification boundaries

The example tests prove revision/location validation, stale-draft rejection, interrupted branch restoration, and real Git snapshot reads after the working copy changes. An offline integration test loads the actual extension file through installed Pi and invokes its Chord service. With fixture GitHub metadata and an unauthenticated fixture model, real Pi preflight rejects: the request remains Requested and restores Interrupted. No real provider or GitHub request runs in this test. These checks do not prove provider review quality or the Electron boundary.

The coordinating desktop verification must additionally load this actual file, mount its actual bundle, run a real provider review on an existing PR, open a real finding location, and inspect the prepared draft. It should also exercise Stop, no recording-tool call, reload/close/reopen, task/window isolation, stale revisions, missing auth, and the ordinary coding tool set after a review. No GitHub posting is part of this proof.
