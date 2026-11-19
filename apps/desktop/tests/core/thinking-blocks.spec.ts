import { expect, test, type Page } from "@playwright/test";
import type {
  SessionDriverEvent,
  SessionRef,
  SessionTranscriptMessage,
} from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvents,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const REASONING =
  "The reply text and the reasoning arrive as separate deltas, so they belong in separate parts.";
const REPLY = "Reasoning stays out of the answer.";

type RunContext = {
  readonly sessionRef: SessionRef;
  readonly workspace: {
    readonly workspaceId: string;
    readonly path: string;
    readonly displayName: string;
  };
  readonly title: string;
};

async function selectedContext(window: Page): Promise<RunContext> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
  if (!workspace || !session) {
    throw new Error("Expected a selected session for the thinking proof");
  }
  return {
    sessionRef: { workspaceId: workspace.id, sessionId: session.id },
    workspace: {
      workspaceId: workspace.id,
      path: workspace.path,
      displayName: workspace.name,
    },
    title: session.title,
  };
}

function runSnapshot(
  context: RunContext,
  runId: string,
  status: "running" | "idle",
  preview: string,
): SessionDriverEvent {
  const timestamp = new Date().toISOString();
  return {
    type: "sessionUpdated",
    sessionRef: context.sessionRef,
    timestamp,
    runId,
    snapshot: {
      ref: context.sessionRef,
      workspace: context.workspace,
      title: context.title,
      status,
      updatedAt: timestamp,
      preview,
      runningRunId: status === "running" ? runId : undefined,
    },
  };
}

async function streamReasonedReply(
  harness: Parameters<typeof emitTestSessionEvents>[0],
  window: Page,
  context: RunContext,
  runId: string,
  reasoning: string,
  reply: string,
): Promise<void> {
  await emitTestSessionEvents(harness, [
    runSnapshot(context, runId, "running", ""),
    {
      type: "thinkingDelta",
      sessionRef: context.sessionRef,
      timestamp: new Date().toISOString(),
      runId,
      text: reasoning,
    },
    {
      type: "assistantDelta",
      sessionRef: context.sessionRef,
      timestamp: new Date().toISOString(),
      runId,
      text: reply,
    },
    // The reply finishes; the next run's deltas belong to a new row.
    {
      type: "assistantMessageEnded",
      sessionRef: context.sessionRef,
      timestamp: new Date().toISOString(),
      runId,
    },
    runSnapshot(context, runId, "idle", reply),
  ]);
  await expect(window.getByTestId("transcript")).toContainText(reply);
}

test.describe("thinking blocks in the transcript", () => {
  test("renders reasoning as a collapsed section and keeps it out of the reply", async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("thinking-blocks-core");
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });

    try {
      const window = await harness.firstWindow();
      await createNamedThread(window, "Thinking thread");
      const context = await selectedContext(window);
      await streamReasonedReply(harness, window, context, "run-1", REASONING, REPLY);

      const section = window.getByTestId("timeline-thinking");
      await expect(section).toHaveCount(1);
      await expect(section.locator(".timeline-thinking__label")).toHaveText("Thinking");

      // Collapsed by default: the reasoning is in the document but not shown.
      await expect(section).not.toHaveAttribute("open");
      await expect(window.getByText(REASONING)).toBeHidden();
      await expect(window.getByTestId("transcript")).toContainText(REPLY);

      await section.locator("summary").click();
      await expect(section).toHaveAttribute("open");
      await expect(window.getByText(REASONING)).toBeVisible();
      await expect(window.getByTestId("transcript")).toContainText(REPLY);

      await section.locator("summary").click();
      await expect(section).not.toHaveAttribute("open");
      await expect(window.getByText(REASONING)).toBeHidden();

      // Reasoning is stored beside the reply, never inside its text.
      const transcript = await getSelectedTranscript(window);
      const assistant = transcript?.transcript.find(
        (item): item is SessionTranscriptMessage =>
          item.kind === "message" && item.role === "assistant",
      );
      expect(assistant?.thinking).toBe(REASONING);
      expect(assistant?.text).toBe(REPLY);
    } finally {
      await harness.close();
    }
  });

  test("Ctrl+T opens every reply's reasoning and closes them again", async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("thinking-blocks-toggle");
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });

    try {
      const window = await harness.firstWindow();
      await createNamedThread(window, "Thinking toggle");
      const context = await selectedContext(window);
      await streamReasonedReply(harness, window, context, "run-1", REASONING, REPLY);
      await streamReasonedReply(
        harness,
        window,
        context,
        "run-2",
        "The second answer needs its own reasoning.",
        "Second reply.",
      );

      const sections = window.getByTestId("timeline-thinking");
      await expect(sections).toHaveCount(2);
      await expect(sections.nth(0)).not.toHaveAttribute("open");
      await expect(sections.nth(1)).not.toHaveAttribute("open");

      // One reply opened by hand does not keep the chord from speaking for all of them.
      await sections.nth(0).locator("summary").click();
      await expect(sections.nth(0)).toHaveAttribute("open");

      await window.keyboard.press("Control+t");
      await expect(sections.nth(0)).toHaveAttribute("open");
      await expect(sections.nth(1)).toHaveAttribute("open");
      await expect(window.getByText("The second answer needs its own reasoning.")).toBeVisible();

      await window.keyboard.press("Control+t");
      await expect(sections.nth(0)).not.toHaveAttribute("open");
      await expect(sections.nth(1)).not.toHaveAttribute("open");
      await expect(window.getByText(REASONING)).toBeHidden();
    } finally {
      await harness.close();
    }
  });

  test("Ctrl+T toggles reasoning instead of typing into the composer", async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("thinking-blocks-composer");
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });

    try {
      const window = await harness.firstWindow();
      await createNamedThread(window, "Thinking composer chord");
      const context = await selectedContext(window);
      await streamReasonedReply(harness, window, context, "run-1", REASONING, REPLY);

      const composer = window.getByTestId("composer");
      await composer.click();
      await composer.fill("keep this draft");

      await window.keyboard.press("Control+t");

      await expect(composer).toHaveValue("keep this draft");
      await expect(window.getByTestId("timeline-thinking")).toHaveAttribute("open");
    } finally {
      await harness.close();
    }
  });
});
