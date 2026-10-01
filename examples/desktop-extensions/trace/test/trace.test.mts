import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelSpan, Run, ToolSpan } from "../contract.ts";
import { callContext, outline, runTotals, spanTitle, treeOrder } from "../format.ts";
import { MAX_RUNS, MAX_SPANS, RESULT_LIMIT, TraceRecorder, type TraceEvent } from "../trace.ts";

const model = { name: "Fast 1", contextWindow: 200_000 };
const assistant = (stopReason: string, usage: Record<string, unknown> = {}, extra = {}) => ({
  role: "assistant",
  stopReason,
  usage,
  ...extra,
});
const usage = (input: number, cacheRead: number, output: number) => ({
  input,
  cacheRead,
  cacheWrite: 0,
  output,
});

/** Plays events one millisecond step apart, or at the given times. */
function play(recorder: TraceRecorder, events: (TraceEvent | [number, TraceEvent])[], start = 0) {
  let now = start;
  for (const item of events) {
    const [at, event] = Array.isArray(item) ? item : [now + 1, item];
    now = at;
    recorder.record(event, now);
  }
  return now;
}

function toolTurn(id: string, parent?: string): TraceEvent[] {
  return [
    {
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "read",
      args: { path: "notes.txt" },
      ...(parent ? { parentToolCallId: parent } : {}),
    },
    {
      type: "tool_execution_end",
      toolCallId: id,
      result: { content: [{ type: "text", text: "hello" }] },
      isError: false,
    },
  ];
}

const tree = (run: Run) =>
  treeOrder(run).map(({ span, depth }) => `${"  ".repeat(depth)}${spanTitle(span)}`);

await test("one reply with a tool call becomes Run › Turn › Model call, tool › Turn › Model call", () => {
  const recorder = new TraceRecorder();
  play(recorder, [
    [1_000, { type: "agent_start" }],
    [1_000, { type: "turn_start" }],
    [1_010, { type: "context", model }],
    [1_400, { type: "message_start", message: assistant("") }],
    [1_900, { type: "message_end", message: assistant("toolUse", usage(1_000, 9_000, 50)) }],
    [1_910, toolTurn("read-1")[0]!],
    [1_950, toolTurn("read-1")[1]!],
    [1_960, { type: "turn_start" }],
    [1_970, { type: "context", model }],
    [2_500, { type: "message_end", message: assistant("stop", usage(1_200, 10_800, 80)) }],
    [2_520, { type: "agent_end" }],
    [2_600, { type: "agent_settled" }],
  ]);
  const [run] = recorder.snapshot().runs;
  assert.ok(run);
  assert.deepEqual(tree(run), ["Turn 1", "  Model call", "  read", "Turn 2", "  Model call"]);
  assert.equal(run.endedAt, 2_600);
  assert.equal(run.outcome, "ok");
  const [first, second] = run.spans.filter((span): span is ModelSpan => span.kind === "model");
  assert.equal(first!.startedAt, 1_010);
  assert.equal(first!.firstResponseAt, 1_400);
  assert.equal(first!.endedAt, 1_900);
  assert.equal(callContext(first!), "10k · 5%");
  // With no separate first-response event, the end of the reply counts as the first response.
  assert.equal(second!.firstResponseAt, 2_500);
  assert.equal(callContext(second!), "12k · 6%");
  const tool = run.spans.find((span): span is ToolSpan => span.kind === "tool")!;
  assert.equal(tool.summary, "notes.txt");
  assert.equal(tool.result, "hello");
  assert.equal(tool.outcome, "ok");
  const totals = runTotals(run, 3_000);
  assert.equal(totals.durationMs, 1_600);
  assert.equal(totals.modelCalls, 2);
  assert.equal(totals.toolCalls, 1);
  assert.equal(totals.input, 22_000);
  assert.equal(totals.peak, second);
  assert.equal(
    outline(run, 3_000),
    [
      "Reply 1 · 1.6s · 2 model calls · 1 tool",
      "  Turn 1 · 960ms",
      "    Model call · context 10k · 5% · 890ms",
      "    read notes.txt · 40ms",
      "  Turn 2 · 560ms",
      "    Model call · context 12k · 6% · 530ms",
    ].join("\n"),
  );
});

await test("a retried reply is one run with turns numbered across passes", () => {
  const recorder = new TraceRecorder();
  play(recorder, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "context", model },
    { type: "message_start", message: assistant("error") },
    { type: "message_end", message: assistant("error", {}, { errorMessage: "overloaded" }) },
    { type: "agent_end" },
    // pi retries with agent.continue(): a new pass, same reply.
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "context", model },
    { type: "message_end", message: assistant("stop", usage(100, 0, 10)) },
    { type: "agent_end" },
    { type: "agent_settled" },
  ]);
  const { runs } = recorder.snapshot();
  assert.equal(runs.length, 1);
  assert.deepEqual(tree(runs[0]!), ["Turn 1", "  Model call", "Turn 2", "  Model call"]);
  const failed = runs[0]!.spans.find((span): span is ModelSpan => span.kind === "model")!;
  assert.equal(failed.outcome, "error");
  assert.equal(failed.error, "overloaded");
  assert.equal(callContext(failed), "—");
  assert.equal(runs[0]!.spans[0]!.outcome, "error");
  assert.equal(runs[0]!.outcome, "ok");
});

await test("open spans stay open live and close as stopped when the reply settles", () => {
  const recorder = new TraceRecorder();
  play(recorder, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "context", model },
    { type: "message_end", message: assistant("toolUse", usage(10, 0, 1)) },
    toolTurn("bash-1")[0]!,
  ]);
  const live = recorder.snapshot().runs[0]!;
  assert.equal(live.endedAt, null);
  assert.deepEqual(live.spans.filter((span) => span.endedAt === null).map(spanTitle), [
    "Turn 1",
    "read",
  ]);
  // The published copy does not change as the recorder moves on.
  play(recorder, [{ type: "agent_end" }, { type: "agent_settled" }], 100);
  assert.equal(live.endedAt, null);
  const settled = recorder.snapshot().runs[0]!;
  assert.ok(settled.spans.every((span) => span.endedAt !== null));
  assert.equal(settled.spans.find((span) => span.kind === "tool")!.outcome, "aborted");
  assert.equal(settled.outcome, "ok");
});

await test("a stopped reply ends aborted and keeps unknown context as a dash", () => {
  const recorder = new TraceRecorder();
  play(recorder, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "context", model },
    { type: "message_end", message: assistant("aborted", usage(0, 0, 0)) },
    { type: "agent_end" },
    { type: "agent_settled" },
  ]);
  const run = recorder.snapshot().runs[0]!;
  assert.equal(run.outcome, "aborted");
  assert.equal(callContext(run.spans[1] as ModelSpan), "—");
});

await test("nested tool calls sit under the tool that made them; parallel ends match by id", () => {
  const recorder = new TraceRecorder();
  play(recorder, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "code-1", toolName: "code", args: {} },
    {
      type: "tool_execution_start",
      toolCallId: "a",
      toolName: "read",
      args: { path: "a" },
      parentToolCallId: "code-1",
    },
    {
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "grep",
      args: { pattern: "x" },
      parentToolCallId: "code-1",
    },
    { type: "tool_execution_end", toolCallId: "b", result: "", isError: true },
    { type: "tool_execution_end", toolCallId: "a", result: "", isError: false },
    {
      type: "tool_execution_end",
      toolCallId: "code-1",
      result: "x".repeat(RESULT_LIMIT + 50),
      isError: false,
    },
  ]);
  const run = recorder.snapshot().runs[0]!;
  assert.deepEqual(tree(run), ["Turn 1", "  code", "    read", "    grep"]);
  const [, code, read, grep] = run.spans as [unknown, ToolSpan, ToolSpan, ToolSpan];
  assert.equal(grep.outcome, "error");
  assert.ok(grep.endedAt! < read.endedAt!);
  assert.equal(code.result!.length, RESULT_LIMIT + 1);
});

await test("compaction joins the open reply, or stands alone and closes on failure", () => {
  const recorder = new TraceRecorder();
  play(recorder, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "agent_end" },
    { type: "session_before_compact", reason: "threshold" },
    { type: "session_compact" },
    { type: "agent_settled" },
    { type: "session_before_compact", reason: "manual" },
    { type: "session_compact_failed", aborted: false, errorMessage: "summary failed" },
  ]);
  const [reply, manual] = recorder.snapshot().runs;
  assert.deepEqual(tree(reply!), ["Turn 1", "Compaction"]);
  assert.equal(reply!.spans[1]!.outcome, "ok");
  assert.equal(manual!.kind, "compaction");
  assert.equal(manual!.number, 1);
  assert.equal(manual!.outcome, "error");
  assert.notEqual(manual!.endedAt, null);
  assert.equal(
    manual!.spans[0]!.kind === "compaction" && manual!.spans[0]!.error,
    "summary failed",
  );
});

await test("shutdown closes everything; runs and spans are capped", () => {
  const recorder = new TraceRecorder();
  play(recorder, [{ type: "agent_start" }, { type: "turn_start" }, { type: "context", model }]);
  play(recorder, [{ type: "session_shutdown" }], 50);
  const run = recorder.snapshot().runs[0]!;
  assert.equal(run.endedAt, 51);
  assert.ok(run.spans.every((span) => span.outcome === "aborted"));

  const capped = new TraceRecorder();
  let now = 0;
  for (let index = 0; index < MAX_RUNS + 3; index += 1)
    now = play(capped, [{ type: "agent_start" }, { type: "agent_settled" }], now);
  const runs = capped.snapshot().runs;
  assert.equal(runs.length, MAX_RUNS);
  assert.equal(runs.at(-1)!.number, MAX_RUNS + 3);

  const busy = new TraceRecorder();
  play(busy, [{ type: "agent_start" }, { type: "turn_start" }]);
  for (let index = 0; index < MAX_SPANS + 5; index += 1)
    play(busy, toolTurn(`t${index}`), index * 10);
  const big = busy.snapshot().runs[0]!;
  assert.equal(big.spans.length, MAX_SPANS);
  assert.equal(big.dropped, 6);
});

await test("calls that fail before an answer show their error and no first response", () => {
  const recorder = new TraceRecorder();
  play(recorder, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "context", model },
    // The provider never answered: pi starts and ends the call with its error message.
    { type: "message_start", message: assistant("error", {}, { errorMessage: "429" }) },
    { type: "message_end", message: assistant("error", {}, { errorMessage: "429" }) },
    { type: "agent_end" },
    { type: "agent_start" },
    { type: "turn_start" },
    // Preparing the request failed, so no context event came before the error.
    { type: "message_start", message: assistant("error", {}, { errorMessage: "no route" }) },
    { type: "message_end", message: assistant("error", {}, { errorMessage: "no route" }) },
    { type: "agent_end" },
    { type: "agent_settled" },
  ]);
  const run = recorder.snapshot().runs[0]!;
  const calls = run.spans.filter((span): span is ModelSpan => span.kind === "model");
  assert.deepEqual(
    calls.map((call) => [call.error, call.firstResponseAt, call.outcome]),
    [
      ["429", null, "error"],
      ["no route", null, "error"],
    ],
  );
  assert.equal(run.outcome, "error");
});

await test("the model that answered names the call and sets its window", () => {
  const recorder = new TraceRecorder();
  play(recorder, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "context", model: { name: "Auto", contextWindow: 1_000_000 } },
    {
      type: "message_end",
      message: assistant("stop", usage(50_000, 0, 10)),
      model: { name: "Fast 1", contextWindow: 200_000 },
    },
    { type: "agent_end" },
    // A threshold compaction that fails after a good answer does not fail the reply.
    { type: "session_before_compact", reason: "threshold" },
    { type: "session_compact_failed", aborted: false, errorMessage: "summary failed" },
    { type: "agent_settled" },
  ]);
  const run = recorder.latest()!;
  const call = run.spans.find((span): span is ModelSpan => span.kind === "model")!;
  assert.equal(call.model, "Fast 1");
  assert.equal(callContext(call), "50k · 25%");
  assert.equal(run.outcome, "ok");
  // Finished runs are copied once and reused.
  assert.equal(recorder.snapshot().runs[0], recorder.snapshot().runs[0]);
});
