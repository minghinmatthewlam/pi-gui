import { mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { addWorkspace, createSession, getDesktopState, launchDesktop, makeWorkspace } from "./harness";

test("boots the Codex-style shell with an empty workspace catalog", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-app-user-data-"));
  const harness = await launchDesktop(userDataDir);

  try {
    const window = await harness.firstWindow();
    await expect(window.getByRole("button", { name: "New thread" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Open first folder" })).toBeVisible();
    await expect(window.getByTestId("empty-state")).toBeVisible();

    const newThreadBox = await window.getByRole("button", { name: "New thread" }).boundingBox();
    expect(newThreadBox).not.toBeNull();
    expect(newThreadBox?.y ?? 0).toBeGreaterThan(40);

    const state = await getDesktopState(window);
    expect(state.workspaces).toEqual([]);
    expect(state.selectedWorkspaceId).toBe("");
    expect(state.selectedSessionId).toBe("");
  } finally {
    await harness.close();
  }
});

test("persists workspace, session selection, and draft across app restart", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-app-user-data-"));
  const workspacePath = await makeWorkspace("codex-style-folder");
  const sessionTitle = "New thread";
  const draft = "Now summarize the project title in one sentence.";

  const firstRun = await launchDesktop(userDataDir);
  try {
    const window = await firstRun.firstWindow();
    await addWorkspace(window, workspacePath);
    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));

    await window.locator(".sidebar__new").click();
    await expect(window.getByRole("heading", { name: "Let's build" })).toBeVisible();
    await expect(window.locator(".topbar__session")).toHaveText("New thread");

    await window.getByRole("button", { name: "Start thread" }).click();

    await expect(window.locator(".topbar__session")).toHaveText(sessionTitle);

    const composer = window.getByTestId("composer");
    await composer.fill(draft);
    await expect(composer).toHaveValue(draft);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(draft);
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir);
  try {
    const window = await secondRun.firstWindow();
    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));
    await expect(window.locator(".session-row--active")).toContainText(sessionTitle);
    await expect(window.getByTestId("composer")).toHaveValue(draft);

    const state = await getDesktopState(window);
    const persistedWorkspace = state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
    expect(persistedWorkspace?.path).toBeTruthy();
    expect(state.selectedSessionId).not.toBe("");
    expect(state.workspaces.some((workspace) => workspace.path === persistedWorkspace?.path)).toBe(true);
    expect(state.workspaces.some((workspace) => workspace.sessions.some((session) => session.title === sessionTitle))).toBe(
      true,
    );
  } finally {
    await secondRun.close();
  }
});

test("navigates across folders and sessions through the sidebar", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-app-user-data-"));
  const alphaPath = await makeWorkspace("alpha-workspace");
  const betaPath = await makeWorkspace("beta-workspace");

  const harness = await launchDesktop(userDataDir);
  try {
    const window = await harness.firstWindow();

    await addWorkspace(window, alphaPath);
    await createSession(window, alphaPath, "Alpha session one");
    await expect(window.locator(".topbar__session")).toHaveText("Alpha session one");

    await createSession(window, alphaPath, "Alpha session two");
    await addWorkspace(window, betaPath);
    await createSession(window, betaPath, "Beta session one");
    await expect(window.locator(".topbar__session")).toHaveText("Beta session one");

    await expect(window.getByTestId("workspace-list")).toContainText(basename(alphaPath));
    await expect(window.getByTestId("workspace-list")).toContainText(basename(betaPath));

    await window.locator(".workspace-row", { hasText: "alpha-workspace" }).click();
    await expect(window.locator(".topbar__workspace")).toHaveText("alpha-workspace");

    await window.locator(".session-row__select", { hasText: "Alpha session one" }).click();
    await expect(window.locator(".topbar__session")).toHaveText("Alpha session one");

    await window.locator(".session-row__select", { hasText: "Beta session one" }).click();
    await expect(window.locator(".topbar__session")).toHaveText("Beta session one");

    const state = await getDesktopState(window);
    const selectedWorkspace = state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
    expect(selectedWorkspace?.path).toBeTruthy();
    expect(state.selectedSessionId).not.toBe("");
    expect(state.workspaces.find((workspace) => workspace.path === alphaPath)?.sessions).toHaveLength(2);
    expect(state.workspaces.find((workspace) => workspace.path === betaPath)?.sessions).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
