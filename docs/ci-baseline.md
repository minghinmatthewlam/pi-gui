# CI baseline and adoption plan

The current design is renderer → narrow preload API → main-process app store →
Pi SDK driver → Pi runtime. Desktop UI state and Pi session state have separate
persistence owners. The first CI pass strengthens verification of this design;
it does not change those boundaries.

## Shared baseline

Run `pnpm check` locally and in the existing CI typecheck job. It runs:

1. `pnpm format:check`: pinned Prettier checks source, tests, scripts, styles,
   configuration, and Markdown. `pnpm format` fixes formatting locally. Generated
   output, lockfiles, dependencies, and local artifacts are excluded. The
   100-column print width is a wrapping target, not a hard length limit.
2. `pnpm lint`: builds shared package declarations first so a clean checkout
   has the same type information as a developer checkout, then runs ESLint correctness checks on app, package, video, test and helper
   source. It rejects debugger statements, async Promise executors, duplicate
   cases/keys, unreachable code and other configured errors. It does not format
   files or ban explicit `any`. Type-aware rules also reject unhandled/misused
   promises and unsafe assignment, argument, call, member access, and return
   operations on `any`. A bare `void` does not silence the promise rule.
3. `pnpm check:architecture`: checks renderer runtime imports and reachable local
   helpers. It rejects Node, Electron, Pi runtime, and main/preload implementation
   dependencies. Explicit type-only imports and pure shared helpers remain valid.
4. `pnpm typecheck`: builds shared declarations, then checks all six workspaces,
   including the website and video source. First, `check:workspaces` asks pnpm for
   its workspace list and rejects missing or empty typecheck scripts, so a new
   workspace cannot silently skip checking. This checks script presence, not
   whether a deliberately misleading script performs a real typecheck. Existing strict TypeScript settings
   remain in place.
5. `pnpm test:baseline`: guard tests, driver unit tests, release-helper tests,
   and desktop unit tests (including failed-action state preservation).

Guard tests exercise the actual lint configuration with invalid and valid input.
They also run Playwright discovery with CI enabled and prove a focused `.only`
test fails while an ordinary test is discovered. Discovery launches no browser.

The existing macOS Electron core, website build, Linux installation/package and
Windows package jobs remain separate. `pnpm check` alone does not prove these
surfaces. Real-provider and native desktop verification retain their own lanes.
The final `CI required` job accepts only success from all five existing jobs.
See [merge enforcement](merge-enforcement.md) for its contract and remote
activation status. Repository branch rules must require this result before it
blocks merges; local tests alone do not establish remote enforcement.

## Next decisions, in order

1. Strengthen IPC contracts: main and preload currently rely on annotations and
   casts. Keep one authoritative contract and validate meaningful external data
   boundaries. Avoid introducing a generic framework without a concrete need.
2. Replace feature-absence skips in mandatory product tests with failures once
   the feature is confirmed as required. In particular, the schema-skew test can
   currently skip when its projection is absent. Platform capability skips and
   credential-dependent integration lanes are separate decisions.

For every new rule, show a representative violation fail, restore a valid case,
and run the affected product lane. Retain clear evidence of passed, failed and
blocked coverage; a settings smoke does not establish a working conversation.

## Renderer architecture guard

`scripts/check-renderer-boundary.mjs` parses TypeScript syntax and uses the
renderer tsconfig to resolve imports. It follows local runtime imports and
re-exports through workspace aliases and `.js` specifiers pointing at TypeScript
source. Cycles are visited once. It checks resolved npm package identities too.

For example, renderer → shared barrel → helper → `node:fs` fails at the helper.
The repair is to request the operation through the preload API. A type-only
import from that same module is allowed because it loads no runtime code.

Literal dynamic imports and `require` calls are checked; computed module loading
fails because its destination cannot be established. Vite `import.meta.glob`
also fails; use literal imports so every dependency can be checked. Unresolved runtime imports
and runtime imports backed only by local declaration files also fail. Tests
prove representative forbidden imports fail and valid browser code passes.

Scope: this checks first-party static module dependencies. It does not audit
third-party package internals, arbitrary runtime code evaluation, IPC payload
validation, or hostile changes to the guard itself. Review and repository rules
still need to protect the checks.
