import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addWorkspaceViaIpc,
  chooseThreadGrouping,
  createSessionViaIpc,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("adds a workspace to an empty launched app", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("launch-diagnostic-workspace");
  const harness = await launchDesktop(userDataDir, { testMode: "background" });

  try {
    const window = await harness.firstWindow();
    await expect.poll(async () => (await getDesktopState(window)).workspaces).toEqual([]);

    await addWorkspaceViaIpc(window, workspacePath);

    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("workspace-list")).toContainText(workspace.name);
  } finally {
    await harness.close();
  }
});

test("boots an existing workspace and starts a new thread through the real UI", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("core-smoke-workspace");
  const promptText = "Smoke test thread";
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();

    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();

    const prompt = window.getByLabel("New thread prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt).toBeFocused();
    await expect(window.getByRole("heading", { name: "Let's build" })).toBeVisible();
    await prompt.fill(promptText);

    await window.getByRole("button", { name: "Start thread" }).click();

    await expect(window.locator(".chat-header__title")).toHaveText(/\S+/);
    await expect(window.getByTestId("composer")).toBeFocused();
    await expect
      .poll(
        async () => {
          const transcript = await getSelectedTranscript(window);
          const userMessage = transcript?.transcript.find(
            (entry): entry is Extract<typeof entry, { kind: "message" }> =>
              entry.kind === "message" && entry.role === "user",
          );
          return userMessage?.text ?? "";
        },
        { timeout: 15_000 },
      )
      .toContain(promptText);
    await expect(window.getByTestId("transcript")).toContainText(promptText);
  } finally {
    await harness.close();
  }
});

test("aligns workspace names with session titles in the sidebar gutter", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("aligned-sidebar-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();

    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));
    await createSessionViaIpc(window, workspacePath, "Aligned session");
    await chooseThreadGrouping(window, "workspace");

    const workspaceName = window.locator(".workspace-row__name").first();
    const sessionTitle = window.locator(".session-row__title", {
      hasText: "Aligned session",
    });

    await expect(workspaceName).toBeVisible();
    await expect(sessionTitle).toBeVisible();

    const [workspaceBox, sessionBox] = await Promise.all([
      workspaceName.boundingBox(),
      sessionTitle.boundingBox(),
    ]);
    expect(workspaceBox).not.toBeNull();
    expect(sessionBox).not.toBeNull();
    expect(Math.abs((workspaceBox?.x ?? 0) - (sessionBox?.x ?? 0))).toBeLessThanOrEqual(1);
  } finally {
    await harness.close();
  }
});
