import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  waitForSessionByTitle,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const compatibilityExtensionSource = String.raw`
export default function compatibilityExtension(pi) {
  pi.registerCommand("handoff-gui-test", {
    description: "Transfer context to a new focused session",
    handler: async (args, ctx) => {
      const goal = args.trim() || "Untitled goal";
      const generatedPrompt = await ctx.ui.custom((_tui, _theme, _kb, _done) => ({
        render: () => ["Generating handoff for " + goal],
      }));
      const editedPrompt = await ctx.ui.editor("Edit handoff prompt", generatedPrompt);
      if (editedPrompt === undefined) {
        return;
      }
      const nextSession = await ctx.newSession();
      if (nextSession.cancelled) {
        return;
      }
      ctx.ui.setEditorText(editedPrompt);
      ctx.ui.notify("Handoff ready. Submit when ready.", "info");
    },
  });

  pi.registerCommand("prefill-safe", {
    description: "Prefill the editor with a safe draft",
    handler: async (_args, ctx) => {
      ctx.ui.setEditorText("Safe draft");
      ctx.ui.notify("Safe command ran", "info");
    },
  });
}
`;

test("fails fast for unsupported handoff-like commands and learns terminal-only status", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extension-command-compatibility-workspace");
  await writeProjectExtension(workspacePath, "compatibility-extension.ts", compatibilityExtensionSource);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createSessionViaIpc(window, workspacePath, "Compatibility session");
    await selectSession(window, "Compatibility session");
    const compatibilitySession = await waitForSessionByTitle(window, workspace.id, "Compatibility session");
    const compatibilitySessionKey = `${workspace.id}:${compatibilitySession.id}`;
    await expect
      .poll(
        async () =>
          (await getDesktopState(window)).sessionCommandsBySession[compatibilitySessionKey]?.some(
            (command) => command.name === "handoff-gui-test",
          ) ?? false,
        { timeout: 15_000 },
      )
      .toBe(true);

    const sessionCountBefore =
      (await getDesktopState(window)).workspaces.find((entry) => entry.id === workspace.id)?.sessions.length ?? 0;
    const composer = window.getByTestId("composer");
    const composerError = window.getByTestId("composer-error-banner");

    await composer.fill("/handoff-gui-test continue the work");
    await composer.press("Enter");

    await expect(composerError).toContainText(
      "/handoff-gui-test requires terminal-only custom UI and is not supported in pi-gui yet.",
    );
    await expect(window.getByTestId("extension-dialog")).toHaveCount(0);
    await expect(window.locator(".timeline")).not.toContainText("Handoff ready. Submit when ready.");
    await expect
      .poll(
        async () => (await getDesktopState(window)).workspaces.find((entry) => entry.id === workspace.id)?.sessions.length ?? 0,
      )
      .toBe(sessionCountBefore);

    await composer.fill("/handoff-g");
    await expect(window.getByTestId("slash-menu")).toContainText("Terminal-only");

    const transcriptCountBeforeSecondAttempt = (await getSelectedTranscript(window))?.transcript.length ?? 0;
    await composer.fill("/handoff-gui-test local block");
    await composer.press("Enter");
    await expect(composerError).toContainText(
      "/handoff-gui-test requires terminal-only custom UI and is not supported in pi-gui yet.",
    );
    await expect
      .poll(
        async () =>
          (await getSelectedTranscript(window))?.transcript.length ?? 0,
      )
      .toBe(transcriptCountBeforeSecondAttempt);

    await composer.fill("/prefill-safe ");
    await composer.press("Enter");
    await expect(composer).toHaveValue("Safe draft");
    await expect(window.locator(".timeline")).toContainText("Safe command ran");

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expect(window.getByTestId("extensions-surface")).toBeVisible();
    await window.getByTestId("extensions-list").getByRole("button", { name: /compatibility-extension/i }).click();
    await expect(window.locator(".skill-detail")).toContainText("handoff-gui-test · Terminal-only");
    await expect(window.locator(".skill-detail")).toContainText("prefill-safe · GUI-compatible");
  } finally {
    await harness.close();
  }
});

test("persists learned terminal-only command compatibility across relaunch", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extension-command-compatibility-relaunch-workspace");
  await writeProjectExtension(workspacePath, "compatibility-extension.ts", compatibilityExtensionSource);

  const firstHarness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const firstWindow = await firstHarness.firstWindow();
    const workspace = await waitForWorkspaceByPath(firstWindow, workspacePath);
    await createSessionViaIpc(firstWindow, workspacePath, "Relaunch compatibility session");
    await selectSession(firstWindow, "Relaunch compatibility session");
    const session = await waitForSessionByTitle(firstWindow, workspace.id, "Relaunch compatibility session");
    const sessionKey = `${workspace.id}:${session.id}`;
    await expect
      .poll(
        async () =>
          (await getDesktopState(firstWindow)).sessionCommandsBySession[sessionKey]?.some(
            (command) => command.name === "handoff-gui-test",
          ) ?? false,
        { timeout: 15_000 },
      )
      .toBe(true);
    const composer = firstWindow.getByTestId("composer");
    await composer.fill("/handoff-gui-test persist this");
    await composer.press("Enter");
    await expect(firstWindow.getByTestId("composer-error-banner")).toContainText(
      "/handoff-gui-test requires terminal-only custom UI and is not supported in pi-gui yet.",
    );
  } finally {
    await firstHarness.close();
  }

  const secondHarness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const secondWindow = await secondHarness.firstWindow();
    const workspace = await waitForWorkspaceByPath(secondWindow, workspacePath);
    const session = await waitForSessionByTitle(secondWindow, workspace.id, "Relaunch compatibility session");
    await selectSession(secondWindow, "Relaunch compatibility session");
    const sessionKey = `${workspace.id}:${session.id}`;
    await expect
      .poll(
        async () =>
          (await getDesktopState(secondWindow)).sessionCommandsBySession[sessionKey]?.some(
            (command) => command.name === "handoff-gui-test",
          ) ?? false,
        { timeout: 15_000 },
      )
      .toBe(true);
    const composer = secondWindow.getByTestId("composer");
    await composer.fill("/handoff-g");
    await expect(secondWindow.getByTestId("slash-menu")).toContainText("Terminal-only");
  } finally {
    await secondHarness.close();
  }
});
