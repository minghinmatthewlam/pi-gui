import test from "node:test";
import assert from "node:assert/strict";
import {
  messageText,
  shouldPersistSnapshotForAgentEvent,
} from "../dist/session-supervisor-utils.js";

const markdownParts = [
  "## Verification report",
  ["### Tests", "", "- Driver regression: passed", "- Electron projection: passed"].join("\n"),
  ["```text", "user prompt -> worker response", "```"].join("\n"),
];
const markdownReport = markdownParts.join("\n\n");

await test("messageText preserves Markdown newlines in array-shaped assistant content", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: markdownParts[0] },
      { type: "thinking", thinking: "Internal reasoning must not create a Markdown block." },
      { type: "text", text: markdownParts[1] },
      { type: "text", text: "" },
      { type: "text", text: markdownParts[2] },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  assert.equal(messageText(message), markdownReport);
});

await test("streaming partials are not persisted to the catalog, discrete events are", () => {
  // Persisting per message_update cost an atomic catalog write (fsync + rename +
  // directory fsync) per streamed token, serialized on the catalog's single
  // mutation queue, which is what made createSession hang during a stream.
  assert.equal(shouldPersistSnapshotForAgentEvent("message_update"), false);

  // Crash-recovery state must stay current to the last message boundary.
  for (const eventType of [
    "message_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "agent_end",
    "turn_start",
  ]) {
    assert.equal(shouldPersistSnapshotForAgentEvent(eventType), true, eventType);
  }
});
