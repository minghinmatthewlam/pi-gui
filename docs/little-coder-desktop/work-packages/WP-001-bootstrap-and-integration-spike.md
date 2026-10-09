# WP-001 — Bootstrap and Little Coder Integration Spike

## Status

Ready for implementation.

## Objective

Determine and prove the clean integration boundary for Little Coder inside the current pi-gui
architecture while preserving existing Standard Pi behavior.

This is an architectural spike with bounded implementation.

It is not permission to build the full Little Coder GUI.

## Instruction precedence

Before doing anything, read:

1. repository root `AGENTS.md`
2. `docs/little-coder-desktop/PROJECT-RULES.md`
3. `docs/little-coder-desktop/DESIGN.md`
4. `docs/little-coder-desktop/TECHNICAL-SPEC.md`
5. `docs/little-coder-desktop/DECISIONS.md`
6. `docs/little-coder-desktop/ROADMAP.md`
7. this work package

Also follow:

- `.agents/skills/verify-pi-gui/SKILL.md`
- `docs/architecture.md`
- `docs/ci-baseline.md`

Do not modify root `AGENTS.md` or root `CLAUDE.md` as part of this work package.

## Questions that must be answered

1. Can the existing `pi-sdk-driver` reproduce Little Coder's controlled resource/extension
   environment?
2. What exact setup does the current Little Coder launcher perform beyond resource selection?
3. Which Little Coder state already appears in ordinary Pi sessions/events?
4. Which state requires Little Coder-specific adaptation?
5. Can an installed Little Coder package/resources be discovered reliably?
6. Does native integration require private Pi APIs?
7. If so, can those assumptions be isolated like pi-gui's existing compatibility seams?
8. If native integration is not faithful, what is the minimal RPC/process adapter?
9. Where can deterministic runtime fixtures enter without violating existing owner boundaries?
10. What exact upstream commits/versions were inspected?

## Required work

### 1. Record the untouched baseline

Before project code changes, follow the existing repo baseline guidance.

At minimum record the result of:

```bash
corepack enable
pnpm install
pnpm check
```

Run the additional existing test/desktop verification required by the repository guidance for the
specific seam inspected or changed.

Record:

- Node version
- pnpm version
- pi-gui commit SHA
- relevant Pi package/runtime version
- Little Coder version/commit inspected
- pre-existing failures, if any

Do not fix unrelated upstream failures.

### 2. Inspect current integration points

Inspect actual source, including the current equivalents of:

```text
packages/pi-sdk-driver/
apps/desktop/electron/
docs/architecture.md
little-coder launcher
little-coder extensions/
little-coder skills/
little-coder model/provider configuration
```

Do not rely on filenames in this package if upstream has moved them.

### 3. Write findings

Create:

```text
docs/little-coder-desktop/WP-001-INTEGRATION-FINDINGS.md
```

Include:

- exact source revisions;
- source paths examined;
- launcher/resource-loading behavior;
- current session/event observations;
- Strategy A vs Strategy B recommendation;
- private/stable API dependencies;
- package discovery approach;
- risks;
- unresolved questions;
- recommended WP-002 scope.

### 4. Add only the smallest safe seam, if justified

If the investigation establishes a small, non-speculative runtime/profile seam, implement it.

Constraints:

- Standard Pi remains default/current behavior.
- Little Coder may remain experimental/disabled.
- no polished profile UI;
- no Plan Mode UI;
- no Little Coder resource vendoring;
- no second provider-settings system;
- no broad `DesktopAppStore` ownership expansion;
- no renderer access to Node/Pi runtime.

If even the seam would require speculative refactoring, do not force it. Document the exact
implementation recommended for WP-002 instead.

### 5. Add regression coverage

If code changes are made, prove that the touched Standard Pi path remains functionally intact.

Tests must require no:

- API key
- network provider
- local model
- GPU

Use the existing repository's preferred test/driver architecture.

### 6. Identify deterministic fixture seam

Document the recommended point for WP-003 to inject deterministic runtime events.

If a tiny non-product stub/interface is clearly useful and does not broaden scope, it may be
added. Do not build the replay system.

## Explicit non-goals

Do not implement:

- full Little Coder execution UX;
- Plan Mode GUI;
- plan/action model selectors;
- sub-coder panel;
- context/cache telemetry UI;
- provider setup wizard;
- local model download logic;
- remote inference UI;
- new diff/editor/terminal implementations;
- new transcript/session database;
- automatic Little Coder installation;
- changes to root repository agent instructions.

## Acceptance criteria

- [ ] Root `AGENTS.md` was followed and left intact.
- [ ] Root `CLAUDE.md` symlink/behavior was left intact.
- [ ] Existing repository baseline was run and recorded before changes.
- [ ] Exact source revisions were documented.
- [ ] Current Little Coder launcher/resource behavior was established from source.
- [ ] Strategy A or B was selected with technical justification.
- [ ] Relevant pi-gui/Pi source paths were documented.
- [ ] Little Coder-specific state/event gaps were listed.
- [ ] Little Coder package/resource discovery approach was proposed.
- [ ] Runtime/profile integration seam was identified.
- [ ] Any implementation preserves Standard Pi default behavior.
- [ ] Added tests require no live model/provider/GPU.
- [ ] Existing repository verification for affected code passes, excluding documented pre-existing
      failures.
- [ ] No Little Coder prompts/skills/extensions were vendored.
- [ ] No later-roadmap feature was implemented opportunistically.

## Completion report

Report:

1. selected integration strategy;
2. rejected strategy and reason;
3. files changed;
4. verification run and results;
5. acceptance criteria status;
6. architectural deviations;
7. unresolved risks;
8. exact recommended scope for WP-002.

Then stop.
