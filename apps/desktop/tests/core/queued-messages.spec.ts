import { desktopIpc } from "../../contracts/ipc";
import { expect, test } from "@playwright/test";
import type {
  SessionDriverEvent,
  SessionQueuedMessage,
  SessionRef,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import {
  TINY_PNG_BASE64,
  createNamedThread,
  desktopShortcut,
  emitTestSessionEvent,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  pasteTinyPng,
  selectSession,
} from "../helpers/electron-app";

async function selectedSessionContext(window: Parameters<typeof getDesktopState>[0]): Promise<{
  readonly sessionRef: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
}> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  if (!workspace) {
    throw new Error("Expected a selected workspace");
  }
  const session = workspace.sessions.find((entry) => entry.id === state.selectedSessionId);
  if (!session) {
    throw new Error("Expected a selected session");
  }
  return {
    sessionRef: {
      workspaceId: workspace.id,
      sessionId: session.id,
    },
    workspace: {
      workspaceId: workspace.id,
      path: workspace.path,
      displayName: workspace.name,
    },
    title: session.title,
  };
}

async function emitRunningSnapshot(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  window: Parameters<typeof getDesktopState>[0],
  queuedMessages: readonly SessionQueuedMessage[],
): Promise<void> {
  const context = await selectedSessionContext(window);
  const timestamp = new Date().toISOString();
  const event: Extract<SessionDriverEvent, { type: "sessionUpdated" }> = {
    type: "sessionUpdated",
    sessionRef: context.sessionRef,
    timestamp,
    runId: "queued-messages-core-run",
    snapshot: {
      ref: context.sessionRef,
      workspace: context.workspace,
      title: context.title,
      status: "running",
      updatedAt: timestamp,
      preview: "Working…",
      runningRunId: "queued-messages-core-run",
      queuedMessages,
    },
  };
  await emitTestSessionEvent(harness, event);
}

async function emitQueuedMessageStarted(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  window: Parameters<typeof getDesktopState>[0],
  message: SessionQueuedMessage,
  remainingQueuedMessages: readonly SessionQueuedMessage[],
): Promise<void> {
  const context = await selectedSessionContext(window);
  const timestamp = new Date().toISOString();
  const startedEvent: Extract<SessionDriverEvent, { type: "queuedMessageStarted" }> = {
    type: "queuedMessageStarted",
    sessionRef: context.sessionRef,
    timestamp,
    message,
  };
  await emitTestSessionEvent(harness, startedEvent);
  await emitRunningSnapshot(harness, window, remainingQueuedMessages);
}

async function transcriptMessages(
  window: Parameters<typeof getDesktopState>[0],
): Promise<string[]> {
  return (
    (await getSelectedTranscript(window))?.transcript.flatMap((item) =>
      item.kind === "message" ? [`${item.role}:${item.text}`] : [],
    ) ?? []
  );
}

test("shows queued messages while running and preserves attachments through inline edit", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("queued-messages-core");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Queued messages");

    const queuedMessage: SessionQueuedMessage = {
      id: "queued-message-1",
      mode: "followUp",
      text: "Inspect the queued screenshot",
      attachments: [
        {
          kind: "image",
          mimeType: "image/png",
          data: TINY_PNG_BASE64,
          name: "queued-image.png",
        },
      ],
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      updatedAt: new Date(Date.now() - 5_000).toISOString(),
    };
    await emitRunningSnapshot(harness, window, [queuedMessage]);
    await expect
      .poll(async () =>
        (await getDesktopState(window)).queuedComposerMessages.map((message) => message.text),
      )
      .toEqual(["Inspect the queued screenshot"]);

    const composer = window.getByTestId("composer");

    await composer.click();
    await window.keyboard.type("local scratch draft");
    await pasteTinyPng(window, "local-draft.png");
    await expect(window.locator(".composer-attachment__name")).toContainText("local-draft.png");

    const queuedCard = window.getByTestId("queued-composer-message").first();
    await expect(queuedCard.locator(".queued-composer-message__mode")).toHaveCount(0);
    await expect(
      queuedCard.locator(".queued-composer-message__header .queued-composer-message__text"),
    ).toContainText("Inspect the queued screenshot");
    await queuedCard.getByRole("button", { name: "Edit" }).click();
    await expect(window.getByTestId("queued-composer-editing")).toContainText(
      "Editing queued message",
    );
    await expect(composer).toHaveValue("Inspect the queued screenshot");
    await expect(window.locator(".composer-attachment__name")).toContainText("queued-image.png");

    await window.getByRole("button", { name: "Cancel" }).click();
    await expect(composer).toHaveValue("local scratch draft");
    await expect(window.locator(".composer-attachment__name")).toContainText("local-draft.png");
  } finally {
    await harness.close();
  }
});

test("delineates queued follow-ups and submitted steers in the timeline", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("queued-messages-timeline");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Queued timeline messages");

    const queuedSteer: SessionQueuedMessage = {
      id: "queued-steer-1",
      mode: "followUp",
      text: "Steer this queued message now",
      createdAt: new Date(Date.now() - 6_000).toISOString(),
      updatedAt: new Date(Date.now() - 6_000).toISOString(),
    };
    const queuedFollowUp: SessionQueuedMessage = {
      id: "queued-follow-up-1",
      mode: "followUp",
      text: "Run this queued follow-up next",
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      updatedAt: new Date(Date.now() - 5_000).toISOString(),
    };
    await emitRunningSnapshot(harness, window, [queuedSteer, queuedFollowUp]);

    await expect(
      window.getByTestId("queued-composer-message").filter({ hasText: queuedSteer.text }),
    ).toHaveCount(1);
    await expect(
      window.getByTestId("queued-composer-message").filter({ hasText: queuedFollowUp.text }),
    ).toHaveCount(1);
    await expect(window.locator(".queued-composer-message__mode")).toHaveCount(0);
    await expect(window.getByTestId("transcript")).not.toContainText(queuedSteer.text);
    await expect(window.getByTestId("transcript")).not.toContainText(queuedFollowUp.text);

    await window
      .getByTestId("queued-composer-message")
      .filter({ hasText: queuedSteer.text })
      .getByRole("button", { name: "Steer", exact: true })
      .click();
    await expect(
      window.getByTestId("queued-composer-message").filter({ hasText: queuedSteer.text }),
    ).toHaveCount(0);
    await expect(window.getByTestId("transcript")).toContainText(queuedSteer.text);

    const composer = window.getByTestId("composer");
    await composer.fill("Steer the current run now");
    await composer.press(desktopShortcut("Enter"));

    await expect(
      window
        .getByTestId("queued-composer-message")
        .filter({ hasText: "Steer the current run now" }),
    ).toHaveCount(0);
    await expect(window.getByTestId("transcript")).toContainText("Steer the current run now");

    await emitQueuedMessageStarted(harness, window, queuedFollowUp, []);
    await expect(window.getByTestId("queued-composer-messages")).toHaveCount(0);
    await expect(window.getByTestId("transcript")).toContainText(queuedFollowUp.text);

    await emitTestSessionEvent(harness, {
      type: "assistantDelta",
      sessionRef: (await selectedSessionContext(window)).sessionRef,
      timestamp: new Date().toISOString(),
      text: "Answering the queued follow-up",
    });

    await expect
      .poll(async () => transcriptMessages(window))
      .toEqual([
        `user:${queuedSteer.text}`,
        "user:Steer the current run now",
        `user:${queuedFollowUp.text}`,
        "assistant:Answering the queued follow-up",
      ]);
  } finally {
    await harness.close();
  }
});

test("queued edit and cancel keep their original session when navigation is already queued", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("queued-edit-target");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Queue Alpha");
    await createNamedThread(window, "Queue Bravo");
    await window.getByTestId("composer").fill("Bravo draft");
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe("Bravo draft");
    const bravo = (await selectedSessionContext(window)).sessionRef;
    await selectSession(window, "Queue Alpha");
    await window.getByTestId("composer").fill("Alpha scratch");
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe("Alpha scratch");
    const queuedMessage: SessionQueuedMessage = {
      id: "queue-target-message",
      mode: "followUp",
      text: "Edit Alpha queue",
      attachments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await emitRunningSnapshot(harness, window, [queuedMessage]);
    await expect(window.getByTestId("queued-composer-message")).toContainText(queuedMessage.text);

    for (const operation of ["edit", "cancel"] as const) {
      // Invoke both real handlers in one main turn to force navigation ahead
      // of an action dispatched while Alpha is still displayed.
      await harness.electronApp.evaluate(
        async ({ ipcMain, BrowserWindow }, payload) => {
          type InvokeHandler = (...args: unknown[]) => unknown;
          const handlers = (
            ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
          )._invokeHandlers;
          const select = handlers?.get(payload.selectChannel);
          const action = handlers?.get(payload.actionChannel);
          const sender = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!select || !action || !sender) throw new Error("Missing desktop handlers");
          const event = { sender };
          const navigation = select(event, payload.bravo);
          const mutation = action(event, ...payload.args);
          await Promise.all([navigation, mutation]);
        },
        {
          selectChannel: desktopIpc.selectSession,
          actionChannel:
            operation === "edit"
              ? desktopIpc.editQueuedComposerMessage
              : desktopIpc.cancelQueuedComposerEdit,
          bravo,
          args: operation === "edit" ? [queuedMessage.id, "Alpha scratch"] : [],
        },
      );
      await expect(window.locator(".chat-header__title")).toHaveText("Queue Bravo");
      await expect(window.getByTestId("composer")).toHaveValue("Bravo draft");
      await expect(window.getByTestId("queued-composer-editing")).toHaveCount(0);
      await selectSession(window, "Queue Alpha");
      await expect(window.getByTestId("composer")).toHaveValue(
        operation === "edit" ? queuedMessage.text : "Alpha scratch",
      );
      await expect(window.getByTestId("queued-composer-editing")).toHaveCount(
        operation === "edit" ? 1 : 0,
      );
    }
  } finally {
    await harness.close();
  }
});

test("an unsaved keystroke does not overwrite a queued edit or its cancel", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("queued-edit-draft-race");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Queued edit race");
    const queuedMessage: SessionQueuedMessage = {
      id: "queued-race-message",
      mode: "followUp",
      text: "Queued text to edit",
      attachments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await emitRunningSnapshot(harness, window, [queuedMessage]);
    await expect(window.getByTestId("queued-composer-message")).toContainText(queuedMessage.text);

    // Main serializes a window's actions in arrival order. Keep that order across these
    // channels and make the queued actions slow, so a debounced draft write that fires
    // after Edit or Cancel is sent is handled after it, as on a busy main process.
    await harness.electronApp.evaluate(
      ({ ipcMain }, payload) => {
        type InvokeHandler = (...args: unknown[]) => unknown;
        const handlers = (
          ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
        )._invokeHandlers;
        const store = globalThis as typeof globalThis & { __queuedEditChain__?: Promise<unknown> };
        store.__queuedEditChain__ = Promise.resolve();
        for (const [channel, delayMs] of payload.channels) {
          const original = handlers?.get(channel);
          if (!original) throw new Error(`No IPC handler registered for ${channel}`);
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, (...args) => {
            const result = (store.__queuedEditChain__ ?? Promise.resolve()).then(async () => {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              return original(...args);
            });
            store.__queuedEditChain__ = result.catch(() => undefined);
            return result;
          });
        }
      },
      {
        channels: [
          [desktopIpc.editQueuedComposerMessage, 600],
          [desktopIpc.cancelQueuedComposerEdit, 600],
          [desktopIpc.updateComposerDraft, 0],
        ] as const,
      },
    );
    const settle = async () => {
      await window.waitForTimeout(1_000);
      await harness.electronApp.evaluate(async () => {
        await (globalThis as typeof globalThis & { __queuedEditChain__?: Promise<unknown> })
          .__queuedEditChain__;
      });
    };

    const composer = window.getByTestId("composer");
    await composer.click();
    await window.keyboard.type("local scratch draft");
    // Click in the page so Edit is sent inside the 350ms draft-save debounce.
    await window
      .getByTestId("queued-composer-message")
      .getByRole("button", { name: "Edit", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await settle();
    await expect(window.getByTestId("queued-composer-editing")).toBeVisible();
    await expect(composer).toHaveValue(queuedMessage.text);
    expect((await getDesktopState(window)).composerDraft).toBe(queuedMessage.text);

    await composer.click();
    await window.keyboard.press("End");
    await window.keyboard.type(" changed");
    await window
      .getByRole("button", { name: "Cancel" })
      .evaluate((button: HTMLButtonElement) => button.click());
    await settle();
    await expect(window.getByTestId("queued-composer-editing")).toHaveCount(0);
    await expect(composer).toHaveValue("local scratch draft");
    expect((await getDesktopState(window)).composerDraft).toBe("local scratch draft");
  } finally {
    await harness.close();
  }
});
