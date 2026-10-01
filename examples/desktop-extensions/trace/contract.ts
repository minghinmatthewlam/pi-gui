import { defineService, type ReplicatedState } from "@earendil-works/chord";

/** How a span ended; `null` while it is still open. */
export type Outcome = "ok" | "error" | "aborted";

interface SpanBase {
  id: string;
  /** The span this one runs inside; `null` for spans directly under the run. */
  parentId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: Outcome | null;
}

/** One pass of pi's loop: a model call and the tools it asked for. */
export interface TurnSpan extends SpanBase {
  kind: "turn";
  number: number;
}

/** Tokens as pi records them on the assistant message; cost is the provider-reported USD total. */
export interface CallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** From pi's `context` event (the request is being built) to the assistant `message_end`. */
export interface ModelSpan extends SpanBase {
  kind: "model";
  model: string;
  /** When the provider's first response arrived; the gap before it is waiting on the request. */
  firstResponseAt: number | null;
  contextWindow: number | null;
  /** `null` until the call ends, and for stopped or failed calls that report no tokens. */
  usage: CallUsage | null;
  stopReason: string | null;
  error: string | null;
}

export interface ToolSpan extends SpanBase {
  kind: "tool";
  toolCallId: string;
  tool: string;
  /** The most telling argument, such as a path or command, for the row. */
  summary: string;
  args: string;
  result: string | null;
}

export interface CompactionSpan extends SpanBase {
  kind: "compaction";
  reason: "manual" | "threshold" | "overflow";
  error: string | null;
}

export type Span = TurnSpan | ModelSpan | ToolSpan | CompactionSpan;

/** One reply, from the first `agent_start` to `agent_settled`, or a compaction outside any reply. */
export interface Run {
  id: string;
  kind: "reply" | "compaction";
  number: number;
  startedAt: number;
  endedAt: number | null;
  outcome: Outcome | null;
  /** In start order; a parent always comes before its children. */
  spans: Span[];
  /** Spans left out after the per-run cap. */
  dropped: number;
}

export interface TraceState {
  /** Oldest first; only this thread, only since it opened in this window. */
  runs: Run[];
}

export interface TraceService {
  state: ReplicatedState<TraceState>;
}

export const Trace = defineService<TraceService>("pi-gui.example.trace.v1");
