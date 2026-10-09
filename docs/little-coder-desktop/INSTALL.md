# Installation / Overlay Instructions

This package is designed to be copied into an **existing pi-gui fork**.

It deliberately does **not** contain or replace:

- root `README.md`
- root `AGENTS.md`
- root `CLAUDE.md`

Current pi-gui defines root `AGENTS.md` as the repository instruction source of truth and expects
root `CLAUDE.md` to remain a symlink to `AGENTS.md`. Preserve both exactly.

## Copy location

Extract/copy this package at the **root of the pi-gui repository**.

After copying, the only new project subtree should be:

```text
pi-gui/
└── docs/
    └── little-coder-desktop/
        ├── INSTALL.md
        ├── PROJECT-OVERVIEW.md
        ├── PROJECT-RULES.md
        ├── DESIGN.md
        ├── TECHNICAL-SPEC.md
        ├── DECISIONS.md
        ├── ROADMAP.md
        ├── TEST-MATRIX.md
        ├── CODEX-START.md
        └── work-packages/
            └── WP-001-bootstrap-and-integration-spike.md
```

No root file needs to be overwritten.

## Commit the handoff baseline

From the repository root:

```bash
git add docs/little-coder-desktop/
git commit -m "docs: add little-coder desktop project handoff"
```

Do not create or switch branches merely because this package suggests a workflow; pi-gui's root
`AGENTS.md` explicitly says to respect the current branch/worktree unless the user asks otherwise.

## Starting Codex

Give Codex the instruction contained in:

```text
docs/little-coder-desktop/CODEX-START.md
```

That instruction explicitly tells Codex to read the repository's existing root `AGENTS.md`
**first**, then the Little Coder project documents.

## Why the project rules are not another root AGENTS.md

pi-gui already has a mature repository-wide instruction file with important rules about:

- verification
- branch/worktree behavior
- renderer/main/preload boundaries
- source-of-truth ownership
- Pi SDK thin-adapter policy
- Electron verification

Replacing it would be incorrect and would make future upstream synchronization worse.

`PROJECT-RULES.md` therefore contains only additional Little Coder project constraints and is
explicitly subordinate to root `AGENTS.md`.
