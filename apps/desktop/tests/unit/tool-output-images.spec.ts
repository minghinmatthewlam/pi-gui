import { expect, test } from "@playwright/test";
import { sessionKey } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { applyTimelineEvent } from "../../electron/conversation/app-store-timeline";
import {
  makeTranscriptMessage,
  transcriptForWindow,
  transcriptImageResponse,
} from "../../electron/application/app-store-utils";
import {
  stringifyToolValue,
  toolOutputImageSrc,
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
    activeWorkingActivityBySession: new Map(),
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

test("the window's transcript carries image URLs, not image data, and main serves each one", async () => {
  const sessionRef = { workspaceId: "w s", sessionId: "s/1" };
  const tool = {
    kind: "tool",
    id: "call 1",
    callId: "call 1",
    toolName: "read",
    status: "success",
    label: "Read",
    createdAt: "2026-10-01T21:00:00.000Z",
    output,
  } as const satisfies TranscriptMessage;
  const text = makeTranscriptMessage("user", "hi");
  const stored: readonly TranscriptMessage[] = [text, tool];

  const sent = transcriptForWindow(sessionRef, stored);
  expect(sent[0]).toBe(text);
  expect(JSON.stringify(sent)).not.toContain("UE5HREFUQQ==");
  expect(JSON.stringify(sent)).not.toContain("PHN2Zz4=");
  // Same stored transcript, same array: unchanged transcripts still aren't resent.
  expect(transcriptForWindow(sessionRef, stored)).toBe(sent);

  const [image] = toolOutputImages((sent[1] as typeof tool).output);
  expect(image?.src).toMatch(/^pi-gui-image:\/\//);
  expect(toolOutputImageSrc(image!)).toBe(image!.src);
  expect(stringifyToolValue((sent[1] as typeof tool).output)).toContain("[image/png image]");

  const lookup = (key: string) => (key === sessionKey(sessionRef) ? stored : undefined);
  const served = transcriptImageResponse(image!.src!, lookup);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe("UE5HREFUQQ==");

  // The SVG block (index 2) isn't shown, so it isn't served either.
  expect(transcriptImageResponse(image!.src!.replace(/1$/, "2"), lookup).status).toBe(404);
  expect(transcriptImageResponse(image!.src!.replace("s%2F1", "other"), lookup).status).toBe(404);
});
