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
          const { selectedWorkspaceId, selectedSessionId } = await app.getState();
          if (!selectedWorkspaceId || !selectedSessionId) throw new Error("No selected session");
          await app.updateComposerDraft(stale, {
            workspaceId: selectedWorkspaceId,
            sessionId: selectedSessionId,
          });
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
      const { selectedWorkspaceId, selectedSessionId } = await app.getState();
      if (!selectedWorkspaceId || !selectedSessionId) throw new Error("No selected session");
      await app.updateComposerDraft(draft, {
        workspaceId: selectedWorkspaceId,
        sessionId: selectedSessionId,
      });
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
    // Hold the first draft write in flight while later writes go through.
    await harness.ipc.control(desktopIpc.updateComposerDraft, { mode: "hold" });
    const readDraftWrites = async () =>
      (await harness.ipc.read(desktopIpc.updateComposerDraft)).args.map((args) => args[0]);

    const composer = window.getByTestId("composer");
    await composer.fill("obsolete in-flight draft");
    await expect.poll(readDraftWrites).toEqual(["obsolete in-flight draft"]);
    await harness.ipc.update(desktopIpc.updateComposerDraft, { mode: "passthrough" });

    await composer.fill("");
    await expect.poll(readDraftWrites).toEqual(["obsolete in-flight draft", ""]);

    await harness.ipc.release(desktopIpc.updateComposerDraft);

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
      const target = { workspaceId: workspace.id, sessionId: bravo.id };
      await harness.ipc.invokeTogether([
        { channel: desktopIpc.selectSession, args: [target] },
        operation === "draft"
          ? {
              // A draft write names the task it was typed in; a command uses the window's view.
              channel: desktopIpc.updateComposerDraft,
              args: [
                "Alpha owns this queued draft",
                { workspaceId: workspace.id, sessionId: state.selectedSessionId },
              ],
            }
          : { channel: desktopIpc.submitComposer, args: ["/status"] },
      ]);

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

test("Cmd/Ctrl+number keeps a draft typed just before switching on its own thread", async () => {
  test.setTimeout(60_000);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("composer-draft-number-switch")],
    testMode: "background",
  });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  try {
    const window = await harness.firstWindow();
    const title = window.locator(".chat-header__title");
    const composer = window.getByTestId("composer");
    await createNamedThread(window, "Number Alpha");
    await createNamedThread(window, "Number Bravo");
    // Newest first: 1 opens Bravo, 2 opens Alpha.
    await composer.click();
    await composer.pressSequentially("typed right before switching");
    await window.keyboard.press(`${modifier}+2`);
    await expect(title).toHaveText("Number Alpha");
    await expect(composer).toHaveValue("");
    await window.keyboard.press(`${modifier}+1`);
    await expect(title).toHaveText("Number Bravo");
    await expect(composer).toHaveValue("typed right before switching");
  } finally {
    await harness.close();
  }
});
