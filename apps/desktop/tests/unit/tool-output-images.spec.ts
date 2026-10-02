import { expect, test } from "@playwright/test";
import { sessionKey } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { applyTimelineEvent } from "../../electron/conversation/app-store-timeline";
import {
  stringifyToolValue,
  toolOutputImages,
} from "../../src/features/conversation/tool-output-images";

const output = {
  content: [
    { type: "text", text: "two images" },
    { type: "image", data: "UE5HREFUQQ==", mimeType: "image/png" },
    { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" },
  ],
};

test("only listed image types become thumbnails", () => {
  expect(toolOutputImages(output)).toEqual([{ data: "UE5HREFUQQ==", mimeType: "image/png" }]);
  expect(toolOutputImages({ content: "text" })).toEqual([]);
  expect(toolOutputImages(undefined)).toEqual([]);
});

test("the row's text hides every image's data, shown or not", () => {
  const text = stringifyToolValue(output);
  expect(text).toContain("[image/png image]");
  expect(text).toContain("[image/svg+xml image]");
  expect(text).not.toContain("UE5HREFUQQ==");
  expect(text).not.toContain("PHN2Zz4=");
  expect(text).toContain("two images");
});

test("a failed tool that returned only images names them in its detail", () => {
  const sessionRef = { workspaceId: "workspace", sessionId: "session" };
  const timestamp = "2026-10-01T21:00:00.000Z";
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  applyTimelineEvent(
    transcript,
    { type: "toolStarted", sessionRef, timestamp, toolName: "read", callId: "c", input: {} },
    state,
  );
  applyTimelineEvent(
    transcript,
    {
      type: "toolFinished",
      sessionRef,
      timestamp,
      callId: "c",
      success: false,
      output: { content: [{ type: "image", data: "UE5HREFUQQ==", mimeType: "image/png" }] },
    },
    state,
  );
  const [row] = transcript.get(sessionKey(sessionRef))!.filter((item) => item.kind === "tool");
  expect(row).toMatchObject({ detail: "[image/png image]" });
});
