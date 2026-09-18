import { expect, test } from "@playwright/test";
import {
  buildTranscriptChangeMarker,
  lastTranscriptItemMarker,
} from "../../src/features/conversation/hooks/transcript-change-marker";
import type { TranscriptMessage } from "../../contracts/desktop-state";

test("does not stringify the growing last assistant message", () => {
  const body = `{"secret":${"x".repeat(8_000)}}`;
  const item: TranscriptMessage = {
    kind: "message",
    id: "msg-1",
    role: "assistant",
    text: body,
    createdAt: "2026-09-18T00:00:00.000Z",
  };
  const marker = buildTranscriptChangeMarker("ws:sess", [item]);
  expect(marker.length).toBeLessThan(120);
  expect(marker).not.toContain("{");
  expect(marker).not.toContain(body.slice(0, 40));
  expect(marker).toContain(String(body.length));
  expect(JSON.stringify(item).length).toBeGreaterThan(8_000);
});

test("treats added tokens as a change without depending on full text equality", () => {
  const first: TranscriptMessage = {
    kind: "message",
    id: "msg-1",
    role: "assistant",
    text: "Hello",
    createdAt: "2026-09-18T00:00:00.000Z",
  };
  const grown: TranscriptMessage = { ...first, text: "Hello world" };
  expect(lastTranscriptItemMarker(first)).not.toBe(lastTranscriptItemMarker(grown));
  expect(buildTranscriptChangeMarker("s", [first])).not.toBe(
    buildTranscriptChangeMarker("s", [grown]),
  );
});
