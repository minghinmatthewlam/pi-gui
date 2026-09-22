# Pi extensions with desktop views

These are ordinary file-based Pi extensions. Pi loads each `index.ts` once; its
commands, tools, saved session entries, and optional desktop view share that
extension instance. A view is custom browser code, connected to the extension's
service through Chord. It does not require a new app-specific IPC operation.

| Example                            | Backend operation                                                                           | Desktop interaction                                                   | Terminal fallback                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [PR Review](./pr-review/README.md) | Ask Pi to review a real GitHub PR at a captured commit and record structured local findings | Refresh PR, review, open a finding's file, prepare an unsent fix task | `/pr-review`                                                                       |
| [Test Runs](./test-runs/README.md) | Execute fixed demonstration test suites, stream bounded output, stop or time out a process  | Choose a suite, run, inspect output, stop                             | `/tests passing`, `/tests failing`, `/tests slow`, `/tests timeout`, `/tests stop` |

The test suites are actual `node:test` fixtures, including an intentional failure;
they are not pi-gui's repository checks. PR Review needs a configured Pi model,
`git`, authenticated `gh`, and the PR head/base commits already present locally.
Neither example installs dependencies, posts a GitHub review, or merges a PR.

## Build and configure locally

Use this checkout's installed dependencies. `@pi-gui/extension-ui` is a **private,
local workspace package**, not a published npm package or an upstream Pi API.
For this development workflow, keep the examples in this checkout so their
backend imports resolve through its `node_modules`. The root links the helper
as a workspace dependency. The backend
uses the host's Chord installation; only the browser code bundles its own imports.

From the pi-gui repository root, after the normal repository dependency setup:

```sh
pnpm --filter @pi-gui/extension-ui build
node examples/desktop-extensions/pr-review/build.mjs
node examples/desktop-extensions/test-runs/build.mjs
```

Add the absolute paths to the existing `extensions` array in the target project's
`.pi/settings.json`, or `~/.pi/agent/settings.json` for user-wide availability.
Preserve the file's other settings and existing extension entries. For example,
replace `/absolute/path/to/pi-gui` with this checkout's actual location:

```json
{
  "extensions": [
    "/absolute/path/to/pi-gui/examples/desktop-extensions/pr-review/index.ts",
    "/absolute/path/to/pi-gui/examples/desktop-extensions/test-runs/index.ts"
  ]
}
```

This is Pi's normal local extension configuration. Project-local resources follow
Pi's project trust decision. Do not register `desktop.ts` or `dist/desktop.js` as
Pi extensions. Pi's auto-discovered `.pi/extensions/*/index.ts` and
`~/.pi/agent/extensions/*/index.ts` locations are also supported, but moving these
examples there requires arranging their backend dependencies too.

In pi-gui, select that project and use **Extensions → Refresh** to reload runtime
discovery and inspect diagnostics, then **Back to app**. This path also works
before a model is configured. In a task with a configured model, `/reload` is
another way to reload the idle runtime after changing extension configuration.
Open the side panel, click **Add tab (+)**, and choose
**PR Review** or **Test Runs** under **Extension views**. **Refresh views** refreshes
that list. The existing Extensions screen manages Pi extensions; it is not a
separate desktop-view installer.

For a temporary terminal invocation from this checkout, use the installed Pi
entry point and an explicit file path:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  -e "$PWD/examples/desktop-extensions/test-runs/index.ts"
```

Then enter `/tests passing`. Terminal Pi has no desktop host, so registration
reports `available === false`; the command and agent tool still work. A missing
or broken browser bundle similarly does not remove a successfully loaded Pi
extension's commands. The helper package itself must still be resolvable.

## Install local packages outside this checkout

The examples also declare `pi.extensions: ["./index.ts"]` and can be installed as
local packages. After the builds above, pack the helper and both examples from
the repository root:

```sh
extension_tarballs="$PWD/.artifacts/extension-authoring"
mkdir -p "$extension_tarballs"
pnpm --dir packages/extension-ui pack --pack-destination "$extension_tarballs"
pnpm --dir examples/desktop-extensions/pr-review pack --pack-destination "$extension_tarballs"
pnpm --dir examples/desktop-extensions/test-runs pack --pack-destination "$extension_tarballs"
```

In a separate package directory with its own `package.json`, install those local
archives and the matching released Pi packages. Keep `extension_tarballs` set to
the absolute archive directory, or replace it with that path:

```sh
pnpm add \
  "$extension_tarballs/pi-gui-extension-ui-0.0.0.tgz" \
  "$extension_tarballs/pi-gui-example-pr-review-0.0.0.tgz" \
  "$extension_tarballs/pi-gui-example-test-runs-0.0.0.tgz" \
  @earendil-works/chord@0.87.0 \
  @earendil-works/pi-ai@0.87.0 \
  @earendil-works/pi-coding-agent@0.87.0
```

Then add the installed **package directories** to the existing Pi `extensions`
setting for the project where you want to use them:

```json
{
  "extensions": [
    "/absolute/path/to/local-extensions/node_modules/@pi-gui/example-pr-review",
    "/absolute/path/to/local-extensions/node_modules/@pi-gui/example-test-runs"
  ]
}
```

Pi reads each package's `pi.extensions` declaration. Use the same runtime refresh
and **Add tab** workflow described above. The archives include their prebuilt
browser entry; this installation does not need a browser build. Edit source in
your authoring checkout, rebuild, repack, and reinstall an updated archive before
reloading the installed copy. Installing a tarball creates a separate copy; later
source edits do not update it automatically.

This path was verified with the actual packed files installed in a separate
temporary project, using Pi/Pi AI/Chord 0.87.0 and an offline cached dependency
set. The normal `pnpm add` command above can obtain those released dependencies
from the registry. The proof confirmed that every package resolved inside the
external project's `node_modules`, both real TypeScript entry points loaded with
zero Pi diagnostics, their commands/tools and desktop declarations registered,
and their browser assets existed under the loaded package directory. That
installation check did not execute backend actions or render Electron; the
separate desktop tests exercise those paths. No public npm publication of the
helper or examples is implied.

## Edit and reload

| Changed files                                               | Apply the change                                                | What remains                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Browser `desktop.ts`, CSS, or browser dependencies          | Run that example's `build.mjs`, then **Reload view** in its tab | Same Pi backend, accepted work, and saved results                                                    |
| Backend `index.ts`, tools, state logic, or view declaration | Finish or stop active work, then `/reload` in the task          | Versioned entries restore the current Pi branch's results; unfinished work is not claimed to be live |
| Shared service contract                                     | Rebuild the browser, then `/reload` and reopen/reload the view  | Both ends use the updated contract                                                                   |

Closing a view releases its connection and subscriptions. It does not disable
the extension or stop accepted backend work. Test Runs has an explicit **Stop**
action. A PR review uses Pi's normal task Stop control. **Reload view** only
reconnects the browser; it does not reload backend code or recover a rejected Pi
request.

The browser exports `mount(root, host)` and returns a disposer. Wait for the scoped
service binding's `ready()` before reading state or subscribing. Observe
`host.signal` so a closed view does not reuse stale capabilities. The host supplies
theme colors and scoped `openFile` / `prepareTaskDraft` actions; a prepared draft
is editable and is never sent automatically. Create backend replicated state
with `env.replicatedState` so it belongs to the host's Chord instance.

## Verify an edit

These commands use the installed repository toolchain and do not launch Electron:

```sh
node examples/desktop-extensions/pr-review/test.mjs
node --experimental-strip-types --test examples/desktop-extensions/test-runs/test/run-owner.test.mts
node node_modules/typescript/bin/tsc -p examples/desktop-extensions/pr-review/tsconfig.json
node node_modules/typescript/bin/tsc -p examples/desktop-extensions/test-runs/tsconfig.json
node examples/desktop-extensions/pr-review/build.mjs --check
node examples/desktop-extensions/test-runs/build.mjs --check
```

`--check` bundles in memory and compares the result with checked-in
`dist/desktop.js`; it never overwrites the artifact. Both builders also work when
invoked as `node build.mjs --check` inside their example directory. The examples
have scoped lint projects covering their TypeScript source and test files;
generated browser output is excluded from source linting.

The root shortcuts `pnpm test:extension-examples` and
`pnpm typecheck:extension-examples` run these test/freshness and type checks.
They are included in the repository baseline and typecheck commands respectively.

PR Review's offline integration test loads the actual `index.ts` through installed
Pi, creates the declared Chord backend, and uses a real temporary Git checkout.
GitHub metadata is a fixture executable and the model has an unauthenticated
fixture provider: it makes no GitHub or provider requests. It proves the real
admission failure path, not review quality.

Pi 0.87's public `sendUserMessage` returns `void`. A successful service response
therefore means **Requested**, not that model execution began. Only the matching
`before_agent_start` makes this review **Running**. Authentication or other
preflight failures appear in Pi's extension runtime diagnostics and can leave
the view **Requested**. Resolve the error and `/reload`; restoration shows
**Interrupted**, allowing a new explicit request. Do not automatically replay an
operation with an unknown outcome. A settled turn without the structured
recording tool is **Incomplete**, not a clean review.

Before claiming a desktop feature works, additionally exercise the actual file
and browser bundle in Electron: open both views; run and stop Test Runs; close and
reopen during a run; reload and switch tasks; run a real-provider PR review; open
a real finding; inspect the unsent fix draft; move the PR revision and confirm
stale results cannot prepare a fresh fix. The example READMEs describe further
failure cases. Offline tests alone do not establish that product proof.
