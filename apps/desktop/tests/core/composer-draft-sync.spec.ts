import { expect, test } from "@playwright/test";
import {
  clickSession,
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
} from "../helpers/electron-app";
import { desktopIpc } from "../../contracts/ipc";

interface TestDraftWriteControl {
  readonly drafts: string[];
  releaseFirstWrite(): void;
}

test("ignores stale persisted draft acknowledgements while typing", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-draft-sync");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Composer draft sync");

    const composer = window.getByTestId("composer");
    const expectedDraft = "forced-race-abcdef";
    const staleDraft = `${expectedDraft}x`;

    await composer.fill(staleDraft);
    await composer.press("Backspace");
    await expect(composer).toHaveValue(expectedDraft);

    const [, sampledValues] = await Promise.all([
      window.evaluate(
        async ({ stale }) => {
          await new Promise<void>((resolve) => globalThis.window.setTimeout(resolve, 50));
          const app = globalThis.window.piApp;
          if (!app) throw new Error("piApp IPC bridge is unavailable");
          await app.updateComposerDraft(stale);
        },
        { stale: staleDraft },
      ),
      window.evaluate(async () => {
        const composer = document.querySelector<HTMLTextAreaElement>("[data-testid='composer']");
        if (!composer) {
          throw new Error("Composer textarea was unavailable");
        }

        const values: string[] = [];
        const started = performance.now();
        while (performance.now() - started < 900) {
          values.push(composer.value);
          await new Promise((resolve) => globalThis.window.setTimeout(resolve, 20));
        }
        return values;
      }),
    ]);

    expect(sampledValues).not.toContain(staleDraft);
    await expect(composer).toHaveValue(expectedDraft);
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(expectedDraft);
  } finally {
    await harness.close();
  }
});

test("adopts a persisted draft when no local edit is pending", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-draft-clean-sync");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Clean composer draft sync");

    const persistedDraft = "persisted outside the local debounce";
    await window.evaluate(async (draft) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.updateComposerDraft(draft);
    }, persistedDraft);

    const composer = window.getByTestId("composer");
    await expect(composer).toHaveValue(persistedDraft);
    await window.waitForTimeout(600);
    await expect(composer).toHaveValue(persistedDraft);
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(persistedDraft);
  } finally {
    await harness.close();
  }
});

test("does not resurrect a cleared draft while an older write is in flight", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-draft-in-flight-clear");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "In-flight composer clear");
    await harness.electronApp.evaluate(({ ipcMain }, channel) => {
      type InvokeHandler = (...args: unknown[]) => unknown;
      const invokeHandlers = (
        ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
      )._invokeHandlers;
      const originalHandler = invokeHandlers?.get(channel);
      if (!originalHandler) {
        throw new Error(`No IPC handler registered for ${channel}`);
      }

      let releaseFirstWrite = () => {};
      const firstWriteGate = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      const control: TestDraftWriteControl = {
        drafts: [],
        releaseFirstWrite,
      };
      (
        globalThis as typeof globalThis & {
          __PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL?: TestDraftWriteControl;
        }
      ).__PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL = control;

      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const draft: unknown = args[1];
        if (typeof draft !== "string") {
          throw new Error("Composer draft IPC argument was not a string");
        }
        control.drafts.push(draft);
        if (control.drafts.length === 1) {
          await firstWriteGate;
        }
        return originalHandler(...args);
      });
    }, desktopIpc.updateComposerDraft);
    const readDraftWrites = () =>
      harness.electronApp.evaluate(() => {
        const control = (
          globalThis as typeof globalThis & {
            __PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL?: TestDraftWriteControl;
          }
        ).__PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL;
        return control?.drafts ?? [];
      });

    const composer = window.getByTestId("composer");
    await composer.fill("obsolete in-flight draft");
    await expect.poll(readDraftWrites).toEqual(["obsolete in-flight draft"]);

    await composer.fill("");
    await expect.poll(readDraftWrites).toEqual(["obsolete in-flight draft", ""]);

    await harness.electronApp.evaluate(() => {
      const control = (
        globalThis as typeof globalThis & {
          __PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL?: TestDraftWriteControl;
        }
      ).__PI_TEST_COMPOSER_DRAFT_WRITE_CONTROL;
      if (!control) {
        throw new Error("Delayed composer draft write was not pending");
      }
      control.releaseFirstWrite();
    });

    await expect.poll(readDraftWrites).toEqual(["obsolete in-flight draft", "", ""]);
    await expect(composer).toHaveValue("");
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe("");
  } finally {
    await harness.close();
  }
});

test("preserves a composer draft across a fast session switch", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-draft-fast-switch");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Draft Thread A");
    await createNamedThread(window, "Draft Thread B");

    await selectSession(window, "Draft Thread A");
    const composer = window.getByTestId("composer");
    const draft = "fast-switch-draft-xyz";
    await composer.fill(draft);
    await expect(composer).toHaveValue(draft);

    // Switch away immediately, before the 350ms persist debounce fires: the pending write must be
    // flushed onto Thread A rather than cancelled.
    await clickSession(window, "Draft Thread B");
    await expect(window.locator(".chat-header__title")).toHaveText("Draft Thread B");

    await selectSession(window, "Draft Thread A");
    await expect(composer).toHaveValue(draft);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(draft);
  } finally {
    await harness.close();
  }
});

test("applies explicit editor text replacements from the session host", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-editor-text-sync");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Editor text sync");

    const composer = window.getByTestId("composer");
    await composer.fill("local draft");
    await expect(composer).toHaveValue("local draft");

    const state = await getDesktopState(window);
    await emitTestSessionEvent(harness, {
      type: "hostUiRequest",
      sessionRef: {
        workspaceId: state.selectedWorkspaceId,
        sessionId: state.selectedSessionId,
      },
      timestamp: new Date().toISOString(),
      request: {
        kind: "editorText",
        requestId: "editor-text-sync",
        text: "remote replacement",
      },
    });

    await expect(composer).toHaveValue("remote replacement");
  } finally {
    await harness.close();
  }
});

for (const operation of ["draft", "command"] as const) {
  test(`keeps a queued ${operation} targeted at the session displayed at dispatch`, async () => {
    test.setTimeout(60_000);
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace(`composer-target-${operation}`);
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });

    try {
      const window = await harness.firstWindow();
      await createNamedThread(window, "Target Alpha");
      await createNamedThread(window, "Target Bravo");
      await window.getByTestId("composer").fill("Bravo stays intact");
      await expect
        .poll(async () => (await getDesktopState(window)).composerDraft)
        .toBe("Bravo stays intact");
      await selectSession(window, "Target Alpha");
      const state = await getDesktopState(window);
      const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      const bravo = workspace?.sessions.find((entry) => entry.title === "Target Bravo");
      if (!workspace || !bravo) throw new Error("Expected both target sessions");

      // Deliver both handlers in one main-process turn so navigation queues ahead
      // of the command while Alpha is still displayed. UI input cannot reliably
      // force this ordering; all outcomes are then checked through the real UI.
      await harness.electronApp.evaluate(
        async ({ ipcMain, BrowserWindow }, payload) => {
          type InvokeHandler = (...args: unknown[]) => unknown;
          const handlers = (
            ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
          )._invokeHandlers;
          const select = handlers?.get(payload.selectChannel);
          const act = handlers?.get(payload.actionChannel);
          const sender = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!select || !act || !sender) throw new Error("Expected desktop IPC handlers");
          const event = { sender };
          const selection = select(event, payload.target);
          const action = act(event, payload.text);
          await Promise.all([selection, action]);
        },
        {
          selectChannel: desktopIpc.selectSession,
          actionChannel:
            operation === "draft" ? desktopIpc.updateComposerDraft : desktopIpc.submitComposer,
          target: { workspaceId: workspace.id, sessionId: bravo.id },
          text: operation === "draft" ? "Alpha owns this queued draft" : "/status",
        },
      );

      await expect(window.locator(".chat-header__title")).toHaveText("Target Bravo");
      await expect(window.getByTestId("composer")).toHaveValue("Bravo stays intact");
      await expect(window.getByTestId("transcript")).not.toContainText(
        /Model |No session overrides set/,
      );
      await selectSession(window, "Target Alpha");
      if (operation === "draft") {
        await expect(window.getByTestId("composer")).toHaveValue("Alpha owns this queued draft");
      } else {
        await expect(window.getByTestId("transcript")).toContainText(
          /Model |No session overrides set/,
        );
        await expect(window.getByTestId("composer")).toHaveValue("");
      }
    } finally {
      await harness.close();
    }
  });
}
