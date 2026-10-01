import type {
  CallUsage,
  CompactionSpan,
  ModelSpan,
  Outcome,
  Run,
  Span,
  ToolSpan,
  TraceState,
  TurnSpan,
} from "./contract.ts";

export const MAX_RUNS = 20;
export const MAX_SPANS = 400;
export const ARGS_LIMIT = 1_000;
export const RESULT_LIMIT = 2_000;

export interface ModelFacts {
  name: string;
  contextWindow: number | null;
}

/** The pi events the trace listens to, reduced to what it keeps. */
export type TraceEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "context"; model: ModelFacts }
  | { type: "message_start"; message: unknown }
  /** `model` is the model that answered, when known; routed models can differ from the selected one. */
  | { type: "message_end"; message: unknown; model?: ModelFacts }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
      parentToolCallId?: string;
    }
  | { type: "tool_execution_end"; toolCallId: string; result: unknown; isError: boolean }
  | { type: "agent_end" }
  | { type: "agent_settled" }
  | { type: "session_before_compact"; reason: CompactionSpan["reason"] }
  | { type: "session_compact" }
  | { type: "session_compact_failed"; errorMessage?: string; aborted: boolean }
  | { type: "session_shutdown" };

/**
 * Turns pi's agent events into a span tree per reply.
 *
 * One reply can be several passes of pi's loop (retries, overflow recovery, queued messages,
 * continuations); each pass has its own `agent_start`/`agent_end`, so a run lasts from the first
 * `agent_start` to `agent_settled`, and turns are numbered here rather than taken from pi.
 */
export class TraceRecorder {
  private runs: Run[] = [];
  private count = 0;
  private numbers = { reply: 0, compaction: 0 };
  private run: Run | null = null;
  private turns = 0;
  private turn: TurnSpan | null = null;
  private model: ModelSpan | null = null;
  private tools = new Map<string, ToolSpan>();
  private compaction: CompactionSpan | null = null;
  private spanCount = 0;
  /** Copies of finished runs, which never change again, so a snapshot only copies the open run. */
  private copies = new WeakMap<Run, Run>();

  /** A copy safe to publish: plain JSON with no references into the recorder. */
  snapshot(): TraceState {
    return { runs: this.runs.map((run) => this.copy(run)) };
  }

  /** A copy of the newest run, reply or compaction. */
  latest(): Run | undefined {
    const run = this.runs.at(-1);
    return run && this.copy(run);
  }

  private copy(run: Run): Run {
    if (run.endedAt === null) return structuredClone(run);
    let copy = this.copies.get(run);
    if (!copy) {
      copy = structuredClone(run);
      this.copies.set(run, copy);
    }
    return copy;
  }

  record(event: TraceEvent, now: number): void {
    switch (event.type) {
      case "agent_start":
        if (this.run?.kind === "compaction") this.endRun(now);
        this.run ??= this.openRun("reply", now);
        return;
      case "turn_start": {
        // No turn_end handler: one makes pi build the session context for it on every turn.
        // A turn ends when the next one starts or the pass ends.
        const run = this.run ?? (this.run = this.openRun("reply", now));
        this.endTurn(now);
        this.turns += 1;
        this.turn = this.add<TurnSpan>(run, {
          kind: "turn",
          number: this.turns,
          parentId: null,
          startedAt: now,
        });
        return;
      }
      case "context": {
        const run = this.run;
        if (!run) return;
        this.endModel(now, "aborted");
        this.model = this.add<ModelSpan>(run, {
          kind: "model",
          parentId: this.turn?.id ?? null,
          startedAt: now,
          model: event.model.name,
          contextWindow: event.model.contextWindow,
          firstResponseAt: null,
          usage: null,
          stopReason: null,
          error: null,
        });
        return;
      }
      case "message_start":
        // A call that fails before the provider answers starts and ends with its error message.
        if (isAssistant(event.message) && !failed(event.message) && this.model)
          this.model.firstResponseAt ??= now;
        return;
      case "message_end": {
        const message = event.message;
        if (!isAssistant(message)) return;
        // A failure while preparing the request (before `context`) still gets a span, so its error shows.
        const model = this.model ?? (failed(message) ? this.failedCall(now) : null);
        if (!model) return;
        this.model = model;
        if (!failed(message)) model.firstResponseAt ??= now;
        if (event.model) {
          model.model = event.model.name;
          model.contextWindow = event.model.contextWindow;
        }
        model.stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
        model.error = typeof message.errorMessage === "string" ? message.errorMessage : null;
        model.usage = callUsage(message.usage, model.stopReason);
        this.endModel(now, outcomeOf(model.stopReason));
        return;
      }
      case "tool_execution_start": {
        const run = this.run;
        if (!run) return;
        const parent = event.parentToolCallId ? this.tools.get(event.parentToolCallId) : undefined;
        const span = this.add<ToolSpan>(run, {
          kind: "tool",
          parentId: parent?.id ?? this.turn?.id ?? null,
          startedAt: now,
          toolCallId: event.toolCallId,
          tool: event.toolName,
          summary: summarizeArgs(event.args),
          args: preview(stringify(event.args), ARGS_LIMIT),
          result: null,
        });
        if (span) this.tools.set(event.toolCallId, span);
        return;
      }
      case "tool_execution_end": {
        const span = this.tools.get(event.toolCallId);
        if (!span) return;
        span.result = preview(resultText(event.result), RESULT_LIMIT);
        close(span, now, event.isError ? "error" : "ok");
        this.tools.delete(event.toolCallId);
        return;
      }
      case "agent_end":
        // A pass is over; anything it left open was cut short. The run waits for agent_settled.
        this.endTurn(now);
        return;
      case "session_before_compact": {
        this.endCompaction(now, "aborted", null);
        const run = this.run ?? this.openRun("compaction", now);
        this.compaction = this.add<CompactionSpan>(run, {
          kind: "compaction",
          parentId: null,
          startedAt: now,
          reason: event.reason,
          error: null,
        });
        if (run.kind === "compaction") this.run = run;
        return;
      }
      case "session_compact":
        this.endCompaction(now, "ok", null);
        return;
      case "session_compact_failed":
        this.endCompaction(
          now,
          event.aborted ? "aborted" : "error",
          event.aborted ? null : (event.errorMessage ?? null),
        );
        return;
      case "agent_settled":
        if (this.run?.kind === "reply") this.endRun(now);
        return;
      case "session_shutdown":
        this.endCompaction(now, "aborted", null);
        if (this.run) this.endRun(now);
        return;
    }
  }

  private openRun(kind: Run["kind"], now: number): Run {
    this.count += 1;
    this.numbers[kind] += 1;
    const run: Run = {
      id: `run-${this.count}`,
      kind,
      number: this.numbers[kind],
      startedAt: now,
      endedAt: null,
      outcome: null,
      spans: [],
      dropped: 0,
    };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    this.turns = 0;
    return run;
  }

  /** Adds a span unless the run is at its cap; returns it so the caller can track it. */
  private add<T extends Span>(run: Run, fields: Omit<T, "id" | "endedAt" | "outcome">): T | null {
    if (run.spans.length >= MAX_SPANS) {
      run.dropped += 1;
      return null;
    }
    this.spanCount += 1;
    const span = { ...fields, id: `span-${this.spanCount}`, endedAt: null, outcome: null } as T;
    run.spans.push(span);
    return span;
  }

  private endModel(now: number, outcome: Outcome) {
    if (this.model) close(this.model, now, outcome);
    this.model = null;
  }

  private failedCall(now: number): ModelSpan | null {
    if (!this.run) return null;
    return this.add<ModelSpan>(this.run, {
      kind: "model",
      parentId: this.turn?.id ?? null,
      startedAt: now,
      model: "Model",
      contextWindow: null,
      firstResponseAt: null,
      usage: null,
      stopReason: null,
      error: null,
    });
  }

  /** Closes the open turn and whatever ran inside it; the turn ends however its model call did. */
  private endTurn(now: number) {
    this.endModel(now, "aborted");
    for (const span of this.tools.values()) close(span, now, "aborted");
    this.tools.clear();
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    const call = this.run
      ? lastOf(this.run.spans, (span) => span.kind === "model" && span.parentId === turn.id)
      : undefined;
    close(turn, now, call?.outcome ?? "aborted");
  }

  private endCompaction(now: number, outcome: Outcome, error: string | null) {
    const span = this.compaction;
    if (!span) return;
    this.compaction = null;
    span.error = error;
    close(span, now, outcome);
    if (this.run?.kind === "compaction") this.endRun(now);
  }

  private endRun(now: number) {
    const run = this.run;
    if (!run) return;
    this.endTurn(now);
    this.run = null;
    this.endCompaction(now, "aborted", null);
    // A reply ends however its last model call did; a compaction on its own, however it did.
    const last = lastOf(
      run.spans,
      (span) => span.kind === (run.kind === "reply" ? "model" : "compaction"),
    );
    for (const span of run.spans) close(span, now, "aborted");
    run.endedAt = now;
    run.outcome = last?.outcome ?? "ok";
  }
}

/** Prompt tokens sent on a call: everything the model read, cached or not. */
export function promptTokens(usage: CallUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function lastOf(spans: Span[], match: (span: Span) => boolean): Span | undefined {
  for (let index = spans.length - 1; index >= 0; index -= 1)
    if (match(spans[index]!)) return spans[index];
  return undefined;
}

function close(span: Span, now: number, outcome: Outcome) {
  if (span.endedAt !== null) return;
  span.endedAt = now;
  span.outcome = outcome;
}

function failed(message: AssistantMessage): boolean {
  return message.stopReason === "error" || message.stopReason === "aborted";
}

function outcomeOf(stopReason: unknown): Outcome {
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "error") return "error";
  return "ok";
}

/** Stopped or failed calls that report no tokens show as unknown, as pi's own totals skip them. */
function callUsage(value: unknown, stopReason: string | null): CallUsage | null {
  if (!isRecord(value)) return null;
  const usage = {
    input: count(value.input),
    output: count(value.output),
    cacheRead: count(value.cacheRead),
    cacheWrite: count(value.cacheWrite),
  };
  const empty = promptTokens(usage) + usage.output === 0;
  return empty && (stopReason === "aborted" || stopReason === "error") ? null : usage;
}

const SUMMARY_KEYS = ["path", "file_path", "command", "pattern", "query", "url", "kind", "number"];

export function summarizeArgs(args: unknown): string {
  if (!isRecord(args)) return typeof args === "string" ? oneLine(args) : "";
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string" || typeof value === "number") return oneLine(String(value));
  }
  const first = Object.values(args).find((value) => typeof value === "string");
  return typeof first === "string" ? oneLine(first) : "";
}

/** The text a tool returned, as pi's tool results carry it. */
export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (isRecord(result) && Array.isArray(result.content)) {
    return result.content
      .map((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? block.text
          : isRecord(block) && block.type === "image"
            ? "[image]"
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return stringify(result);
}

export function preview(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function stringify(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function oneLine(text: string): string {
  return preview(text.replace(/\s+/g, " ").trim(), 120);
}

interface AssistantMessage {
  role: "assistant";
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: unknown;
}

function isAssistant(message: unknown): message is AssistantMessage {
  return isRecord(message) && message.role === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
