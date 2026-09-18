import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
  desktopShortcut,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedBranchedTreeSessionFixture,
  seedToolResultTreeSessionFixture,
  selectSession,
  waitForSelectedSessionReady,
} from "../helpers/electron-app";

test("opens /tree from the composer, navigates branches, and blocks it on the new-thread surface", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("tree-command-workspace");
  await seedAgentDir(agentDir);
  const fixture = await seedBranchedTreeSessionFixture(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, fixture.title);
    await waitForSelectedSessionReady(window, fixture);

    const composer = window.getByTestId("composer");
    await composer.fill("/tre");
    await expect(window.getByTestId("slash-menu")).toContainText("Tree");
    await composer.press("Enter");

    const treeModal = window.getByTestId("tree-modal");
    await expect(treeModal).toBeVisible();
    const treeSearch = window.getByTestId("tree-modal-search");
    await expect(treeSearch).toBeFocused();
    await composer.evaluate((element) => element.focus());
    await expect(treeSearch).toBeFocused();
    await expect(treeModal).not.toContainText("Tree fixture session");
    await expect(treeModal).not.toContainText("gpt-5.4");
    await expect(treeModal).not.toContainText("Thinking");
    await expect
      .poll(
        async () =>
          window
            .getByTestId("tree-modal-list")
            .evaluate((list) => (list instanceof HTMLElement ? list.scrollTop : -1)),
        { timeout: 1_500 },
      )
      .toBeGreaterThan(0);
    const initialScrollState = await window.getByTestId("tree-modal-list").evaluate((list) => {
      if (!(list instanceof HTMLElement)) {
        throw new Error("Expected tree list in modal");
      }
      return {
        scrollTop: list.scrollTop,
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
      };
    });
    expect(initialScrollState.scrollTop).toBeGreaterThan(0);
    expect(initialScrollState.scrollTop + initialScrollState.clientHeight).toBeGreaterThan(
      initialScrollState.scrollHeight - 40,
    );

    await treeModal.locator(".tree-row__content", { hasText: "Branch alpha" }).click();
    await treeModal.getByRole("button", { name: "Continue" }).click();
    await expect(window.getByTestId("tree-summary-step")).toBeVisible();
    await treeModal.getByRole("button", { name: "No summary" }).click();
    await treeModal.getByRole("button", { name: "Switch branch" }).click();

    await expect(treeModal).toHaveCount(0);
    await expect(composer).toHaveValue("Branch alpha");
    await expect(window.getByTestId("transcript")).toContainText("Root answer");
    await expect(window.getByTestId("transcript")).not.toContainText("Branch beta");

    await composer.fill("/tree");
    await composer.press("Enter");
    await expect(treeModal).toBeVisible();
    await treeModal.locator(".tree-row__content", { hasText: "Beta answer" }).click();
    await treeModal.getByRole("button", { name: "Continue" }).click();
    await treeModal.getByRole("button", { name: "No summary" }).click();
    await treeModal.getByRole("button", { name: "Switch branch" }).click();

    await expect(treeModal).toHaveCount(0);
    await expect(composer).toHaveValue("");
    await expect(window.getByTestId("transcript")).toContainText("Branch beta");
    await expect(window.getByTestId("transcript")).toContainText("Beta answer");

    await window.keyboard.press(desktopShortcut("Shift+O"));
    const newThreadComposer = window.getByTestId("new-thread-composer");
    await expect(newThreadComposer).toBeVisible();
    await newThreadComposer.fill("/tree");
    await expect(window.getByTestId("slash-menu")).toHaveCount(0);
    await newThreadComposer.press("Enter");
    await expect(window.getByTestId("composer-error-banner")).toContainText(
      "/tree is only available inside an existing session.",
    );
    await expect(newThreadComposer).toHaveValue("/tree");
  } finally {
    await harness.close();
  }
});

test("restores focus to a remaining extension dialog after the tree modal closes", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("tree-extension-dialog-workspace");
  await seedAgentDir(agentDir);
  const fixture = await seedBranchedTreeSessionFixture(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, fixture.title);
    await waitForSelectedSessionReady(window, fixture);

    const composer = window.getByTestId("composer");
    await composer.fill("/tree");
    await composer.press("Enter");

    const treeModal = window.getByTestId("tree-modal");
    await expect(treeModal).toBeVisible();
    await expect(window.getByTestId("tree-modal-search")).toBeFocused();

    const state = await getDesktopState(window);
    await emitTestSessionEvent(harness, {
      type: "hostUiRequest",
      sessionRef: {
        workspaceId: state.selectedWorkspaceId,
        sessionId: state.selectedSessionId,
      },
      timestamp: new Date().toISOString(),
      request: {
        kind: "confirm",
        requestId: "tree-stacked-extension-confirm",
        title: "Confirm stacked dialog?",
        message: "Keep focus here after the tree closes.",
      },
    });

    const extensionDialog = window.getByTestId("extension-dialog");
    const extensionCancel = extensionDialog.getByTestId("extension-dialog-cancel");
    await expect(extensionDialog).toBeVisible();
    await expect(window.getByTestId("tree-modal-search")).toBeFocused();

    await treeModal.getByRole("button", { name: "Close tree modal" }).click();
    await expect(treeModal).toHaveCount(0);
    await expect(extensionDialog).toBeVisible();
    await expect(extensionCancel).toBeFocused();
  } finally {
    await harness.close();
  }
});

test("renders tool results with compact previews in the tree modal", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("tree-tool-command-workspace");
  await seedAgentDir(agentDir);
  const fixture = await seedToolResultTreeSessionFixture(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, fixture.title);
    await waitForSelectedSessionReady(window, fixture);

    const composer = window.getByTestId("composer");
    await composer.fill("/tree");
    await expect(window.getByTestId("slash-menu")).toContainText("Tree");
    await composer.press("Enter");

    const treeModal = window.getByTestId("tree-modal");
    await expect(treeModal).toBeVisible();
    await expect(treeModal).toContainText("[read:");
    await expect(treeModal).toContainText("assistant: README inspected.");
    await expect(treeModal.getByRole("button", { name: "No tools" })).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
