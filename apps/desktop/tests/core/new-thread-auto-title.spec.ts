import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  makeWorkspace,
  resolveDeferredThreadTitle,
  resolveDeferredThreadTitleEventually,
  selectSession,
  setDeferredThreadTitleMode,
  startThreadViaIpc,
  waitForDeferredThreadTitleRequest,
  waitForSelectedSessionReady,
  waitForSessionByTitle,
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

    await startThreadViaIpc(window, {
      prompt: "Refactor the session title flow and keep sidebar state in sync",
    });

    const placeholderRow = window
      .locator(".session-row__select", { hasText: "New thread" })
      .first();
    await expect(window.locator(".chat-header__title")).toHaveText("New thread");
    await expect(placeholderRow).toBeVisible();

    await resolveDeferredThreadTitleEventually(harness, "Refactor title flow");

    await expect(window.locator(".chat-header__title")).toHaveText("Refactor title flow");
    await expect(
      window.locator(".session-row__select", { hasText: "Refactor title flow" }).first(),
    ).toBeVisible();
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

    await startThreadViaIpc(window, {
      environment: "worktree",
      workspaceName: rootWorkspace.name,
      prompt: "Fix the worktree rename race before shipping",
    });

    const startedState = await getDesktopState(window);
    const startedSession = {
      workspaceId: startedState.selectedWorkspaceId,
      sessionId: startedState.selectedSessionId,
    };
    await waitForDeferredThreadTitleRequest(harness);
    await waitForSelectedSessionReady(window, startedSession);

    const placeholderRow = window
      .locator(".session-row__select", { hasText: "New thread" })
      .first();
    await expect(window.locator(".chat-header__title")).toHaveText("New thread");
    await expect(placeholderRow).toBeVisible();

    await resolveDeferredThreadTitle(harness, "Fix worktree rename");
    await waitForSessionByTitle(window, startedSession.workspaceId, "Fix worktree rename");

    await expect(window.locator(".chat-header__title")).toHaveText("Fix worktree rename");
    await expect(
      window.locator(".session-row__select", { hasText: "Fix worktree rename" }).first(),
    ).toBeVisible();
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

    await startThreadViaIpc(window, {
      prompt: "Keep auto title alive after switching views",
    });

    await expect(window.locator(".chat-header__title")).toHaveText("New thread");
    await waitForDeferredThreadTitleRequest(harness);
    await selectSession(window, "Existing thread");
    await expect
      .poll(async () => (await getDesktopState(window)).selectedWorkspaceId)
      .toBe(workspace.id);

    await resolveDeferredThreadTitleEventually(harness, "Keep title after nav");
    await waitForSessionByTitle(window, workspace.id, "Keep title after nav");

    const autoTitledRow = window
      .locator(".session-row__select", { hasText: "Keep title after nav" })
      .first();
    await expect(autoTitledRow).toBeVisible({ timeout: 15_000 });
    await autoTitledRow.click();
    await expect(window.locator(".chat-header__title")).toHaveText("Keep title after nav");
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

    await startThreadViaIpc(window, {
      prompt: "Build a deferred thread title test seam",
    });

    const composer = window.getByTestId("composer");
    await expect(window.locator(".chat-header__title")).toHaveText("New thread");
    await expect(
      window.locator(".session-row__select", { hasText: "New thread" }).first(),
    ).toBeVisible();
    await waitForComposerReadyForNextSubmit(window);

    await composer.fill("/name Manual title wins");
    await composer.press("Enter");

    await expect(window.locator(".chat-header__title")).toHaveText("Manual title wins", {
      timeout: 15_000,
    });
    await expect(
      window.locator(".session-row__select", { hasText: "Manual title wins" }).first(),
    ).toBeVisible();

    await resolveDeferredThreadTitleEventually(harness, "Ignored generated title");

    await expect(window.locator(".chat-header__title")).toHaveText("Manual title wins");
    await expect(
      window.locator(".session-row__select", { hasText: "Manual title wins" }).first(),
    ).toBeVisible();
    await expect(
      window.locator(".session-row__select", { hasText: "Ignored generated title" }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("manual rename applies after the run is aborted via Stop", async () => {
  const userDataDir = await makeUserDataDir("pi-app-user-data-");
  const workspacePath = await makeWorkspace("auto-title-abort-rename-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);

    await startThreadViaIpc(window, {
      prompt: "Build a deferred thread title test seam",
    });

    const composer = window.getByTestId("composer");
    await expect(window.locator(".chat-header__title")).toHaveText("New thread");

    // Abort the run while it is still active. The regression this covers: the
    // /name IPC response is built while abort-fallout events are still being
    // applied, so the response snapshot is older than the pushed state that
    // carries the rename — applying it unguarded rolled the title back.
    const stopButton = window.getByRole("button", { name: "Stop run" });
    try {
      await stopButton.click({ timeout: 10_000 });
    } catch {
      // Run finished before Stop was clickable; the rename must still apply.
    }
    await expect(window.getByRole("button", { name: "Send message" })).toBeVisible({
      timeout: 15_000,
    });

    await composer.fill("/name Manual title wins");
    await composer.press("Enter");

    await expect(window.locator(".chat-header__title")).toHaveText("Manual title wins", {
      timeout: 15_000,
    });
    await expect(
      window.locator(".session-row__select", { hasText: "Manual title wins" }).first(),
    ).toBeVisible();
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

    await startThreadViaIpc(window, {
      prompt: "Track a one-shot title request token",
    });

    await expect(window.locator(".chat-header__title")).toHaveText("New thread");
    await resolveDeferredThreadTitleEventually(harness, "Track title token");
    await expect(window.locator(".chat-header__title")).toHaveText("Track title token");
    await expect(
      window.locator(".session-row__select", { hasText: "Track title token" }).first(),
    ).toBeVisible();
    await waitForComposerReadyForNextSubmit(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/status");
    await composer.press("Enter");

    await expect(window.locator(".chat-header__title")).toHaveText("Track title token");
    await expect(
      window.locator(".session-row__select", { hasText: "Track title token" }).first(),
    ).toBeVisible();
    await expect(resolveDeferredThreadTitle(harness, "Should not apply")).rejects.toThrow(
      /unavailable/,
    );
  } finally {
    await harness.close();
  }
});

test("reopen heals a stale placeholder catalog title after auto-title finished", async () => {
  const userDataDir = await makeUserDataDir("pi-app-user-data-");
  const workspacePath = await makeWorkspace("auto-title-reopen-heal-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  const generatedTitle = "Heal title after reopen";

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await setDeferredThreadTitleMode(harness);

    await startThreadViaIpc(window, {
      prompt: "Verify the app heals stale placeholder titles on reopen",
    });

    await expect(window.locator(".chat-header__title")).toHaveText("New thread");
    await resolveDeferredThreadTitleEventually(harness, generatedTitle);
    await expect(window.locator(".chat-header__title")).toHaveText(generatedTitle);
    await expect(
      window.locator(".session-row__select", { hasText: generatedTitle }).first(),
    ).toBeVisible();

    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
  } finally {
    await harness.close();
  }

  const catalogsPath = join(userDataDir, "catalogs.json");
  const catalogs = JSON.parse(await readFile(catalogsPath, "utf8")) as {
    sessions: Array<{
      sessionRef: { workspaceId: string; sessionId: string };
      title: string;
    }>;
  };
  catalogs.sessions = catalogs.sessions.map((session) =>
    session.sessionRef.workspaceId === workspaceId && session.sessionRef.sessionId === sessionId
      ? { ...session, title: "New thread" }
      : session,
  );
  await writeFile(catalogsPath, `${JSON.stringify(catalogs, null, 2)}\n`, "utf8");

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.locator(".chat-header__title")).toHaveText(generatedTitle);
    await expect(
      window.locator(".session-row__select", { hasText: generatedTitle }).first(),
    ).toBeVisible();
    await expect(window.locator(".session-row__select", { hasText: "New thread" })).toHaveCount(0);
  } finally {
    await secondRun.close();
  }
});

async function waitForComposerReadyForNextSubmit(window: Page): Promise<void> {
  const sendButton = window.getByRole("button", { name: "Send message" });
  if (await sendButton.isVisible().catch(() => false)) {
    return;
  }

  const stopButton = window.getByRole("button", { name: "Stop run" });
  await expect
    .poll(
      async () => {
        if (await sendButton.isVisible().catch(() => false)) {
          return "send";
        }
        if (await stopButton.isVisible().catch(() => false)) {
          return "stop";
        }
        return "pending";
      },
      { timeout: 15_000 },
    )
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
