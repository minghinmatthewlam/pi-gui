import { expect, test, type Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import { STREAMING_UI_PUBLISH_INTERVAL_MS } from "../../electron/conversation/streaming-ui-publisher";
import {
  createSessionViaIpc,
  emitTestSessionEvent,
  emitTestSessionEvents,
  getDesktopState,
  getTimelineScrollMetrics,
  jumpTimelineToBottom,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  scrollTimelineAwayFromBottom,
  seedTranscriptMessages,
} from "../helpers/electron-app";

const DELTA_COUNT = 80;

async function selectedSessionContext(window: Page): Promise<{
  readonly sessionRef: SessionRef;
  readonly workspace: {
    readonly workspaceId: string;
    readonly path: string;
    readonly displayName: string;
  };
  readonly title: string;
}> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
  if (!workspace || !session) {
    throw new Error("Expected a selected session for streaming publish proof");
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

function runningSnapshot(
  context: Awaited<ReturnType<typeof selectedSessionContext>>,
  runId: string,
  preview: string,
  timestamp: string,
): Extract<SessionDriverEvent, { type: "sessionUpdated" }> {
  return {
    type: "sessionUpdated",
    sessionRef: context.sessionRef,
    timestamp,
    runId,
    snapshot: {
      ref: context.sessionRef,
      workspace: context.workspace,
      title: context.title,
      status: "running",
      updatedAt: timestamp,
      preview,
      runningRunId: runId,
    },
  };
}

async function startCountingPublishes(window: Page): Promise<void> {
  await window.evaluate(() => {
    const g = globalThis as unknown as {
      __streamingPublish?: { state: number; transcript: number; stop: () => void };
    };
    g.__streamingPublish?.stop();
    const api = globalThis.window.piApp;
    if (!api) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    const counts = { state: 0, transcript: 0 };
    const stopState = api.onStateChanged(() => {
      counts.state += 1;
    });
    const stopTranscript = api.onSelectedTranscriptChanged(() => {
      counts.transcript += 1;
    });
    g.__streamingPublish = {
      get state() {
        return counts.state;
      },
      get transcript() {
        return counts.transcript;
      },
      stop() {
        stopState();
        stopTranscript();
      },
    };
  });
}

async function readPublishCounts(window: Page): Promise<{ state: number; transcript: number }> {
  return window.evaluate(() => {
    const counts = (
      globalThis as unknown as {
        __streamingPublish?: { state: number; transcript: number };
      }
    ).__streamingPublish;
    if (!counts) {
      throw new Error("Streaming publish counters were not started");
    }
    return { state: counts.state, transcript: counts.transcript };
  });
}

test("coalesces token publishes without losing stick-to-bottom or wheel unpin", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("streaming-publish-coalesce");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const state = await getDesktopState(window);
    const workspaceId = state.selectedWorkspaceId ?? state.workspaces[0]?.id;
    if (!workspaceId) {
      throw new Error("No workspace available");
    }
    await createSessionViaIpc(window, workspaceId, "Streaming publish session");
    await seedTranscriptMessages(harness, window, {
      count: 24,
      textFactory: (index) => `Streaming seed row ${index} `.repeat(8),
    });
    await jumpTimelineToBottom(window);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    const context = await selectedSessionContext(window);
    const runId = `coalesce-run-${Date.now()}`;
    const startedAt = new Date().toISOString();
    await emitTestSessionEvent(harness, runningSnapshot(context, runId, "streaming", startedAt));

    await startCountingPublishes(window);
    const events: SessionDriverEvent[] = [];
    for (let index = 0; index < DELTA_COUNT; index += 1) {
      const timestamp = new Date(Date.now() + index).toISOString();
      events.push({
        type: "assistantDelta",
        sessionRef: context.sessionRef,
        timestamp,
        runId,
        text: `tok${index} `,
      });
      events.push(runningSnapshot(context, runId, `tok${index}`, timestamp));
    }
    await emitTestSessionEvents(harness, events);
    await window.waitForTimeout(STREAMING_UI_PUBLISH_INTERVAL_MS + 40);

    const counts = await readPublishCounts(window);
    expect(
      counts.state,
      `state-changed count ${counts.state} should be far below ${DELTA_COUNT * 2} token events`,
    ).toBeLessThan(8);
    expect(counts.transcript).toBeLessThan(12);
    expect(counts.state).toBeGreaterThan(0);

    const expectedTail = `tok${DELTA_COUNT - 1} `;
    await expect(window.getByTestId("transcript")).toContainText(expectedTail);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    await scrollTimelineAwayFromBottom(window, 220);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeGreaterThan(100);
    const awayScrollTop = (await getTimelineScrollMetrics(window)).scrollTop;

    const awayRunId = `${runId}-away`;
    const awayStarted = new Date().toISOString();
    await emitTestSessionEvent(harness, runningSnapshot(context, awayRunId, "away", awayStarted));
    const awayEvents: SessionDriverEvent[] = [];
    for (let index = 0; index < 20; index += 1) {
      const timestamp = new Date(Date.now() + index).toISOString();
      awayEvents.push({
        type: "assistantDelta",
        sessionRef: context.sessionRef,
        timestamp,
        runId: awayRunId,
        text: `away${index} `,
      });
      awayEvents.push(runningSnapshot(context, awayRunId, `away${index}`, timestamp));
    }
    await emitTestSessionEvents(harness, awayEvents);
    await window.waitForTimeout(STREAMING_UI_PUBLISH_INTERVAL_MS + 40);
    await expect(window.getByTestId("transcript")).toContainText("away19 ");
    await expect
      .poll(async () => {
        const metrics = await getTimelineScrollMetrics(window);
        return Math.abs(metrics.scrollTop - awayScrollTop);
      })
      .toBeLessThanOrEqual(24);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
