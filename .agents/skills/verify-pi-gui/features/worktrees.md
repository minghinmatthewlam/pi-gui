# Worktrees

Users create a separate Git workspace or choose a worktree environment for a new thread.

## Sub-features

- `worktree-permanent`: create and select a permanent worktree from workspace actions.
- `worktree-environment`: expose Local and Worktree choices for a new thread.
- `worktree-profile`: scope worktree operations to the current profile.

## How to get to it (user POV)

- Open Workspace actions for the repository and choose Create permanent worktree. Under Time grouping the folder row is hidden once it has threads; switch Customize Sidebar → Grouping → Workspace first. The new worktree gets no sidebar row of its own; its threads show under the root folder with a worktree icon.
- Only worktrees pi-gui created (under the profile's `worktrees` folder or the legacy `~/.pi/worktrees`) nest under a folder. A Git worktree the user made and opened is its own sidebar folder with its own threads, and worktrees created from it nest under it.
- Remove worktree (with a confirmation) is in that menu only when a pi-gui worktree shows as its own row, which happens only when its root folder is not open. The app refuses to remove any other checkout.
- The Fork modal offers Same worktree or New worktree; New worktree can be disabled.
- The old Worktrees side panel has been removed; it is not an entry point.
- Click New thread in the sidebar and choose Local or Worktree.

## Driving it with Playwright

Preconditions: isolated profile and disposable Git repository with an initial commit; working Git executable. Never use the user's checkout as the worktree fixture.

- **Visible maintenance:** `.agents/skills/verify-pi-gui/scripts/prove.sh --maintenance` uses a disposable Git repository (never the user's checkout). Time grouping hides the folder row once that folder has threads, so the recipe opens Customize Sidebar, chooses Grouping → Workspace, then clicks `Workspace actions for ${name}` and `Create permanent worktree`. It requires the selected workspace path in `git worktree list --porcelain`, opens New thread, and requires exact Local and Worktree buttons.
- **Core regression:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/worktrees.spec.ts`.
- **Create:** click the button named `Workspace actions for ${rootWorkspace.name}`, then `Create permanent worktree`. Assert the selected workspace represents the created worktree and inspect its actual Git worktree record on disk.
- **Environment:** click the sidebar's top New thread button (`.sidebar__new`); a thread still waiting for its title is also named New thread. Require `new-thread-composer` plus exact Local and Worktree buttons.
- **Proof:** capture menu action, selected workspace, filesystem/Git result, and environment choices. Run the profile-isolation case when changing discovery or ownership.

## Gotchas

- The fixture needs working Git; a toolchain/license error is an environment blocker.
- Seeing Worktree in a menu does not prove a completed worktree-backed agent run.
- Preserve fixture artifacts under the repository's deletion policy; close only the owned app instances.
