# WP-001 — Integration findings

Evaluated on 2026-10-09. Scope: WP-001 only.

## Decision

Select **Strategy B: a supervised Little Coder launcher/RPC process per open session** for
WP-002. Keep Standard Pi on its current SDK path and as the default.

Strategy A can select resources through public Pi APIs, but resource selection is insufficient
to reproduce this Little Coder revision faithfully inside Electron main. Little Coder uses
process-wide state and working-directory assumptions, applies Pi source patches, and targets
a different Pi version. Do not copy its behavior or patch the desktop's shared Pi installation.

This is an integration recommendation, not a claim that an operational Little Coder desktop
adapter exists. RPC itself has fidelity gaps, especially interactive planning. They must be
resolved before claiming the later Plan Mode workflow works.

No production seam was added. The existing composition is coupled to more than a
`SessionDriver`; changing it now would preempt the bounded adapter work and require speculative
choices about settings, model discovery, persistence, and session transitions. WP-001 explicitly
permits a findings-only outcome in this case.

## Exact evaluated sources

| Source                   | Revision/version                                          | Inspection                                                                         |
| ------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| This pi-gui fork         | `ed1fe4b4d01585dcb07a54ebebde361e09a6a259`, branch `work` | Existing checkout; clean before investigation                                      |
| Desktop Pi               | `@earendil-works/pi-coding-agent@1.0.0`                   | Installed npm artifact, public declarations and emitted JS                         |
| Desktop Pi publication   | npm `gitHead: a13d35a742c6ef8462812a28fbe1d8c8b7431c32`   | Registry metadata; not a separately checked-out source commit                      |
| Little Coder             | `1.20.0`, Git `89d4fa0af864230527ab75d12604ed0eb320e6df`  | Shallow upstream checkout under `/tmp/wp001-little-coder-source`                   |
| Little Coder's locked Pi | `@earendil-works/pi-coding-agent@0.83.0`                  | Its lockfile plus separately fetched npm artifact under `/tmp/wp001-pi083/package` |
| Pi 0.83 publication      | npm `gitHead: 845d6ff1f6643aba440341cce877ce1c43ebbc39`   | Registry metadata; not a separately checked-out source commit                      |
| Development tools        | Node `24.19.0`, pnpm `10.25.0`                            | Actual command output                                                              |

Little Coder declares `^0.83.0`; its committed lock resolves 0.83.0. The desktop lock resolves
1.0.0. These are not interchangeable assumptions. npm metadata is provenance, not evidence
that both versions have compatible behavior.

Verified licenses: this fork and Pi declare MIT; Little Coder declares Apache-2.0 and includes
`LICENSE` and `NOTICE` with ClawSpring attribution. Nothing was vendored or redistributed.
Revisit NOTICE/attribution and dependency licensing before packaging any external runtime.

## Untouched baseline and verification

All baseline commands below completed before adding this document. Root `AGENTS.md`,
`CLAUDE.md -> AGENTS.md`, `README.md`, application files, manifests, and lockfiles were
unchanged. The current branch was retained.

Commands run from the repository root with the prepared cloud environment:

```bash
export PATH=/workspace/.cloud-tools/node_modules/.bin:$PATH
export npm_config_cache=/workspace/.npm-cache XDG_CACHE_HOME=/workspace/.cache
export PI_CODING_AGENT_DIR=/workspace/.pi-agent
export ELECTRON_CACHE=/workspace/.electron-cache ELECTRON_GET_USE_PROXY=1
corepack enable --install-directory /workspace/.cloud-tools/node_modules/.bin
pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store
pnpm check
pnpm lint
pnpm check:architecture
pnpm typecheck
pnpm test:baseline
DISPLAY=:99 PI_APP_TEST_WORKERS=1 pnpm --filter @pi-gui/desktop run test:core:navigation
```

Corepack activation succeeded in the writable tools directory. Its shim was subsequently
replaced there with the installed pnpm 10.25.0 entry, retaining the pin without requiring a
Corepack download. The installation used the authoritative frozen lockfile. Pi's data-directory
override avoids this cloud machine's unavailable home directory; it is setup, not product code.
Electron ran under the prepared local Xvfb display.

| Check                          | Result                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Corepack activation            | Passed                                                                              |
| Frozen dependency installation | Passed; existing policy ignores the Google GenAI build script                       |
| `pnpm check`                   | Failed at formatting, before subsequent checks                                      |
| Formatting failures            | Pre-existing `MANIFEST.json` and `TEST-MATRIX.md` in this documentation directory   |
| `pnpm lint`                    | Passed separately                                                                   |
| `pnpm check:architecture`      | Passed separately                                                                   |
| `pnpm typecheck`               | Passed, including extension examples                                                |
| `pnpm test:baseline`           | Passed: 384 Node tests and 341 desktop unit tests                                   |
| Electron navigation            | 3 passed: workspace/session/draft restart, sidebar navigation, transcript switching |

The Electron evidence is credential-free and fixture-backed. It does not establish a live
provider conversation, native macOS behavior, release packaging, or Little Coder execution.
No product UI or runtime code changed, so a paid/live conversation was not required for this
documentation spike.

Current-instance logs are retained under `/tmp/wp001-evidence/`: `corepack.log`,
`install.log`, `check.log`, `lint.log`, `architecture.log`, `typecheck.log`,
`baseline-tests.log`, and `electron-navigation.log`. They are local diagnostic evidence,
not portable CI artifacts or committed transcripts.

## Source paths examined

In this fork:

- `docs/architecture.md`, `docs/ci-baseline.md`, and the desktop verification skill/map.
- `packages/pi-sdk-driver/src/pi-sdk-driver.ts`, `session-supervisor.ts`,
  `npm-package-fallback.ts`, and `runtime-supervisor.ts`.
- `packages/session-driver/src/types.ts`, `runtime-types.ts`, `transcript.ts`, and `usage.ts`.
- `apps/desktop/electron/application/app-store.ts` and the documented window/IPC/owner boundaries.
- Installed Pi `dist/core/{sdk,resource-loader,settings-manager,session-manager}` declarations
  and resource-loader implementation; Pi 0.83 `dist/modes/rpc/{rpc-mode.js,rpc-types.d.ts}`.

In Little Coder:

- `package.json`, `package-lock.json`, `LICENSE`, and `NOTICE`.
- `bin/little-coder.mjs`, `default-model.mjs`, `extras.mjs`, `user-extensions.mjs`,
  and their tests; `scripts/patch-pi.mjs`, its tests, and `build-pi-package.mjs`.
- `.pi/settings.json`, `models.json`, the extension/skill directory inventory.
- Extensions `phase-model`, `plan-mode`, `permission-gate`, `subagent`, `bg-shell`,
  `project-context`, `skill-inject`, `benchmark-profiles`, `branding`, and
  `context-watchdog`; shared `skills-root.ts`.
- `benchmarks/rpc_client.py` for an existing RPC client example.

Observations below are source-backed unless an executed probe is explicitly identified.

## Launcher and resource behavior

The actual launcher:

1. Requires Node >=22.19; resolves its package relative to its own file.
2. Locates Pi via the package's nested dependency or flat sibling layout, then uses
   `package.json.bin.pi`; it does not assume an old `dist/cli.js` path.
3. Applies upstream-owned, best-effort in-place patches to that Pi installation on every launch.
   These include abort-marker suppression and raw-control-character repair for JSON-string
   edit arguments. The latter changes tool recovery behavior, despite the launcher's older
   comment describing patches as cosmetic.
4. Discovers sorted bundled extension directories containing `index.ts`, followed by
   `LITTLE_CODER_EXTRA_EXTENSIONS` and the user extension directory. Inventory/provenance is
   placed in `LITTLE_CODER_EXTENSION_MANIFEST`.
5. Disables ordinary Pi extension discovery by default. `--with-pi-extensions` or
   `LITTLE_CODER_PI_EXTENSIONS=1` explicitly restores it.
6. Passes `--no-context-files` and its own `AGENTS.md` as the system prompt. This does not
   discard project instructions entirely: the `project-context` extension reads bounded
   project context from `process.cwd()` and injects a deduplicated hidden tail message.
7. Handles plan-mode startup, update checking/re-execution, interactive thinking defaults,
   and first-launch model selection. Headless runs do not inherit the interactive default
   model/thinking behavior automatically.
8. Suppresses Pi version notices and best-effort merges quiet-startup/changelog settings,
   including a historical keybinding migration in the selected Pi agent directory.
9. Spawns Node with the resolved Pi entry, cwd, arguments, and environment; forwards signals.
   Sub-coders re-enter this same launcher with a restricted environment and JSON mode.

Important differences from a naive resource profile:

- `skills/tools`, `skills/knowledge`, and `skills/protocols` are upstream-owned card packs,
  resolved relative to extensions and injected by Little Coder. Merely adding them to ordinary
  Pi skill discovery is not equivalent.
- The launcher does not merge the entire shipped `.pi/settings.json` into global Pi settings.
  For example, benchmark profiles read the package-local settings themselves.
- Provider configuration merges shipped/user model definitions and supports arbitrary base URLs
  and environment overrides. It is not a localhost-only path.
- The separate generated Pi resource package intentionally excludes extensions including
  project-context and branding. It is not equivalent to the full Little Coder launcher.

## Strategy A assessment and executed probes

Pi 1.0 exposes public `DefaultResourceLoader` options `additionalExtensionPaths`,
`noExtensions`, `noContextFiles`, `systemPrompt`, and inline extension factories.
`npm-package-fallback.ts` already preserves loader options across runtime recreation.

A synthetic public-loader probe passed: an explicitly supplied extension loaded while an
ambient project extension and project AGENTS context were excluded; the prompt file was read.
The initial probe used the wrong return shape for `getAgentsFiles()`; checking its actual
`agentsFiles` property passed. No Little Coder behavior was copied in this probe.
Log: `resource-loader-probe-fixed.log`; retained fixture: `/tmp/wp001-loader-1YaUZD`.

Nevertheless, faithful shared-process integration is rejected for this revision:

- `phase-model/index.ts` stores tags/handover on `globalThis.__littleCoderPhaseModel`.
  Its own two-import test explicitly requires shared state. Two desktop sessions in one
  process would share it; an additional resource loader cannot isolate it.
- Other extension modules also retain mutable module state. `project-context` uses
  `process.cwd()` rather than exclusively the session cwd. Environment knobs and child
  inheritance are process-wide. Mutating Electron's cwd/environment per session is unsafe.
- Running the launcher patcher against the desktop Pi would alter Standard Pi; omitting it
  would omit upstream small-model edit recovery.
- Loading 0.83-oriented resources into Pi 1.0 has not established API or tool parity.
- Desktop-injected add-ons and orchestration tools could change the intentionally controlled
  Little Coder scaffold if simply combined with its extensions.

112 upstream pure tests passed using Vitest 2.1.9 in a temporary tools prefix: default-model
(15), extra extensions (9), user extensions (12), provider config (74), and shared phase state
(2). This verifies selected upstream assumptions without installing Little Coder as a desktop
dependency or contacting inference.

Exploratory checks are kept distinct: a Node test-runner attempt could not resolve Vitest.
A subsequent wider Vitest run had 117 passes and 5 failures, all in patch tests requiring an
installed Little Coder Pi dependency. That dependency was deliberately not installed; those
runtime patch checks remain unverified, not repository defects. The final pure-suite result
is in `little-coder-pure-tests.log`; earlier outputs were retained.

## State and event observations

| Concern                                         | Existing evidence/carrier                                                        | Integration gap                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Assistant/tool activity, failures, cancellation | Ordinary Pi agent events and JSONL; desktop driver projections                   | Translate Pi 0.83 wire events explicitly; do not assume Pi 1.0 types                           |
| Plan/action model                               | Little Coder process-global tags; actual model switch through Pi                 | Model events carry selection, not complete durable phase/tag semantics                         |
| Approved plan and implementation                | `.pi/approved-plan.md`; `/implement` seeds a fresh session with a hidden message | Reconcile new session identity/file and ownership; never synthesize a duplicate transcript     |
| Permission requests                             | `ctx.ui.confirm`, edit-confirm helper, tool blocking                             | Correlate RPC UI requests; cancellation/disconnect must deny, never imply approval             |
| Sub-coders                                      | `dispatch` tool details and upstream tracker/child processes                     | Child lifecycle is not automatically desktop orchestration state                               |
| Background jobs                                 | String-array widget plus visible `lc-bg-shell` custom message                    | Widget is transient; later structured lifecycle projection needs an upstream-owned carrier     |
| Context/compaction                              | Pi usage/compaction events and Little Coder watchdog                             | Warning/re-arm semantics are not a separate desktop state contract today                       |
| Cache telemetry/branding                        | TUI rendering and provider usage                                                 | RPC does not serialize component/footer factories; preserve absence rather than invent metrics |
| Skill/project-context injection                 | Hidden tail messages and upstream relative resources                             | Do not render hidden context as visible assistant output or duplicate injection                |

The desktop already binds extension UI with mode `rpc`, supports dialogs, notifications and
string widgets, and handles runtime rebinds/newSession. This is useful precedent, not proof
that all Little Coder extension semantics are supported.

**Critical RPC constraint:** Little Coder `plan-mode` treats `print`, `json`, and `rpc`
as batch runs. Its tests assert this, and the approval handler automatically chooses approval
in batch mode. Merely providing a GUI dialog bridge does not restore interactive questions or
human plan approval. No desktop adapter should claim otherwise or silently convert this into
an interactive planning workflow. WP-005 requires an upstream-supported host-interactive
capability or another explicitly reviewed upstream solution.

## Discovery and API boundaries

For WP-002, use an explicit, configured installation root or launcher path, not `npm root -g`
as a mandatory discovery mechanism. Canonicalize the path; validate package identity/version,
launcher file, required resources, and the Pi dependency/CLI layout. Resolve dependencies in
the selected package's context. Optional PATH discovery must handle symlinks and platform
wrappers, and require the same validation. Absence means an unavailable experimental profile;
Standard Pi must still work. Do not automatically install Little Coder.

The launcher and relative resources are versioned implementation conventions, not an exported
stable embedding SDK. Pin/test supported Little Coder versions and retain the full package
layout so skill lookup and sub-coder launcher resolution work.

Native resource selection itself needs no private Pi API. Faithful native isolation would need
changes beyond that public seam; existing compatibility shims cannot make process globals
session-local. Little Coder's own patcher depends on exact emitted private source text.
Keep it within the external runtime installation and flag unsupported shapes before claiming
compatibility; never run it against the desktop dependency.

Pi 0.83 RPC provides correlated JSONL responses, agent events, `get_state` with session file/id,
`get_messages`, `get_commands`, model/thinking controls, abort, and session transitions.
UI requests expose select/confirm/input and text widgets; component factories/footer UI are
unsupported. The Python benchmark client invokes Pi directly with explicit extensions and
`--no-session`; it is not proof of full launcher or desktop persistence parity.

## Minimal proposed seam and exact WP-002 recommendation

Implement an experimental, disabled-by-default profile dispatcher at the main-process driver
composition boundary. Reuse portable session contracts and bounded desktop owners.

1. Inventory the actual main-owner capabilities required from `PiSdkDriver`, including
   runtime/settings supervision, catalogs, model discovery, titles, and schema inspection.
   `SessionDriver` alone does not cover them. Introduce only the necessary grouped interfaces;
   retain the unchanged Standard Pi construction and regression tests.
2. Add validated external-package discovery and a capability/version diagnostic. Do not install,
   upgrade, copy, or load external Little Coder resources into Electron main.
3. Create one supervised launcher process per open Little Coder session with an isolated cwd
   and child environment, `--no-update-check --mode rpc`, and explicit resume/session handling.
   Do not use the benchmark client's `--no-session` for persistent desktop tasks.
4. Correlate commands and UI responses, validate untrusted JSON, bound buffers, and map only
   proven events. Handle startup errors, EOF, malformed output, abort and owned-process cleanup.
   Account for sub-coder descendants; killing only the launcher is insufficient supervision.
5. Keep Pi JSONL authoritative and use existing catalog/session references. Profile routing must
   survive reopen/fork; fail closed on unknown runtime/version, never reopen a Little Coder file
   silently using Standard Pi. Validate file/schema ownership before cross-version reads.
6. Reuse current provider ownership only where equivalence is demonstrated. Little Coder's
   upstream provider extension owns its overrides; do not create another provider-settings
   database or mirror secrets. Isolating the agent directory prevents launcher settings changes
   from affecting Standard Pi, but needs an explicit supported authentication/configuration
   binding rather than blindly copying user files.
7. Prove startup, create/resume, command discovery, cancellation, UI-request denial, and two
   sessions with distinct phase/environment/cwd state using a deterministic process fixture.
   Keep unsupported capabilities unavailable. No polished picker, plan UI, telemetry, or replay
   system belongs in WP-002.

Full process integration is not a one-option change to
`createAgentSessionRuntimeImpl`: that hook returns an in-process `AgentSessionRuntime`, not
a transport-neutral runtime. Do not disguise a subprocess as that object with unsafe casts.

## WP-003 deterministic fixture seam

Put the synthetic transport behind the proposed process adapter, before mapping into
`SessionDriverEvent` and the existing owner subscriptions. Feed ordered RPC responses/events,
UI requests, EOF and protocol failures there. Reuse the normal desktop IPC and renderer path.
The existing `createAgentSessionRuntimeImpl` injection remains appropriate for Standard Pi
driver regressions, but cannot prove external process semantics by itself.

Fixtures should test session isolation, ordering, cancellation, denial on disconnect, file/id
rebinding, and hidden-versus-visible messages. Later Plan Mode fixtures must reflect a validated
interactive upstream protocol; invented event names cannot establish Little Coder parity.
No replay infrastructure was implemented in WP-001.

## Remaining risks, deviations, and acceptance

- A real launcher/RPC conversation, runtime patches, descendant shutdown, and session persistence
  were not executed. No model, GPU, credentials, or automatic Little Coder installation was used.
- Interactive RPC planning is a confirmed source-level mismatch with the desired product flow.
- Custom TUI presentation and structured lifecycle telemetry are incomplete on RPC.
- Cross-version session interpretation and settings/provider ownership require explicit tests.
- Upstream changes may invalidate package layout, patch matches, or protocol assumptions.

There is no architectural deviation: the WP permits documenting the seam instead of speculative
production refactoring. Strategy B is selected because Strategy A lacks faithful isolation;
Strategy C remains rejected. Acceptance checklist:

- [x] Root AGENTS instructions followed and file left intact.
- [x] Root CLAUDE symlink left intact.
- [x] Untouched baseline run and recorded before changes.
- [x] Exact evaluated source revisions documented.
- [x] Launcher/resource behavior established from current source.
- [x] Strategy B selected with technical justification.
- [x] Relevant pi-gui/Pi paths documented.
- [x] Little Coder state/event gaps listed.
- [x] Package/resource discovery proposed.
- [x] Runtime/profile integration seam identified.
- [x] Standard Pi default preserved; no production implementation changed.
- [x] Executed probes require no live provider/model/GPU; added product tests are not applicable.
- [x] Relevant baseline and Electron verification passed except documented pre-existing formatting.
- [x] No Little Coder behavior/resources vendored.
- [x] No later-roadmap feature implemented.

Stop after WP-001. WP-002 should implement only the bounded experimental process plumbing above,
and retain interactive planning as an explicit unresolved capability rather than claiming it works.
