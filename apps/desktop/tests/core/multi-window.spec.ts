import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  selectSidePanel,
  streamAssistantDeltas,
  waitForWorkspaceByPath,
  type DesktopHarness,
} from "../helpers/electron-app";

const platformModifier = process.platform === "darwin" ? "meta" : "control";

async function waitForPiApp(window: Page): Promise<void> {
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
    timeout: 15_000,
  });
}

async function waitForWindowCount(harness: DesktopHarness, count: number): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await harness.electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
          );
        } catch (error) {
          const message = String(error);
          if (
            message.includes("context was destroyed") ||
            message.includes("Target page, context or browser has been closed")
          ) {
            return -1;
          }
          throw error;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(count);
  await expect.poll(() => harness.electronApp.windows().length, { timeout: 15_000 }).toBe(count);
}

async function browserWindowIndexForPage(harness: DesktopHarness, source: Page): Promise<number> {
  const marker = `pi-gui-window-${Date.now()}-${Math.random()}`;
  await source.evaluate((value) => {
    Object.assign(window, { __piGuiTestWindowMarker: value });
  }, marker);
  const index = await harness.electronApp.evaluate(async ({ BrowserWindow }, value) => {
    const windows = BrowserWindow.getAllWindows();
    for (const [candidateIndex, candidateWindow] of windows.entries()) {
      const candidateMarker: unknown = await candidateWindow.webContents
        .executeJavaScript("window.__piGuiTestWindowMarker", true)
        .catch(() => undefined);
      if (candidateMarker === value) {
        return candidateIndex;
      }
    }
    return -1;
  }, marker);
  if (index === -1) {
    throw new Error("Expected source page to belong to the Electron app.");
  }
  return index;
}

async function openWindowViaShortcut(harness: DesktopHarness, source: Page): Promise<Page> {
  const existing = new Set(harness.electronApp.windows());
  const sourceIndex = await browserWindowIndexForPage(harness, source);
  await harness.electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[payload.sourceIndex]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "n",
        modifiers: [payload.modifier, "shift"],
      });
    },
    { sourceIndex, modifier: platformModifier },
  );
  await waitForWindowCount(harness, existing.size + 1);
  const opened = harness.electronApp.windows().find((candidate) => !existing.has(candidate));
  if (!opened) {
    throw new Error("Expected Shift+Cmd+N to create another Electron window.");
  }
  await waitForPiApp(opened);
  return opened;
}

async function expectSecondInstanceRestoresExistingWindow(
  harness: DesktopHarness,
  source: Page,
): Promise<void> {
  const existingWindowCount = harness.electronApp.windows().length;
  const sourceIndex = await browserWindowIndexForPage(harness, source);
  await harness.electronApp.evaluate(({ app, BrowserWindow }, index) => {
    const window = BrowserWindow.getAllWindows()[index];
    window?.show();
    window?.focus();
    window?.emit("focus");
    window?.minimize();
    app.emit("second-instance");
  }, sourceIndex);
  await waitForWindowCount(harness, existingWindowCount);
  await expect
    .poll(
      () =>
        harness.electronApp.evaluate(({ BrowserWindow }, index) => {
          const targetWindow = BrowserWindow.getAllWindows()[index];
          return {
            targetMinimized: targetWindow?.isMinimized() ?? true,
            targetVisible: targetWindow?.isVisible() ?? false,
          };
        }, sourceIndex),
      { timeout: 15_000 },
    )
    .toEqual({ targetMinimized: false, targetVisible: true });
}

async function selectedSummary(window: Page): Promise<{
  readonly workspacePath: string;
  readonly sessionTitle: string;
}> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
  return {
    workspacePath: workspace?.path ?? "",
    sessionTitle: session?.title ?? "",
  };
}

async function expectSelected(
  window: Page,
  workspacePath: string,
  sessionTitle: string,
): Promise<void> {
  await expect
    .poll(() => selectedSummary(window), { timeout: 15_000 })
    .toEqual({
      workspacePath,
      sessionTitle,
    });
  await expect(window.locator(".chat-header__title")).toHaveText(sessionTitle);
}

async function pendingDialogCount(
  window: Page,
  sessionRef: { readonly workspaceId: string; readonly sessionId: string },
): Promise<number> {
  const state = await getDesktopState(window);
  return (
    state.sessionExtensionUiBySession[`${sessionRef.workspaceId}:${sessionRef.sessionId}`]
      ?.pendingDialogs.length ?? 0
  );
}

async function selectSessionViaIpc(window: Page, title: string): Promise<void> {
  await window.evaluate(async (targetTitle) => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    const state = await app.getState();
    for (const workspace of state.workspaces) {
      const session = workspace.sessions.find((entry) => entry.title === targetTitle);
      if (!session) {
        continue;
      }
      await app.selectSession({ workspaceId: workspace.id, sessionId: session.id });
      return;
    }
    throw new Error(`Session not found: ${targetTitle}`);
  }, title);
}

async function selectSessionViaIpcAndCaptureStateEvents(
  window: Page,
  title: string,
): Promise<readonly string[]> {
  return window.evaluate(async (targetTitle) => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    const stateEvents: string[] = [];
    const unsubscribe = app.onStateChanged((nextState) => {
      const workspace = nextState.workspaces.find(
        (entry) => entry.id === nextState.selectedWorkspaceId,
      );
      const session = workspace?.sessions.find((entry) => entry.id === nextState.selectedSessionId);
      stateEvents.push(session?.title ?? "");
    });
    try {
      const state = await app.getState();
      for (const workspace of state.workspaces) {
        const session = workspace.sessions.find((entry) => entry.title === targetTitle);
        if (!session) {
          continue;
        }
        await app.selectSession({ workspaceId: workspace.id, sessionId: session.id });
        await new Promise((resolve) => setTimeout(resolve, 0));
        return stateEvents;
      }
      throw new Error(`Session not found: ${targetTitle}`);
    } finally {
      unsubscribe();
    }
  }, title);
}

async function stubDelayedOpenDialog(
  harness: DesktopHarness,
  filePaths: readonly string[],
): Promise<void> {
  await harness.electronApp.evaluate(({ dialog }, nextFilePaths) => {
    const original = dialog.showOpenDialog;
    const globals = globalThis as {
      __PI_TEST_OPEN_DIALOG_COUNT?: number;
      __PI_TEST_RESOLVE_OPEN_DIALOG?: () => void;
    };
    globals.__PI_TEST_OPEN_DIALOG_COUNT = 0;
    dialog.showOpenDialog = async () =>
      new Promise((resolve) => {
        globals.__PI_TEST_OPEN_DIALOG_COUNT = (globals.__PI_TEST_OPEN_DIALOG_COUNT ?? 0) + 1;
        globals.__PI_TEST_RESOLVE_OPEN_DIALOG = () => {
          dialog.showOpenDialog = original;
          delete globals.__PI_TEST_RESOLVE_OPEN_DIALOG;
          resolve({ canceled: false, filePaths: [...nextFilePaths] });
        };
      });
  }, filePaths);
}

async function waitForDelayedOpenDialog(harness: DesktopHarness): Promise<void> {
  await expect
    .poll(() =>
      harness.electronApp.evaluate(() => {
        return (
          (globalThis as { __PI_TEST_OPEN_DIALOG_COUNT?: number }).__PI_TEST_OPEN_DIALOG_COUNT ?? 0
        );
      }),
    )
    .toBe(1);
}

async function resolveDelayedOpenDialog(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(() => {
    const resolveOpenDialog = (globalThis as { __PI_TEST_RESOLVE_OPEN_DIALOG?: () => void })
      .__PI_TEST_RESOLVE_OPEN_DIALOG;
    if (!resolveOpenDialog) {
      throw new Error("Delayed open dialog was not pending.");
    }
    resolveOpenDialog();
  });
}

test("selects an empty workspace from the sidebar row", async () => {
  const userDataDir = await makeUserDataDir();
  const alphaPath = await makeWorkspace("empty-workspace-alpha");
  const betaPath = await makeWorkspace("empty-workspace-beta");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [alphaPath, betaPath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, alphaPath);
    await waitForWorkspaceByPath(window, betaPath);

    await window.locator(".workspace-row__select", { hasText: basename(betaPath) }).click();
    await expect
      .poll(() => selectedSummary(window), { timeout: 15_000 })
      .toEqual({
        workspacePath: betaPath,
        sessionTitle: "",
      });
    await expect(window.locator(".topbar__workspace")).toContainText(basename(betaPath));
    await expect(
      window.getByRole("heading", { name: basename(betaPath), exact: true }),
    ).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("opens multiple app windows with independent workspace and thread selection", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const alphaPath = await makeWorkspace("multi-window-alpha");
  const betaPath = await makeWorkspace("multi-window-beta");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [alphaPath, betaPath],
    testMode: "background",
  });

  try {
    const alphaName = basename(alphaPath);
    const betaName = basename(betaPath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, alphaPath);
    await waitForWorkspaceByPath(firstWindow, betaPath);

    await createNamedThread(firstWindow, "Alpha thread", { workspaceName: alphaName });
    await createNamedThread(firstWindow, "Beta thread", { workspaceName: betaName });
    await selectSession(firstWindow, "Alpha thread");
    await expectSelected(firstWindow, alphaPath, "Alpha thread");

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await expectSelected(secondWindow, alphaPath, "Alpha thread");

    await selectSession(secondWindow, "Beta thread");
    await expectSelected(secondWindow, betaPath, "Beta thread");
    await expectSelected(firstWindow, alphaPath, "Alpha thread");

    await createNamedThread(secondWindow, "Beta follow-up", { workspaceName: betaName });
    await expectSelected(secondWindow, betaPath, "Beta follow-up");
    await expectSelected(firstWindow, alphaPath, "Alpha thread");
    await expect
      .poll(async () => {
        const state = await getDesktopState(firstWindow);
        return (
          state.workspaces
            .find((workspace) => workspace.path === betaPath)
            ?.sessions.some((session) => session.title === "Beta follow-up") ?? false
        );
      })
      .toBe(true);

    await selectSession(firstWindow, "Beta follow-up");
    await expectSelected(firstWindow, betaPath, "Beta follow-up");
    await streamAssistantDeltas(harness, firstWindow, ["shared transcript update"]);
    await expect(firstWindow.getByTestId("transcript")).toContainText("shared transcript update");
    await expect(secondWindow.getByTestId("transcript")).toContainText("shared transcript update");

    await selectSession(firstWindow, "Alpha thread");
    await expectSelected(firstWindow, alphaPath, "Alpha thread");
    await expectSelected(secondWindow, betaPath, "Beta follow-up");

    await expectSecondInstanceRestoresExistingWindow(harness, firstWindow);
    await expectSelected(firstWindow, alphaPath, "Alpha thread");
    await waitForWindowCount(harness, 2);
  } finally {
    await harness.close();
  }
});

test("keeps each window selection when a background window changes transparency", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-transparency");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);
    await createNamedThread(firstWindow, "Transparency first", { workspaceName });
    await createNamedThread(firstWindow, "Transparency second", { workspaceName });
    await selectSession(firstWindow, "Transparency first");

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await selectSession(secondWindow, "Transparency second");
    await expectSelected(firstWindow, workspacePath, "Transparency first");
    await expectSelected(secondWindow, workspacePath, "Transparency second");

    const returnedSelection = await secondWindow.evaluate(async () => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      const state = await app.setEnableTransparency(true);
      const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      return workspace?.sessions.find((entry) => entry.id === state.selectedSessionId)?.title ?? "";
    });

    expect(returnedSelection).toBe("Transparency second");
    await expectSelected(firstWindow, workspacePath, "Transparency first");
    await expectSelected(secondWindow, workspacePath, "Transparency second");
    await expect
      .poll(async () => [
        (await getDesktopState(firstWindow)).enableTransparency,
        (await getDesktopState(secondWindow)).enableTransparency,
      ])
      .toEqual([true, true]);
  } finally {
    await harness.close();
  }
});

test("projects sender state emissions from the in-flight selection", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-sender-projection");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Fast source thread", { workspaceName });
    await createNamedThread(window, "Fast target thread", { workspaceName });
    await selectSession(window, "Fast source thread");

    const stateEvents = await selectSessionViaIpcAndCaptureStateEvents(
      window,
      "Fast target thread",
    );
    expect(stateEvents[0]).toBe("Fast target thread");
  } finally {
    await harness.close();
  }
});

test("keeps sender dialog actions scoped without blocking another window", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-awaited-scope");
  const attachmentPath = join(workspacePath, "sender-attachment.txt");
  await writeFile(attachmentPath, "sender scoped attachment\n", "utf8");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);
    await createNamedThread(firstWindow, "Attachment sender thread", { workspaceName });
    await createNamedThread(firstWindow, "Attachment focused thread", { workspaceName });
    await selectSession(firstWindow, "Attachment sender thread");

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await selectSession(secondWindow, "Attachment focused thread");
    await expectSelected(firstWindow, workspacePath, "Attachment sender thread");
    await expectSelected(secondWindow, workspacePath, "Attachment focused thread");

    await stubDelayedOpenDialog(harness, [attachmentPath]);
    const pickPromise = firstWindow.evaluate(async () => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.pickComposerAttachments();
    });
    await waitForDelayedOpenDialog(harness);

    const settlePick = async () => {
      await resolveDelayedOpenDialog(harness);
      await pickPromise;
    };
    try {
      await Promise.race([
        selectSessionViaIpc(secondWindow, "Attachment sender thread"),
        secondWindow.waitForTimeout(2_000).then(() => {
          throw new Error(
            "Second window selection was blocked by the first window attachment dialog.",
          );
        }),
      ]);
      await expectSelected(secondWindow, workspacePath, "Attachment sender thread");
      await selectSessionViaIpc(secondWindow, "Attachment focused thread");
      await expectSelected(secondWindow, workspacePath, "Attachment focused thread");

      const secondWindowIndex = await browserWindowIndexForPage(harness, secondWindow);
      await harness.electronApp.evaluate(({ BrowserWindow }, index) => {
        const targetWindow = BrowserWindow.getAllWindows()[index];
        targetWindow?.show();
        targetWindow?.focus();
        targetWindow?.emit("focus");
      }, secondWindowIndex);
    } catch (error) {
      await settlePick().catch(() => undefined);
      throw error;
    }
    // The sender can also navigate while its picker is pending (for example
    // via IPC or another navigation source). Selection at completion is not
    // the attachment's destination.
    await selectSessionViaIpc(firstWindow, "Attachment focused thread");
    await settlePick();
    await expect
      .poll(async () => (await getDesktopState(firstWindow)).composerAttachments.length)
      .toBe(0);
    await selectSession(firstWindow, "Attachment sender thread");

    await expect
      .poll(async () =>
        (await getDesktopState(firstWindow)).composerAttachments.map((entry) => entry.name),
      )
      .toEqual(["sender-attachment.txt"]);
    await expect
      .poll(async () => (await getDesktopState(secondWindow)).composerAttachments.length)
      .toBe(0);
  } finally {
    await harness.close();
  }
});

test("keeps a background window composer draft when another window changes selection", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-draft-sync");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);

    await createNamedThread(firstWindow, "Draft source one", { workspaceName });
    await createNamedThread(firstWindow, "Draft target two", { workspaceName });
    await createNamedThread(firstWindow, "Draft source three", { workspaceName });
    await selectSession(firstWindow, "Draft source one");

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await selectSession(secondWindow, "Draft target two");
    await expectSelected(firstWindow, workspacePath, "Draft source one");
    await expectSelected(secondWindow, workspacePath, "Draft target two");

    const secondComposer = secondWindow.getByTestId("composer");
    const unsavedDraft = "unsaved background draft";
    await secondComposer.fill(unsavedDraft);
    await expect(secondComposer).toHaveValue(unsavedDraft);

    await selectSession(firstWindow, "Draft source three");
    await expectSelected(firstWindow, workspacePath, "Draft source three");
    await expectSelected(secondWindow, workspacePath, "Draft target two");
    await secondWindow.waitForTimeout(500);
    await expect(secondComposer).toHaveValue(unsavedDraft);
  } finally {
    await harness.close();
  }
});

test("opens independent terminals for the same thread in separate windows", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-terminal");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);
    await createNamedThread(firstWindow, "Shared terminal thread", { workspaceName });
    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await expectSelected(secondWindow, workspacePath, "Shared terminal thread");

    await selectSidePanel(firstWindow, "Terminal");
    const firstTerminal = firstWindow.getByTestId("integrated-terminal");
    await expect(firstTerminal).toBeVisible();
    await firstTerminal.locator(".xterm").click();
    await firstWindow.keyboard.type("printf 'FIRST_WINDOW_TERMINAL\\n'");
    await firstWindow.keyboard.press("Enter");
    await expect(firstTerminal.locator(".xterm-rows")).toContainText("FIRST_WINDOW_TERMINAL", {
      timeout: 15_000,
    });

    await selectSidePanel(secondWindow, "Terminal");
    const secondTerminal = secondWindow.getByTestId("integrated-terminal");
    await expect(secondTerminal).toBeVisible();
    await secondTerminal.locator(".xterm").click();
    await secondWindow.keyboard.type("printf 'SECOND_WINDOW_TERMINAL\\n'");
    await secondWindow.keyboard.press("Enter");
    await expect(secondTerminal.locator(".xterm-rows")).toContainText("SECOND_WINDOW_TERMINAL", {
      timeout: 15_000,
    });
    await expect(firstTerminal.locator(".xterm-rows")).not.toContainText("SECOND_WINDOW_TERMINAL");
  } finally {
    await harness.close();
  }
});

test("applies editor text sync to the window showing the target session", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-editor-text");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);

    await createNamedThread(firstWindow, "Editor source one", { workspaceName });
    await createNamedThread(firstWindow, "Editor target two", { workspaceName });
    await selectSession(firstWindow, "Editor source one");

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await selectSession(secondWindow, "Editor target two");
    await expectSelected(firstWindow, workspacePath, "Editor source one");
    await expectSelected(secondWindow, workspacePath, "Editor target two");

    const targetState = await getDesktopState(secondWindow);
    await emitTestSessionEvent(harness, {
      type: "hostUiRequest",
      sessionRef: {
        workspaceId: targetState.selectedWorkspaceId,
        sessionId: targetState.selectedSessionId,
      },
      timestamp: new Date().toISOString(),
      request: {
        kind: "editorText",
        requestId: "multi-window-editor-text",
        text: "replacement for target window",
      },
    });

    await expect(secondWindow.getByTestId("composer")).toHaveValue("replacement for target window");
    await expect(firstWindow.getByTestId("composer")).not.toHaveValue(
      "replacement for target window",
    );
  } finally {
    await harness.close();
  }
});

test("cancels pending dialogs when the last visible same-session window closes", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-dialog-close");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);
    await createNamedThread(firstWindow, "Shared dialog thread", { workspaceName });
    await createNamedThread(firstWindow, "Other dialog thread", { workspaceName });
    await selectSession(firstWindow, "Shared dialog thread");

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await expectSelected(secondWindow, workspacePath, "Shared dialog thread");
    const secondWindowIndex = await browserWindowIndexForPage(harness, secondWindow);
    await harness.electronApp.evaluate(({ BrowserWindow }, index) => {
      BrowserWindow.getAllWindows()[index]?.show();
    }, secondWindowIndex);

    const targetState = await getDesktopState(secondWindow);
    const sessionRef = {
      workspaceId: targetState.selectedWorkspaceId,
      sessionId: targetState.selectedSessionId,
    };
    await emitTestSessionEvent(harness, {
      type: "hostUiRequest",
      sessionRef,
      timestamp: new Date().toISOString(),
      request: {
        kind: "confirm",
        requestId: "multi-window-shared-confirm",
        title: "Confirm shared dialog?",
        message: "Keep this dialog alive while another window shows the session.",
      },
    });

    await expect(secondWindow.getByTestId("extension-dialog")).toContainText(
      "Confirm shared dialog?",
    );
    await expect
      .poll(() => pendingDialogCount(secondWindow, sessionRef), { timeout: 5_000 })
      .toBe(1);

    await selectSessionViaIpc(firstWindow, "Other dialog thread");
    await expectSelected(firstWindow, workspacePath, "Other dialog thread");
    await expect(secondWindow.getByTestId("extension-dialog")).toContainText(
      "Confirm shared dialog?",
    );
    await expect
      .poll(() => pendingDialogCount(secondWindow, sessionRef), { timeout: 5_000 })
      .toBe(1);

    await secondWindow.close();
    await waitForWindowCount(harness, 1);
    await expect
      .poll(() => pendingDialogCount(firstWindow, sessionRef), { timeout: 5_000 })
      .toBe(0);
  } finally {
    await harness.close();
  }
});

test("mirrors composer draft updates when the same thread is open twice", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-shared-draft");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);
    await createNamedThread(firstWindow, "Shared draft thread", { workspaceName });

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await expectSelected(secondWindow, workspacePath, "Shared draft thread");

    const sharedDraft = "draft from first window";
    await firstWindow.getByTestId("composer").fill(sharedDraft);
    await expect(secondWindow.getByTestId("composer")).toHaveValue(sharedDraft, { timeout: 5_000 });
    await secondWindow.waitForTimeout(600);
    await expect
      .poll(async () => (await getDesktopState(firstWindow)).composerDraft)
      .toBe(sharedDraft);
  } finally {
    await harness.close();
  }
});
