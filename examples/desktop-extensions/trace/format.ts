import type { ModelSpan, Run, Span } from "./contract.ts";
import { promptTokens } from "./trace.ts";

export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

export function formatTokens(value: number): string {
  for (const [size, suffix] of [
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
    }
  }
  return String(Math.round(value));
}

export function formatPercent(value: number): string {
  if (value > 0 && value < 0.01) return "<1%";
  return `${Math.round(value * 100)}%`;
}

export function runTitle(run: Run): string {
  return run.kind === "reply" ? `Reply ${run.number}` : `Compaction ${run.number}`;
}

export function spanTitle(span: Span): string {
  switch (span.kind) {
    case "turn":
      return `Turn ${span.number}`;
    case "model":
      return "Model call";
    case "tool":
      return span.tool;
    case "compaction":
      return "Compaction";
  }
}

/** The context a model call sent, as "20.4k · 10%"; "—" when the call reported no tokens. */
export function callContext(span: ModelSpan): string {
  if (!span.usage) return "—";
  const tokens = promptTokens(span.usage);
  return span.contextWindow
    ? `${formatTokens(tokens)} · ${formatPercent(tokens / span.contextWindow)}`
    : formatTokens(tokens);
}

export interface RunTotals {
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  input: number;
  output: number;
  /** The largest context any call sent, with that call's window. */
  peak: ModelSpan | null;
}

export function runTotals(run: Run, now: number): RunTotals {
  const totals: RunTotals = {
    durationMs: (run.endedAt ?? now) - run.startedAt,
    modelCalls: 0,
    toolCalls: 0,
    input: 0,
    output: 0,
    peak: null,
  };
  for (const span of run.spans) {
    if (span.kind === "tool") totals.toolCalls += 1;
    if (span.kind !== "model") continue;
    totals.modelCalls += 1;
    if (!span.usage) continue;
    totals.input += promptTokens(span.usage);
    totals.output += span.usage.output;
    if (!totals.peak?.usage || promptTokens(span.usage) > promptTokens(totals.peak.usage))
      totals.peak = span;
  }
  return totals;
}

/** Spans in tree order with their depth below the run. */
export function treeOrder(run: Run): { span: Span; depth: number }[] {
  const children = new Map<string | null, Span[]>();
  for (const span of run.spans) {
    const siblings = children.get(span.parentId) ?? [];
    siblings.push(span);
    children.set(span.parentId, siblings);
  }
  const rows: { span: Span; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const span of children.get(parentId) ?? []) {
      rows.push({ span, depth });
      visit(span.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** A plain-text outline of a run for the `/trace` command. */
export function outline(run: Run, now: number): string {
  const totals = runTotals(run, now);
  const head = `${runTitle(run)} · ${formatDuration(totals.durationMs)} · ${totals.modelCalls} model ${totals.modelCalls === 1 ? "call" : "calls"} · ${totals.toolCalls} ${totals.toolCalls === 1 ? "tool" : "tools"}${run.endedAt === null ? " · running" : ""}`;
  const lines = treeOrder(run).map(({ span, depth }) => {
    const duration = formatDuration((span.endedAt ?? now) - span.startedAt);
    const extra =
      span.kind === "model"
        ? ` · context ${callContext(span)}`
        : span.kind === "tool" && span.summary
          ? ` ${span.summary}`
          : "";
    const flag =
      span.outcome === "error" ? " · failed" : span.outcome === "aborted" ? " · stopped" : "";
    return `${"  ".repeat(depth + 1)}${spanTitle(span)}${extra} · ${duration}${flag}`;
  });
  return [head, ...lines].join("\n");
}
