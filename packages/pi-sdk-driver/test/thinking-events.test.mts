import assert from "node:assert/strict";
import test from "node:test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { SessionSupervisor } from "../dist/index.js";

const record = () => ({
  ref: { workspaceId: "workspace", sessionId: "session" },
  workspace: { workspaceId: "workspace", path: "/synthetic/workspace" },
  title: "Thinking turn",
  status: "running" as const,
  updatedAt: new Date().toISOString(),
  runningRunId: "run",
  queuedMessages: [],
});

// Exercise the runtime-event translation directly, the way pi streams a turn: reasoning
// tokens first, then the answer, then the message that carries both back.
function map(supervisor: unknown, event: unknown): SessionDriverEvent[] {
  return (
    supervisor as { mapAgentEvent(input: unknown, event: unknown): SessionDriverEvent[] }
  ).mapAgentEvent(record(), event);
}

await test("reasoning deltas reach the desktop as their own event, answer text stays separate", () => {
  const supervisor = new SessionSupervisor();
  const assistantMessage = { role: "assistant", content: [] };

  const thinking = map(supervisor, {
    type: "message_update",
    message: assistantMessage,
    assistantMessageEvent: { type: "thinking_delta", delta: "Check the failing test." },
  });
  const answer = map(supervisor, {
    type: "message_update",
    message: assistantMessage,
    assistantMessageEvent: { type: "text_delta", delta: "Fixed it." },
  });

  assert.deepEqual(
    thinking.map((event) => event.type),
    ["assistantThinkingDelta", "sessionUpdated"],
  );
  assert.equal(
    thinking[0]?.type === "assistantThinkingDelta" ? thinking[0].text : "",
    "Check the failing test.",
  );
  assert.equal(answer[0]?.type === "assistantDelta" ? answer[0].text : "", "Fixed it.");
});

await test("the finished turn reports its saved reasoning once, and only when it has one", () => {
  const supervisor = new SessionSupervisor();
  const reasoning = "Check the failing test.";
  const answer = "Fixed it.";

  const withThinking = map(supervisor, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: reasoning },
        { type: "text", text: answer },
      ],
    },
  });
  const withoutThinking = map(supervisor, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: answer }] },
  });

  const ended = withThinking[0];
  assert.equal(ended?.type, "assistantMessageEnded");
  assert.equal(ended?.type === "assistantMessageEnded" ? ended.thinking : undefined, reasoning);
  const plain = withoutThinking[0];
  assert.equal(plain?.type, "assistantMessageEnded");
  assert.equal(
    plain?.type === "assistantMessageEnded" && "thinking" in plain,
    false,
    "a turn without reasoning carries no thinking field",
  );
});
