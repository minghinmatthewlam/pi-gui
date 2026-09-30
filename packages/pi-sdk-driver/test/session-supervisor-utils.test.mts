import test from "node:test";
import assert from "node:assert/strict";
import {
  determineRunOutcome,
  messageText,
  persistedToolOutput,
  shouldPersistSnapshotForAgentEvent,
  transcriptFromMessages,
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

await test("only a requested SDK abort is cancellation; actual provider errors remain failures", () => {
  const aborted = [
    { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" },
  ];
  assert.deepEqual(determineRunOutcome(aborted, true), { status: "cancelled" });
  assert.deepEqual(determineRunOutcome(aborted), {
    status: "failed",
    error: { code: "ABORTED", message: "Request was aborted" },
  });
  assert.deepEqual(
    determineRunOutcome(
      [{ role: "assistant", stopReason: "error", errorMessage: "Request was aborted" }],
      true,
    ),
    {
      status: "failed",
      error: { code: "ERROR", message: "Request was aborted" },
    },
  );
  assert.deepEqual(determineRunOutcome([{ role: "assistant", stopReason: "stop" }], true), {
    status: "completed",
  });
});

await test("the persist policy exempts streaming partials and keeps every discrete event", () => {
  // Persisting per message_update cost an atomic catalog write (fsync + rename +
  // directory fsync) per streamed token, serialized on the catalog's single
  // mutation queue, which is what made createSession hang during a stream.
  // This covers the policy across event types; session-supervisor-persist.test.mts
  // covers handleAgentEvent actually applying it.
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

await test("persistedToolOutput keeps only the content and details Pi saves", () => {
  const content = [{ type: "text", text: "ok" }];
  const details = { exitCode: 0 };
  assert.deepEqual(
    persistedToolOutput({
      content,
      details,
      // Pi 0.99 bash results also carry up to 1 MiB of output here; Pi never saves it.
      structuredContent: { output: "ok", exit_code: 0 },
      isError: false,
    }),
    { content, details },
  );
  assert.deepEqual(persistedToolOutput({ content }), { content });
  assert.deepEqual(persistedToolOutput(undefined), {});
});

await test("transcriptFromMessages shows displayed custom messages the way terminal pi does", () => {
  const custom = (id: string, display: boolean, content: unknown) => ({
    role: "custom",
    id,
    customType: "ci-status",
    content,
    display,
    timestamp: Date.parse("2026-09-30T00:00:00.000Z"),
  });
  const transcript = transcriptFromMessages([
    custom("shown", true, [
      { type: "text", text: "**Build** passed" },
      { type: "image", data: "", mimeType: "image/png" },
      { type: "text", text: "- 12 tests" },
    ]),
    custom("hidden", false, "only for the model"),
    custom("empty", true, [{ type: "image", data: "", mimeType: "image/png" }]),
    custom("plain", true, "  as a string  "),
  ]);

  assert.deepEqual(transcript, [
    {
      kind: "custom",
      id: "shown",
      createdAt: "2026-09-30T00:00:00.000Z",
      customType: "ci-status",
      text: "**Build** passed\n\n- 12 tests",
    },
    {
      kind: "custom",
      id: "plain",
      createdAt: "2026-09-30T00:00:00.000Z",
      customType: "ci-status",
      text: "as a string",
    },
  ]);
});
