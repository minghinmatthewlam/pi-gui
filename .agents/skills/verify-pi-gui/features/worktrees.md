# Worktrees

Users create a separate Git workspace or choose a worktree environment for a new thread.

## Sub-features

- `worktree-permanent`: create and select a permanent worktree from workspace actions.
- `worktree-environment`: expose Local and Worktree choices for a new thread.
- `worktree-profile`: scope worktree operations to the current profile.

## How to get to it (user POV)

- Open Workspace actions for the repository and choose Create permanent worktree.
- Click New thread in the sidebar and choose Local or Worktree.

## Driving it with Playwright

Preconditions: isolated profile and disposable Git repository with an initial commit; working Git executable. Never use the user's checkout as the worktree fixture.

- **Run:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/worktrees.spec.ts --grep "creates and selects"`. The full spec has separate profile cases that delete their own fixture directories; do not run those under the preservation policy without cleanup authorization.
- **Create:** click the button named `Workspace actions for ${rootWorkspace.name}`, then `Create permanent worktree`. Assert the selected workspace represents the created worktree and inspect its actual Git worktree record on disk.
- **Environment:** click New thread within the complementary sidebar. Require `new-thread-composer` plus exact Local and Worktree buttons.
- **Proof:** capture menu action, selected workspace, filesystem/Git result, and environment choices. Run the profile-isolation case when changing discovery or ownership.

## Gotchas

- The fixture needs working Git; a toolchain/license error is an environment blocker.
- Seeing Worktree in a menu does not prove a completed worktree-backed agent run.
- Preserve fixture artifacts under the repository's deletion policy; close only the owned app instances.

## Maintenance coverage

Normal-mode `scripts/prove.sh --maintenance` creates a permanent worktree in a scratch Git repository, verifies its actual `git worktree list --porcelain` entry and exposes Local/Worktree choices. It preserves the fixture. This does not prove a worktree-backed provider run, environment-button selection, or cross-profile isolation.
