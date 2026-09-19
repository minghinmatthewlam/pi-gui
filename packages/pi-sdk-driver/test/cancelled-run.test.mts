import assert from "node:assert/strict";
import test from "node:test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { SessionSupervisor } from "../dist/index.js";

await test("requested abort emits only idle state, without completion or failure notifications", () => {
  const record = {
    ref: { workspaceId: "workspace", sessionId: "session" },
    workspace: { workspaceId: "workspace", path: "/synthetic/workspace" },
    title: "Cancelled turn",
    status: "running",
    updatedAt: new Date().toISOString(),
    runningRunId: "run",
    cancellationRequested: true,
    queuedMessages: [],
  };
  // Exercise the runtime-event translation directly; no live session, provider,
  // disk state or credentials are needed to prove the emitted event contract.
  const supervisor = new SessionSupervisor() as unknown as {
    mapAgentEvent(input: typeof record, event: unknown): SessionDriverEvent[];
  };
  const events = supervisor.mapAgentEvent(record, {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" }],
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["sessionUpdated"],
  );
  assert.equal(record.status, "idle");
  assert.equal(record.runningRunId, undefined);
  assert.equal(record.cancellationRequested, false);
  const nextEvents = supervisor.mapAgentEvent(record, {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "Unexpected abort" }],
  });
  assert.equal(nextEvents[0]?.type, "runFailed", "the cancellation marker is consumed once");
});
