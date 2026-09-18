import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  STREAMING_UI_PUBLISH_INTERVAL_MS,
  StreamingUiPublisher,
  shouldDeferStreamingUiPublish,
} from "../../electron/conversation/streaming-ui-publisher";

const sessionRef: SessionRef = { workspaceId: "ws", sessionId: "sess" };

function runningUpdated(): Extract<SessionDriverEvent, { type: "sessionUpdated" }> {
  return {
    type: "sessionUpdated",
    sessionRef,
    timestamp: "2026-09-18T00:00:00.000Z",
    snapshot: {
      ref: sessionRef,
      workspace: { workspaceId: "ws", path: "/tmp", displayName: "tmp" },
      title: "Thread",
      status: "running",
      updatedAt: "2026-09-18T00:00:00.000Z",
      preview: "tok",
      runningRunId: "run-1",
    },
  };
}

test("defers token deltas and redundant running sessionUpdated ticks", () => {
  expect(
    shouldDeferStreamingUiPublish(
      {
        type: "assistantDelta",
        sessionRef,
        timestamp: "2026-09-18T00:00:00.000Z",
        text: "tok",
      },
      false,
    ),
  ).toBe(true);
  expect(shouldDeferStreamingUiPublish(runningUpdated(), true)).toBe(true);
  expect(shouldDeferStreamingUiPublish(runningUpdated(), false)).toBe(false);
  expect(
    shouldDeferStreamingUiPublish(
      {
        type: "runCompleted",
        sessionRef,
        timestamp: "2026-09-18T00:00:01.000Z",
        snapshot: {
          ...runningUpdated().snapshot,
          status: "idle",
          runningRunId: undefined,
        },
      },
      true,
    ),
  ).toBe(false);
});

test("throttles publishes to one trailing flush per session", async () => {
  const published: string[] = [];
  const publisher = new StreamingUiPublisher((ref) => {
    published.push(ref.sessionId);
  }, 25);

  publisher.schedule(sessionRef);
  publisher.schedule(sessionRef);
  publisher.schedule({ workspaceId: "ws", sessionId: "other" });
  expect(published).toEqual([]);

  await expect.poll(() => published.slice().sort()).toEqual(["other", "sess"]);
  publisher.schedule(sessionRef);
  await expect.poll(() => published.filter((id) => id === "sess")).toHaveLength(2);
});

test("cancel drops a pending flush so a discrete emit can publish itself", async () => {
  const published: string[] = [];
  const publisher = new StreamingUiPublisher((ref) => {
    published.push(ref.sessionId);
  }, 20);
  publisher.schedule(sessionRef);
  publisher.cancel(sessionRef);
  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  expect(published).toEqual([]);
  expect(STREAMING_UI_PUBLISH_INTERVAL_MS).toBe(50);
});
