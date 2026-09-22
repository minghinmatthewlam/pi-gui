# Test Runs desktop extension

This is a normal file-based Pi extension with an optional custom browser view.
The command, agent tool and desktop buttons share one backend run owner. It uses
the released Pi 0.87 `createLocalBashOperations` API for live process output,
timeout and cancellation. The optional desktop declaration uses Pi-gui's local
private `@pi-gui/extension-ui` package. This helper is implemented in this repository;
it is not published to npm or provided by upstream Pi.

The supplied suites execute real `node:test` files: a passing suite, an intentional
failure, a slow suite, and that same slow suite with a short timeout. They do not
run the pi-gui repository's checks. Node must be on the shell PATH. To adapt this
example, edit the fixed suite definitions in `index.ts`; the browser never sends
shell text or filesystem paths.

From the repository root, with its existing dependencies installed:

```sh
node examples/desktop-extensions/test-runs/build.mjs
node examples/desktop-extensions/test-runs/build.mjs --check
node --experimental-strip-types --test examples/desktop-extensions/test-runs/test/*.test.mts
```

The build produces `dist/desktop.js`, a browser ES module with its dependencies
bundled. Pi loads `index.ts` as the normal extension entry; its backend imports
Chord from the host installation and must not bundle a second backend Chord copy.
The host must load the frontend below that entry's directory and supply the
scoped service connection. No app-specific Test Runs API is needed.

The `--check` command builds in memory and compares the result with the checked-in
browser bundle. It fails for a missing or stale bundle and never writes `dist`.
`tsconfig.lint.json` covers the TypeScript source and test files, excluding the
generated browser bundle.

Terminal use remains `/tests passing`, `/tests failing`, `/tests slow`,
`/tests timeout` and `/tests stop`; the agent tool is `run_tests({suiteId})`.
The desktop helper can report no available host without preventing these paths.

## State and results

The backend accepts `start({suiteId,requestId})` and `cancel({runId})`. One run can
be active per Pi session. A repeated request ID returns its original run ID;
reusing it for another suite fails. A disconnected browser does not cancel an
accepted run. Do not automatically retry a mutation whose response was lost.

Started and settled run records use versioned `pi.appendEntry` custom entries.
They do not enter model context. Session start and tree navigation rebuild the
current branch's records, and the view shows the 20 most recent runs. A saved
start with no settled result is shown as interrupted with an unknown result.
Reload/shutdown and tree navigation stop and await current work before replacing
the runtime or branch. Closing the view only releases its subscription.
Disposing the backend host also stops and awaits the process, including desktop
quit paths that do not emit Pi's session shutdown event.

The view reports raw command output and exit status. A zero exit is described as
command completion; the example does not infer test counts or claim that tests
ran from that exit alone. Output is merged stdout/stderr and retains only its last
32 KiB per run, with the original received byte count and an explicit truncation
notice. Earlier output is not retained. No report parser or hidden full-output
file is implied. Cancellation, timeout, execution error and interrupted results
remain separate from completed exit codes.

Pi-gui flushes new session files before binding them. Released terminal Pi can
defer its first file write until the first assistant message, so a fresh terminal
session does not promise immediate crash durability from `appendEntry` alone.

## Verification scope

The sample tests exercise real passing, failing, cancelled and timed-out child
processes, live output, restoration, request dedupe, truncation and save failure.
An integration test loads the actual file extension and disposes its Chord host
while the slow fixture runs, then checks the cancelled record and process exit.
They do not prove Electron transport or browser containment. The desktop gate
must open this view in Electron, observe output before completion, stop a slow
run, close/reopen during another run, restart, and verify separate task histories.
Also exercise branch navigation and reload while active, malformed service calls,
and stale view connections through the host's verification path.

Direct calls to the shell operation do not invoke Pi's tool interception hooks.
The registered `run_tests` agent tool enters ordinary tool dispatch, while a user
clicking Run suite invokes the extension service directly. This example makes no
claim that the desktop button traverses third-party tool approval extensions.
