import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  streamAssistantDeltas,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("persists workspace, selected session, and draft across app restart", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("codex-style-folder");
  const draft = "Now summarize the project title in one sentence.";

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await createNamedThread(window, "Persistence session");

    const composer = window.getByTestId("composer");
    await composer.fill(draft);
    await expect(composer).toHaveValue(draft);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(draft);
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    const persistedWorkspace = await waitForWorkspaceByPath(window, workspacePath);
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          return {
            selectedWorkspaceId: state.selectedWorkspaceId,
            selectedSessionId: state.selectedSessionId,
            hasPersistenceSession: state.workspaces.some((workspace) =>
              workspace.sessions.some((session) => session.title === "Persistence session"),
            ),
          };
        },
        { timeout: 15_000 },
      )
      .toMatchObject({
        selectedWorkspaceId: persistedWorkspace.id,
        hasPersistenceSession: true,
      });
    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));
    await expect(window.locator(".session-row--active")).toContainText("Persistence session");
    await expect(window.getByTestId("composer")).toHaveValue(draft);

    const state = await getDesktopState(window);
    const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
    );
    expect(selectedWorkspace?.path).toBeTruthy();
    expect(state.selectedSessionId).not.toBe("");
    expect(state.workspaces.some((workspace) => workspace.path === selectedWorkspace?.path)).toBe(
      true,
    );
    expect(
      state.workspaces.some((workspace) =>
        workspace.sessions.some((session) => session.title === "Persistence session"),
      ),
    ).toBe(true);
  } finally {
    await secondRun.close();
  }
});

test("navigates across folders and sessions through the sidebar", async () => {
  const userDataDir = await makeUserDataDir();
  const alphaPath = await makeWorkspace("alpha-workspace");
  const betaPath = await makeWorkspace("beta-workspace");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [alphaPath, betaPath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, alphaPath);
    await waitForWorkspaceByPath(window, betaPath);

    await createNamedThread(window, "Alpha session one", { workspaceName: basename(alphaPath) });
    await expect(window.locator(".session-row", { hasText: "Alpha session one" })).toHaveAttribute(
      "data-sidebar-indicator",
      "none",
    );

    await createNamedThread(window, "Alpha session two", { workspaceName: basename(alphaPath) });
    await createNamedThread(window, "Beta session one", { workspaceName: basename(betaPath) });

    await expect(window.locator(".chat-header__title")).toHaveText("Beta session one");
    await expect(window.locator(".session-row", { hasText: "Alpha session two" })).toHaveAttribute(
      "data-sidebar-indicator",
      "none",
    );

    await expect(window.getByTestId("workspace-list")).toContainText(basename(alphaPath));
    await expect(window.getByTestId("workspace-list")).toContainText(basename(betaPath));

    await selectSession(window, "Alpha session one");
    await selectSession(window, "Beta session one");

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return {
          alphaSessions:
            state.workspaces.find((workspace) => workspace.path === alphaPath)?.sessions.length ??
            0,
          betaSessions:
            state.workspaces.find((workspace) => workspace.path === betaPath)?.sessions.length ?? 0,
        };
      })
      .toEqual({
        alphaSessions: 2,
        betaSessions: 1,
      });

    const state = await getDesktopState(window);
    const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
    );
    expect(selectedWorkspace?.path).toBeTruthy();
    expect(state.selectedSessionId).not.toBe("");
  } finally {
    await harness.close();
  }
});

test("switching sessions republishes the selected transcript", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("session-switch-transcript-workspace");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await createNamedThread(window, "Thread one");
    await streamAssistantDeltas(harness, window, ["alpha response"]);
    await expect(window.getByTestId("transcript")).toContainText("alpha response");

    await createNamedThread(window, "Thread two");
    await streamAssistantDeltas(harness, window, ["beta response"]);
    await expect(window.getByTestId("transcript")).toContainText("beta response");

    await selectSession(window, "Thread one");
    await expect(window.locator(".chat-header__title")).toHaveText("Thread one");
    await expect(window.getByTestId("transcript")).toContainText("alpha response");
    await expect(window.getByTestId("transcript")).not.toContainText("Loading transcript");

    await selectSession(window, "Thread two");
    await expect(window.locator(".chat-header__title")).toHaveText("Thread two");
    await expect(window.getByTestId("transcript")).toContainText("beta response");
    await expect(window.getByTestId("transcript")).not.toContainText("Loading transcript");
  } finally {
    await harness.close();
  }
});

test("back and forward traverse projects, settings sections, and new thread without losing drafts", async () => {
  const alphaPath = await makeWorkspace("history-alpha");
  const betaPath = await makeWorkspace("history-beta");
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [alphaPath, betaPath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, betaPath);
    await createNamedThread(window, "History Alpha", { workspaceName: basename(alphaPath) });
    await createNamedThread(window, "History Beta", { workspaceName: basename(betaPath) });
    await selectSession(window, "History Alpha");
    await window.getByTestId("composer").fill("Keep Alpha draft");
    await selectSession(window, "History Beta");
    await window.getByTestId("composer").fill("Keep Beta draft");
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await window.keyboard.press(`${modifier}+,`);
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Models", exact: true }).click();
    await expect(window.getByRole("button", { name: "Models", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await window.keyboard.press(`${modifier}+[`);
    await expect(window.getByRole("button", { name: "General", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await window.keyboard.press(`${modifier}+[`);
    await expect(window.locator(".chat-header__title")).toHaveText("History Beta");
    await expect(window.getByTestId("composer")).toHaveValue("Keep Beta draft");
    await window.keyboard.press(`${modifier}+]`);
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.keyboard.press(`${modifier}+]`);
    await expect(window.getByRole("button", { name: "Models", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await window.keyboard.press(`${modifier}+[`);
    await expect(window.getByRole("button", { name: "General", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await window.keyboard.press(`${modifier}+[`);
    await expect(window.locator(".chat-header__title")).toHaveText("History Beta");
    await selectSession(window, "History Alpha");
    await expect(window.getByTestId("composer")).toHaveValue("Keep Alpha draft");
    await window.keyboard.press(`${modifier}+]`);
    await expect(window.locator(".chat-header__title")).toHaveText("History Alpha");
    await window.keyboard.press(`${modifier}+[`);
    await expect(window.locator(".chat-header__title")).toHaveText("History Beta");
    await window.keyboard.press(`${modifier}+]`);
    await expect(window.locator(".chat-header__title")).toHaveText("History Alpha");
    await window.keyboard.press(`${modifier}+n`);
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("new-thread");
    await window.keyboard.press(`${modifier}+[`);
    await expect(window.locator(".chat-header__title")).toHaveText("History Alpha");
    await window.keyboard.press(`${modifier}+]`);
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("new-thread");
  } finally {
    await harness.close();
  }
});

test("history includes scheduled tasks and both Customize tabs", async () => {
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("history-surfaces")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "History surfaces");
    await window.getByTestId("sidebar-scheduled").click();
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("scheduled");
    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(window.getByTestId("skills-surface")).toBeVisible();
    await window.getByRole("tab", { name: /^Extensions/ }).click();
    await expect(window.getByTestId("extensions-surface")).toBeVisible();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await window.keyboard.press(`${modifier}+[`);
    await expect(window.getByTestId("skills-surface")).toBeVisible();
    await window.keyboard.press(`${modifier}+[`);
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("scheduled");
    await window.keyboard.press(`${modifier}+[`);
    await expect(window.locator(".chat-header__title")).toHaveText("History surfaces");
    await window.keyboard.press(`${modifier}+]`);
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("scheduled");
    await window.keyboard.press(`${modifier}+]`);
    await expect(window.getByTestId("skills-surface")).toBeVisible();
    await window.keyboard.press(`${modifier}+]`);
    await expect(window.getByTestId("extensions-surface")).toBeVisible();
  } finally {
    await harness.close();
  }
});
