import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  makeWorkspace,
  resolveDeferredThreadTitle,
  selectSession,
  setDeferredThreadTitleMode,
  startThreadFromSurface,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("auto-titles a brand-new local thread after showing the placeholder first", async () => {
  const userDataDir = await makeUserDataDir("pi-app-user-data-");
  const workspacePath = await makeWorkspace("auto-title-local-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);

    await startThreadFromSurface(window, {
      prompt: "Refactor the session title flow and keep sidebar state in sync",
    });

    const placeholderRow = window.locator(".session-row__select", { hasText: "New thread" }).first();
    await expect(window.locator(".topbar__session")).toHaveText("New thread");
    await expect(placeholderRow).toBeVisible();

    await resolveDeferredThreadTitle(harness, "Refactor title flow");

    await expect(window.locator(".topbar__session")).toHaveText("Refactor title flow");
    await expect(window.locator(".session-row__select", { hasText: "Refactor title flow" }).first()).toBeVisible();
    await expect(window.locator(".session-row__select", { hasText: "New thread" })).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("auto-titles a brand-new worktree thread after showing the placeholder first", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-");
  const workspacePath = await makeGitWorkspace("auto-title-worktree-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const rootWorkspace = await waitForWorkspaceByPath(window, workspacePath);
    await setDeferredThreadTitleMode(harness);

    await startThreadFromSurface(window, {
      environment: "worktree",
      workspaceName: rootWorkspace.name,
      prompt: "Fix the worktree rename race before shipping",
    });

    const placeholderRow = window.locator(".session-row__select", { hasText: "New thread" }).first();
    await expect(window.locator(".topbar__session")).toHaveText("New thread");
    await expect(placeholderRow).toBeVisible();

    await resolveDeferredThreadTitle(harness, "Fix worktree rename");

    await expect(window.locator(".topbar__session")).toHaveText("Fix worktree rename");
    await expect(window.locator(".session-row__select", { hasText: "Fix worktree rename" }).first()).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("switching away does not cancel a pending auto-title", async () => {
  const userDataDir = await makeUserDataDir("pi-app-user-data-");
  const workspacePath = await makeWorkspace("auto-title-navigation-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Existing thread");
    await setDeferredThreadTitleMode(harness);

    await startThreadFromSurface(window, {
      prompt: "Keep auto title alive after switching views",
    });

    await expect(window.locator(".topbar__session")).toHaveText("New thread");
    await selectSession(window, "Existing thread");
    await expect.poll(async () => (await getDesktopState(window)).selectedWorkspaceId).toBe(workspace.id);

    await resolveDeferredThreadTitle(harness, "Keep title after nav");

    await expect(window.locator(".session-row__select", { hasText: "Keep title after nav" }).first()).toBeVisible();
    await window.locator(".session-row__select", { hasText: "Keep title after nav" }).first().click();
    await expect(window.locator(".topbar__session")).toHaveText("Keep title after nav");
  } finally {
    await harness.close();
  }
});

test("manual rename beats a delayed auto-title result", async () => {
  const userDataDir = await makeUserDataDir("pi-app-user-data-");
  const workspacePath = await makeWorkspace("auto-title-manual-rename-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);

    await startThreadFromSurface(window, {
      prompt: "Build a deferred thread title test seam",
    });

    const composer = window.getByTestId("composer");
    await expect(window.locator(".topbar__session")).toHaveText("New thread");
    await expect(window.locator(".session-row__select", { hasText: "New thread" }).first()).toBeVisible();
    await waitForComposerReadyForNextSubmit(window);

    await composer.fill("/name Manual title wins");
    await composer.press("Enter");

    await expect(window.locator(".topbar__session")).toHaveText("Manual title wins");
    await expect(window.locator(".session-row__select", { hasText: "Manual title wins" }).first()).toBeVisible();

    await resolveDeferredThreadTitle(harness, "Ignored generated title");

    await expect(window.locator(".topbar__session")).toHaveText("Manual title wins");
    await expect(window.locator(".session-row__select", { hasText: "Manual title wins" }).first()).toBeVisible();
    await expect(window.locator(".session-row__select", { hasText: "Ignored generated title" })).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("later sends do not retrigger auto-title generation", async () => {
  const userDataDir = await makeUserDataDir("pi-app-user-data-");
  const workspacePath = await makeWorkspace("auto-title-no-retrigger-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);

    await startThreadFromSurface(window, {
      prompt: "Track a one-shot title request token",
    });

    await expect(window.locator(".topbar__session")).toHaveText("New thread");
    await resolveDeferredThreadTitle(harness, "Track title token");
    await expect(window.locator(".topbar__session")).toHaveText("Track title token");
    await expect(window.locator(".session-row__select", { hasText: "Track title token" }).first()).toBeVisible();
    await waitForComposerReadyForNextSubmit(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/status");
    await composer.press("Enter");

    await expect(window.locator(".topbar__session")).toHaveText("Track title token");
    await expect(window.locator(".session-row__select", { hasText: "Track title token" }).first()).toBeVisible();
    await expect(resolveDeferredThreadTitle(harness, "Should not apply")).rejects.toThrow(/unavailable/);
  } finally {
    await harness.close();
  }
});

async function waitForComposerReadyForNextSubmit(window: Page): Promise<void> {
  const sendButton = window.getByRole("button", { name: "Send message" });
  if (await sendButton.isVisible().catch(() => false)) {
    return;
  }

  const stopButton = window.getByRole("button", { name: "Stop run" });
  await expect
    .poll(async () => {
      if (await sendButton.isVisible().catch(() => false)) {
        return "send";
      }
      if (await stopButton.isVisible().catch(() => false)) {
        return "stop";
      }
      return "pending";
    }, { timeout: 15_000 })
    .not.toBe("pending");
  if (await sendButton.isVisible().catch(() => false)) {
    return;
  }
  try {
    await stopButton.click({ timeout: 5_000 });
  } catch (error) {
    if (!(await sendButton.isVisible().catch(() => false))) {
      throw error;
    }
  }
  await expect(sendButton).toBeVisible({ timeout: 15_000 });
}
