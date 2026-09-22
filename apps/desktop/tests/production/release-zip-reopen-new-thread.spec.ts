import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  extractPackagedReleaseZipAppBundle,
  getSelectedTranscript,
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  resolveAppBundleExecutable,
  resolveDeferredThreadTitleEventually,
  selectSession,
  setDeferredThreadTitleMode,
  startThreadFromSurface,
  streamAssistantDeltas,
  waitForSessionByTitle,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("relaunches a packaged release-zip build with a new auto-titled thread and restores title plus transcript", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir("pi-gui-release-zip-reopen-user-data-");
  const workspacePath = await makeWorkspace("release-zip-reopen-workspace");
  const appBundlePath = await extractPackagedReleaseZipAppBundle(
    undefined,
    "pi-gui release zip reopen.app",
  );
  const executablePath = await resolveAppBundleExecutable(appBundlePath);
  const promptText = "Review the release-zip reopen persistence behavior";
  const generatedTitle = "Release zip reopen persistence";

  const firstRun = await launchDesktopByExecutable(executablePath, userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));

    await setDeferredThreadTitleMode(firstRun);
    await startThreadFromSurface(window, {
      environment: "local",
      prompt: promptText,
      workspaceName: basename(workspacePath),
    });

    await expect(window.locator(".chat-header__title")).toHaveText("New thread");
    await resolveDeferredThreadTitleEventually(firstRun, generatedTitle);
    await expect(window.locator(".chat-header__title")).toHaveText(generatedTitle);
    await expect(
      window.locator(".session-row__select", { hasText: generatedTitle }).first(),
    ).toBeVisible();
    await expect(window.getByTestId("transcript")).toContainText(promptText);
  } finally {
    await firstRun.close();
  }

  const persistedUiState = JSON.parse(
    await readFile(join(userDataDir, "ui-state.json"), "utf8"),
  ) as {
    selectedSessionId?: string;
  };
  await expect(persistedUiState.selectedSessionId).toBeDefined();

  const secondRun = await launchDesktopByExecutable(executablePath, userDataDir, {
    testMode: "background",
  });

  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("workspace-list")).toContainText(basename(workspacePath));
    await expect(window.locator(".chat-header__title")).toHaveText(generatedTitle);
    await expect(
      window.locator(".session-row__select", { hasText: generatedTitle }).first(),
    ).toBeVisible();
    await expect(window.getByTestId("transcript")).toContainText(promptText);
    await expect(window.getByTestId("transcript")).not.toContainText("Loading transcript");
    await expect
      .poll(async () => {
        const transcript = await getSelectedTranscript(window);
        return transcript?.transcript.length ?? 0;
      })
      .toBeGreaterThan(0);
  } finally {
    await secondRun.close();
  }
});

test("relaunches a packaged release-zip build with multiple new threads and restores transcript selection", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir("pi-gui-release-zip-transcript-user-data-");
  const workspacePath = await makeWorkspace("release-zip-transcript-workspace");
  const appBundlePath = await extractPackagedReleaseZipAppBundle(
    undefined,
    "pi-gui release zip transcript.app",
  );
  const executablePath = await resolveAppBundleExecutable(appBundlePath);
  const firstPrompt = "Trace the first packaged transcript";
  const secondPrompt = "Trace the second packaged transcript";
  const firstTitle = "Packaged transcript one";
  const secondTitle = "Packaged transcript two";
  const firstResponse = "packaged first response";
  const secondResponse = "packaged second response";
  let firstSessionId = "";

  const firstRun = await launchDesktopByExecutable(executablePath, userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await firstRun.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);

    await setDeferredThreadTitleMode(firstRun);
    await startThreadFromSurface(window, {
      environment: "local",
      prompt: firstPrompt,
      workspaceName: basename(workspacePath),
    });
    await resolveDeferredThreadTitleEventually(firstRun, firstTitle);
    await expect(window.locator(".chat-header__title")).toHaveText(firstTitle);
    const firstSession = await waitForSessionByTitle(window, workspace.id, firstTitle);
    firstSessionId = firstSession.id;
    await streamAssistantDeltas(firstRun, window, [firstResponse]);
    await expect(window.getByTestId("transcript")).toContainText(firstResponse);

    await setDeferredThreadTitleMode(firstRun);
    await startThreadFromSurface(window, {
      environment: "local",
      prompt: secondPrompt,
      workspaceName: basename(workspacePath),
    });
    await resolveDeferredThreadTitleEventually(firstRun, secondTitle);
    await expect(window.locator(".chat-header__title")).toHaveText(secondTitle);
    await waitForSessionByTitle(window, workspace.id, secondTitle);
    await streamAssistantDeltas(firstRun, window, [secondResponse]);
    await expect(window.getByTestId("transcript")).toContainText(secondResponse);

    await selectSession(window, firstTitle);
    await expect(window.getByTestId("transcript")).toContainText(firstResponse);
    await expect(window.getByTestId("transcript")).not.toContainText("Loading transcript");
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(join(userDataDir, "ui-state.json"), "utf8"),
        ) as {
          selectedSessionId?: string;
        };
        return persisted.selectedSessionId ?? "";
      })
      .toBe(firstSession.id);
  } finally {
    await firstRun.close();
  }

  const persistedUiState = JSON.parse(
    await readFile(join(userDataDir, "ui-state.json"), "utf8"),
  ) as {
    selectedSessionId?: string;
  };
  expect(persistedUiState.selectedSessionId).toBe(firstSessionId);

  const secondRun = await launchDesktopByExecutable(executablePath, userDataDir, {
    testMode: "background",
  });

  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await expect(window.locator(".chat-header__title")).toHaveText(firstTitle);
    await expect(window.getByTestId("transcript")).toContainText(firstResponse);
    await expect(window.getByTestId("transcript")).not.toContainText("Loading transcript");
    await expect
      .poll(async () => {
        const transcript = await getSelectedTranscript(window);
        return transcript?.transcript.length ?? 0;
      })
      .toBeGreaterThan(0);

    await selectSession(window, secondTitle);
    await expect(window.getByTestId("transcript")).toContainText(secondResponse);
    await expect(window.getByTestId("transcript")).not.toContainText("Loading transcript");
  } finally {
    await secondRun.close();
  }
});
