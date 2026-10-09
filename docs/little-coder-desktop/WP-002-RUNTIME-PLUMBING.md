# WP-002 — Runtime/profile plumbing

## Scope and result

Following the WP-001 process-adapter recommendation, this checkpoint adds an internal,
disabled-by-default runtime profile host at `DesktopAppStore` composition. Standard Pi
continues to use the existing `PiSdkDriver` with the same options. Little Coder bootstrap
uses a separately supervised launcher process per session.

There was no detailed WP-002 work-package file. The roadmap and
[WP-001 findings](WP-001-INTEGRATION-FINDINGS.md) define this bounded checkpoint:
discovery, bootstrap, runtime identity, cancellation and shutdown. It is not yet a
Little Coder conversation driver. No renderer/preload API or profile picker is added.

## Activation and ownership

Main-process callers can supply `DesktopAppStoreOptions.littleCoder` with
`{ enabled: true, packageRoot }`. The root must identify a separately installed
`little-coder@1.20.0` package with its own `@earendil-works/pi-coding-agent@0.83.0`.
These are the versions inspected in WP-001; other versions fail closed.
Diagnostics report discovery availability, not successful upstream execution.

The host validates canonical resource paths, launcher layout and dependency metadata.
It does not install packages, patch source, search global installations or copy resources.
The upstream launcher still owns resource loading and any upstream-owned source patching.
The caller must supply a trusted installation: package metadata checks are not integrity
or authenticity verification.

`bootstrapLittleCoderRuntime({ cwd, sessionFile? })` starts the launcher with an argv
array, RPC mode, update checks disabled and an explicit canonical workspace. Child-only
environment configuration is optional and never saved in profile metadata. The host
forces a separate `userData/little-coder/agent` directory, disables Plan Mode/subagent
mode and sets `ELECTRON_RUN_AS_NODE=1` for Electron's executable.

Only `get_state`, `get_commands` and `abort` are supported here. The transport correlates
responses, limits pending commands to 32, limits lines/buffers to 1 MiB and defaults to a
15-second command timeout. Malformed output, unexpected events, startup failures and
timeouts close the process; there is no automatic retry. Dialog requests receive
`cancelled: true`; interactive planning is never advertised. Stderr is drained without
retaining runtime output.

Pi owns transcript bytes. A separate atomic `runtime-profiles.json` owner records only
canonical session file, session ID, workspace and exact runtime versions. Resume requires
an existing matching binding, a bounded version-3 Pi session header, the same workspace
and the same identity reported by RPC. Unknown/corrupt metadata is preserved and rejected.
No automatic fallback opens these sessions as Standard Pi. Experimental transcripts are
not inserted into the ordinary desktop catalog.

The host reuses the existing Pi session lease protocol before resume, heartbeats leases
and releases them after process shutdown. POSIX shutdown signals the detached process
group, then kills remaining descendants after 250 ms. Windows uses `taskkill /T /F`;
that branch still needs native validation. Desktop quit now closes experimental runtimes
alongside the existing persistence and extension cleanup.

## Changed ownership seams

- `electron/runtime/`: installation discovery, bounded RPC transport and profile host.
- `electron/persistence/runtime-profile-store.ts`: runtime identity metadata only.
- `electron/application/app-store.ts`: optional profile-host composition and main-only API.
- `electron/main.ts`: experimental runtime cleanup during quit.
- `packages/pi-sdk-driver/src/index.ts`: exports existing lease helpers and upstream
  `getAgentDir` through the SDK's ESM boundary; no lease behavior change.
- State-owner guard: registers the new atomic metadata owner.
- Unit tests and a synthetic RPC executable: deterministic bootstrap and failure evidence.

## Validation

Evidence logs are local to `/tmp/wp002-evidence` and are not committed. Tests require no
GPU, provider credentials or paid API. The synthetic executable contains no upstream
prompts, skills or extensions.

- `pnpm test:baseline`: 384 Node tests and 356 desktop unit tests passed, including
  15 new runtime-profile tests.
- `pnpm lint`, `pnpm check:architecture`, `pnpm typecheck`: passed.
- Runtime-profile tests under Electron's executable in Node mode: 15 passed.
- `pnpm --filter @pi-gui/desktop run test:core:navigation`: desktop build and all
  three real Electron navigation tests passed on Xvfb.
- Formatting: changed files pass. The aggregate `pnpm check` remains blocked by
  pre-existing formatting in `MANIFEST.json` and `TEST-MATRIX.md`, recorded before editing.

The tests cover unchanged Standard Pi session creation, invalid installations, separate
process/workspace identities, restart/resume without transcript changes, lease exclusion
and handoff, changed identities, corrupt bindings, malformed/oversized/uncorrelated RPC,
EOF/timeout, denied dialogs, abort and POSIX descendant cleanup.

The first graphical run caught a direct Pi import that the desktop build converted to
CommonJS, causing startup to fail against Pi's ESM-only entry point. Routing that import
through the existing SDK package boundary fixed the failure; the graphical checks were
then rerun. Type checking also caught a missing lease-heartbeat timestamp, and the initial
resume test caught a property-order-dependent binding comparison. Both were corrected.

## Acceptance and remaining work

- [x] Standard Pi remains available and the default.
- [x] Explicit experimental profile selection exists at the main-process ownership seam.
- [x] Version-bounded discovery and process bootstrap are implemented.
- [x] Bootstrap/resume identity and session leases prevent implicit reassignment.
- [x] Cancellation, bounded failures and quit cleanup are covered.
- [x] No upstream behavior resources are vendored; protected root files are unchanged.
- [x] Credential-free tests and real Electron regression checks pass.
- [ ] Actual Little Coder launcher/resource execution is not validated by this checkpoint.
- [ ] Profile UI, ordinary conversation events and provider/model integration remain later work.

The deliberate deviation from broad profile selection is a main-only bootstrap API rather
than a UI selector that cannot yet execute conversations. Synthetic process tests establish
host behavior; they do not prove Little Coder behavior or resource loading. Windows tree
cleanup, upstream launcher execution and provider authentication remain unverified.

WP-003 should build event replay at the process adapter boundary, then define the event
mapping and fixture injection contract used by the conversation owners. WP-004 can expose
session selection and ordinary execution only after that mapping exists and must include
the required cloud-provider live validation. Plan Mode remains deferred because the
inspected upstream RPC path automatically approves plans.
