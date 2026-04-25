import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionQueuedMessage, SessionRef, WorkspaceRef } from "@pi-gui/session-driver";
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

async function transcriptMessages(window: Parameters<typeof getDesktopState>[0]): Promise<string[]> {
  return (await getSelectedTranscript(window))?.transcript.flatMap((item) =>
    item.kind === "message" ? [`${item.role}:${item.text}`] : [],
  ) ?? [];
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
      .poll(async () => (await getDesktopState(window)).queuedComposerMessages.map((message) => message.text))
      .toEqual(["Inspect the queued screenshot"]);

    const composer = window.getByTestId("composer");

    await composer.click();
    await window.keyboard.type("local scratch draft");
    await pasteTinyPng(window, "local-draft.png");
    await expect(window.locator(".composer-attachment__name")).toContainText("local-draft.png");

    const queuedCard = window.getByTestId("queued-composer-message").first();
    await expect(queuedCard.locator(".queued-composer-message__mode")).toHaveCount(0);
    await expect(queuedCard.locator(".queued-composer-message__header .queued-composer-message__text")).toContainText("Inspect the queued screenshot");
    await queuedCard.getByRole("button", { name: "Edit" }).click();
    await expect(window.getByTestId("queued-composer-editing")).toContainText("Editing queued message");
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

    await expect(window.getByTestId("queued-composer-message").filter({ hasText: queuedSteer.text })).toHaveCount(1);
    await expect(window.getByTestId("queued-composer-message").filter({ hasText: queuedFollowUp.text })).toHaveCount(1);
    await expect(window.locator(".queued-composer-message__mode")).toHaveCount(0);
    await expect(window.getByTestId("transcript")).not.toContainText(queuedSteer.text);
    await expect(window.getByTestId("transcript")).not.toContainText(queuedFollowUp.text);

    await window
      .getByTestId("queued-composer-message")
      .filter({ hasText: queuedSteer.text })
      .getByRole("button", { name: "Steer", exact: true })
      .click();
    await expect(window.getByTestId("queued-composer-message").filter({ hasText: queuedSteer.text })).toHaveCount(0);
    await expect(window.getByTestId("transcript")).toContainText(queuedSteer.text);

    const composer = window.getByTestId("composer");
    await composer.fill("Steer the current run now");
    await composer.press(desktopShortcut("Enter"));

    await expect(window.getByTestId("queued-composer-message").filter({ hasText: "Steer the current run now" })).toHaveCount(0);
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
