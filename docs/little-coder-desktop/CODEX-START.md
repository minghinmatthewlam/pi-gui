# First Codex Instruction

Implement **WP-001 only**.

Before making any change, read these in order:

1. repository root `AGENTS.md`
2. `docs/little-coder-desktop/PROJECT-RULES.md`
3. `docs/little-coder-desktop/DESIGN.md`
4. `docs/little-coder-desktop/TECHNICAL-SPEC.md`
5. `docs/little-coder-desktop/DECISIONS.md`
6. `docs/little-coder-desktop/ROADMAP.md`
7. `docs/little-coder-desktop/work-packages/WP-001-bootstrap-and-integration-spike.md`

Also follow the repository's existing guidance referenced by root `AGENTS.md`, especially:

- `.agents/skills/verify-pi-gui/SKILL.md`
- `docs/architecture.md`
- `docs/ci-baseline.md`

Important constraints:

- Do not modify root `AGENTS.md`.
- Do not replace or convert root `CLAUDE.md`; preserve its existing relationship to `AGENTS.md`.
- Do not overwrite root `README.md`.
- Respect the current branch/worktree; do not create or switch branches unless explicitly asked.
- Do not implement later work packages.
- Do not vendor Little Coder prompts, skills, extensions, or other behavior.
- Preserve current Standard Pi behavior.
- Do not require a GPU, live local model, or paid API for tests.
- Inspect the actual current pi-gui, Pi, and Little Coder code rather than assuming this project
  packet's upstream notes are exact.
- Prefer the smallest maintainable integration seam.
- If native Pi SDK/resource integration cannot faithfully reproduce Little Coder, recommend the
  RPC/process adapter rather than forcing the native approach.

Before changing code, run and record the baseline required by WP-001 and the existing repository
guidance.

When complete, provide:

- chosen integration strategy and rationale;
- files changed;
- checks/tests run and results;
- acceptance-criteria checklist;
- deviations from the specification;
- unresolved risks;
- exact recommendation for WP-002.

Stop after WP-001.
