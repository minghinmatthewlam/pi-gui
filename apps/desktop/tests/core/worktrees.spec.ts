import { execFile } from "node:child_process";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  addWorkspaceViaIpc,
  assertExists,
  chooseThreadGrouping,
  createNamedThread,
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

async function addLinkedWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  await git(repoPath, "worktree", "add", "-b", branchName, worktreePath, "HEAD");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

test("creates and selects a worktree-backed workspace from the desktop UI", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("worktree-live-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const rootWorkspace = await waitForWorkspaceByPath(window, workspacePath);

    await window
      .getByRole("button", { name: `Workspace actions for ${rootWorkspace.name}` })
      .click();
    await window.getByRole("button", { name: "Create permanent worktree" }).click();

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const selected = state.workspaces.find(
          (workspace) => workspace.id === state.selectedWorkspaceId,
        );
        return (
          selected?.kind === "worktree" &&
          (state.worktreesByWorkspace[rootWorkspace.id]?.length ?? 0) > 0
        );
      })
      .toBe(true);

    const stateAfterCreate = await getDesktopState(window);
    const worktreeWorkspace = stateAfterCreate.workspaces.find(
      (workspace) => workspace.id === stateAfterCreate.selectedWorkspaceId,
    );
    assertExists(
      worktreeWorkspace,
      "Expected the selected workspace to be the newly created worktree",
    );
    if (worktreeWorkspace.kind !== "worktree") {
      throw new Error("Expected the selected workspace to be the newly created worktree");
    }

    await expect(window.locator(".topbar__session")).toContainText(worktreeWorkspace.name);
    await expect(window.locator(".empty-panel")).toContainText("Create a thread for this folder");
    await expect(window.locator(".empty-panel")).not.toContainText("/Users/");

    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    await expect(window.getByRole("button", { name: "Local", exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "Worktree", exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("scopes worktree creation and startup collection to the active profile", async () => {
  test.setTimeout(180_000);
  const profileA = await makeUserDataDir("pi-gui-profile-a-");
  const profileB = await makeUserDataDir("pi-gui-profile-b-");
  const fakeHome = await makeUserDataDir("pi-gui-fake-home-");
  const workspacePath = await makeGitWorkspace("worktree-profile-isolation");
  const profileARoot = join(profileA, "worktrees");
  const profileBOrphan = join(profileB, "worktrees", "repo", "profile-b-orphan");
  const legacyWorktree = join(fakeHome, ".pi", "worktrees", "repo", "legacy");
  let profileAWorktree: string | undefined;

  try {
    await addLinkedWorktree(workspacePath, legacyWorktree, "pi/legacy");
    const canonicalLegacyWorktree = await realpath(legacyWorktree);
    const profileAHarness = await launchDesktop(profileA, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
      envOverrides: { HOME: fakeHome },
    });
    try {
      const window = await profileAHarness.firstWindow();
      const rootWorkspace = await waitForWorkspaceByPath(window, workspacePath);
      await addWorkspaceViaIpc(window, legacyWorktree);
      const legacyWorkspace = await waitForWorkspaceByPath(window, canonicalLegacyWorktree);
      expect(legacyWorkspace.kind).toBe("worktree");

      await window
        .getByRole("button", { name: `Workspace actions for ${rootWorkspace.name}` })
        .click();
      await window.getByRole("button", { name: "Create permanent worktree" }).click();

      await expect
        .poll(async () => {
          const state = await getDesktopState(window);
          const selected = state.workspaces.find(
            (workspace) => workspace.id === state.selectedWorkspaceId,
          );
          return selected?.kind === "worktree" && selected.path !== canonicalLegacyWorktree;
        })
        .toBe(true);

      const state = await getDesktopState(window);
      profileAWorktree = state.workspaces.find(
        (workspace) => workspace.id === state.selectedWorkspaceId,
      )?.path;
      assertExists(profileAWorktree, "Expected profile A to create a worktree");
      expect(isPathWithin(await realpath(profileARoot), profileAWorktree)).toBe(true);
      expect(await pathExists(profileAWorktree)).toBe(true);
    } finally {
      await profileAHarness.close();
    }

    assertExists(profileAWorktree, "Expected profile A worktree path");
    await addLinkedWorktree(workspacePath, profileBOrphan, "pi/profile-b-orphan");

    const profileBHarness = await launchDesktop(profileB, {
      initialWorkspaces: [],
      testMode: "background",
      envOverrides: { HOME: fakeHome },
    });
    try {
      await profileBHarness.firstWindow();
      await expect.poll(() => pathExists(profileBOrphan)).toBe(false);
      expect(await pathExists(profileAWorktree)).toBe(true);
      expect(await pathExists(legacyWorktree)).toBe(true);
    } finally {
      await profileBHarness.close();
    }

    const profileACompatibilityHarness = await launchDesktop(profileA, {
      initialWorkspaces: [],
      testMode: "background",
      envOverrides: { HOME: fakeHome },
    });
    try {
      const window = await profileACompatibilityHarness.firstWindow();
      const rememberedProfileAWorktree = await waitForWorkspaceByPath(window, profileAWorktree);
      const legacyWorkspace = await waitForWorkspaceByPath(window, canonicalLegacyWorktree);
      expect(rememberedProfileAWorktree.kind).toBe("worktree");
      expect(await pathExists(rememberedProfileAWorktree.path)).toBe(true);
      expect(legacyWorkspace.kind).toBe("worktree");
      await window.evaluate(async (workspaceId) => {
        await globalThis.window.piApp.selectWorkspace(workspaceId);
      }, legacyWorkspace.id);
      const state = await getDesktopState(window);
      expect(state.selectedWorkspaceId).toBe(legacyWorkspace.id);
      expect(await pathExists(canonicalLegacyWorktree)).toBe(true);
    } finally {
      await profileACompatibilityHarness.close();
    }

    await rm(join(profileA, "catalogs.json"), { force: true });
    const profileAReconcileHarness = await launchDesktop(profileA, {
      initialWorkspaces: [],
      testMode: "background",
      envOverrides: { HOME: fakeHome },
    });
    try {
      await profileAReconcileHarness.firstWindow();
      await expect.poll(() => pathExists(profileAWorktree)).toBe(false);
      expect(await pathExists(legacyWorktree)).toBe(true);
    } finally {
      await profileAReconcileHarness.close();
    }
  } finally {
    for (const worktreePath of [profileAWorktree, profileBOrphan, legacyWorktree]) {
      if (worktreePath) {
        await git(workspacePath, "worktree", "remove", "--force", worktreePath).catch(
          () => undefined,
        );
      }
    }
    await rm(profileA, { recursive: true, force: true });
    await rm(profileB, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
    await rm(dirname(workspacePath), { recursive: true, force: true });
  }
});

test("shows a worktree icon in the sidebar without a local text badge", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("worktree-sidebar-indicator");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const rootWorkspace = await waitForWorkspaceByPath(window, workspacePath);

    await createNamedThread(window, "Local thread");
    const localRow = window.locator(".session-row", { hasText: "Local thread" });
    await expect(localRow).toBeVisible();
    await expect(localRow).toHaveAttribute("data-sidebar-indicator", "none");
    await expect(localRow.locator(".session-row__workspace-icon")).toHaveCount(0);
    await chooseThreadGrouping(window, "workspace");

    await window
      .getByRole("button", { name: `Workspace actions for ${rootWorkspace.name}` })
      .click();
    await window.getByRole("button", { name: "Create permanent worktree" }).click();

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const selected = state.workspaces.find(
          (workspace) => workspace.id === state.selectedWorkspaceId,
        );
        return selected?.kind === "worktree";
      })
      .toBe(true);

    const stateAfterCreate = await getDesktopState(window);
    const firstWorktree = stateAfterCreate.workspaces.find(
      (workspace) => workspace.id === stateAfterCreate.selectedWorkspaceId,
    );
    assertExists(firstWorktree, "Expected selected worktree workspace");

    await createSessionViaIpc(window, firstWorktree.id, "Worktree thread");
    const worktreeRow = window.locator(".session-row", { hasText: "Worktree thread" });
    await expect(worktreeRow).toBeVisible();
    await expect(worktreeRow).toHaveAttribute("data-sidebar-indicator", "none");
    await expect(worktreeRow.locator(".session-row__workspace-icon")).toHaveCount(1);
    await expect(window.getByTestId("workspace-list")).not.toContainText("Local project");
  } finally {
    await harness.close();
  }
});

test("keeps orphaned worktree workspaces visible after removing the root workspace", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("worktree-orphan-visibility");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const rootWorkspace = await waitForWorkspaceByPath(window, workspacePath);

    await window
      .getByRole("button", { name: `Workspace actions for ${rootWorkspace.name}` })
      .click();
    await window.getByRole("button", { name: "Create permanent worktree" }).click();

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const selected = state.workspaces.find(
          (workspace) => workspace.id === state.selectedWorkspaceId,
        );
        return selected?.kind === "worktree";
      })
      .toBe(true);

    const createdState = await getDesktopState(window);
    const createdWorkspace = createdState.workspaces.find(
      (workspace) => workspace.id === createdState.selectedWorkspaceId,
    );
    assertExists(createdWorkspace, "Expected created worktree workspace");

    await window
      .getByRole("button", { name: `Workspace actions for ${rootWorkspace.name}` })
      .click();
    const acceptRemoval = window.waitForEvent("dialog").then((dialog) => dialog.accept());
    await Promise.all([window.getByRole("button", { name: "Remove" }).click(), acceptRemoval]);

    await expect(window.getByTestId("empty-state")).toHaveCount(0);
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces.some((workspace) => workspace.id === createdWorkspace.id);
      })
      .toBe(true);
  } finally {
    await harness.close();
  }
});
