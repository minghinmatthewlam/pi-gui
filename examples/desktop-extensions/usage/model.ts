import type { ContextKind, DayUsage, ThreadUsage, UsageCounts } from "./contract.ts";

/** Pure aggregation shared by the browser view and tests. No Node, DOM or Chord access. */

export const CONTEXT_KINDS: readonly ContextKind[] = [
  "toolResults",
  "toolCalls",
  "user",
  "assistant",
  "thinking",
  "images",
  "summaries",
  "other",
];

export type Period = "today" | "7d" | "30d" | "all";
export type SortKey = "share" | "cost" | "recent" | "cacheHit";

export const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

export const SORTS: { id: SortKey; label: string }[] = [
  { id: "share", label: "Share" },
  { id: "cost", label: "Cost" },
  { id: "recent", label: "Recent" },
  { id: "cacheHit", label: "Cache hit" },
];

export const CONTEXT_LABELS: Record<ContextKind, string> = {
  toolResults: "Tool results",
  toolCalls: "Tool calls",
  user: "Your messages",
  assistant: "Agent replies",
  thinking: "Thinking",
  images: "Images",
  summaries: "Summaries",
  other: "Extension messages",
};

/** Singular labels for one context item ("Tool result · read"). */
export const CONTEXT_ITEM_LABELS: Record<ContextKind, string> = {
  toolResults: "Tool result",
  toolCalls: "Tool call",
  user: "Your message",
  assistant: "Agent reply",
  thinking: "Thinking",
  images: "Image",
  summaries: "Summary",
  other: "Extension message",
};

export const LOW_CACHE_HIT = 0.7;

export function emptyCounts(): UsageCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function emptyKinds(): Record<ContextKind, number> {
  return Object.fromEntries(CONTEXT_KINDS.map((kind) => [kind, 0])) as Record<ContextKind, number>;
}

export function addCounts(target: UsageCounts, usage: UsageCounts): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost;
}

/** pi's total: input + output + cache read + cache write. */
export function totalTokens(counts: UsageCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

/** Share of prompt tokens served from cache, or null when nothing was sent. */
export function cacheHitRate(counts: UsageCounts): number | null {
  const prompt = counts.input + counts.cacheRead + counts.cacheWrite;
  return prompt > 0 ? counts.cacheRead / prompt : null;
}

export function localDayStart(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Inclusive start of a period in local days, or null for all time. */
export function periodStart(period: Period, now: number): number | null {
  if (period === "all") return null;
  const days = period === "today" ? 0 : period === "7d" ? 6 : 29;
  const start = new Date(localDayStart(now));
  start.setDate(start.getDate() - days);
  return start.getTime();
}

export function sumDays(days: readonly DayUsage[], since: number | null): UsageCounts {
  const counts = emptyCounts();
  for (const day of days) if (since === null || day.dayStart >= since) addCounts(counts, day);
  return counts;
}

export interface ThreadRow {
  thread: ThreadUsage;
  counts: UsageCounts;
  tokens: number;
  cacheHit: number | null;
  share: number;
  subscription: boolean;
}

export interface FolderSummary {
  rows: ThreadRow[];
  totals: UsageCounts;
  tokens: number;
  cacheHit: number | null;
  subscription: boolean;
  context: Record<ContextKind, number>;
  contextTotal: number;
  model: string | null;
}

export function summarize(
  threads: readonly ThreadUsage[],
  period: Period,
  now: number,
): FolderSummary {
  const since = periodStart(period, now);
  const totals = emptyCounts();
  const context = emptyKinds();
  const models = new Map<string, number>();
  const rows: ThreadRow[] = [];
  for (const thread of threads) {
    const counts = sumDays(thread.days, since);
    const tokens = totalTokens(counts);
    if (tokens === 0) continue;
    addCounts(totals, counts);
    for (const kind of CONTEXT_KINDS) context[kind] += thread.context.byKind[kind];
    if (thread.model) models.set(thread.model, (models.get(thread.model) ?? 0) + tokens);
    rows.push({
      thread,
      counts,
      tokens,
      cacheHit: cacheHitRate(counts),
      share: 0,
      subscription: counts.cost === 0,
    });
  }
  const tokens = totalTokens(totals);
  for (const row of rows) row.share = tokens > 0 ? row.tokens / tokens : 0;
  const model = [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    rows: sortRows(rows, "share"),
    totals,
    tokens,
    cacheHit: cacheHitRate(totals),
    subscription: tokens > 0 && totals.cost === 0,
    context,
    contextTotal: CONTEXT_KINDS.reduce((sum, kind) => sum + context[kind], 0),
    model,
  };
}

export function sortRows(rows: readonly ThreadRow[], key: SortKey): ThreadRow[] {
  const value = (row: ThreadRow): number =>
    key === "share"
      ? row.tokens
      : key === "cost"
        ? row.counts.cost
        : key === "recent"
          ? row.thread.lastActiveAt
          : // Lowest cache hit first: that is what needs attention.
            -(row.cacheHit ?? 1);
  return [...rows].sort(
    (a, b) => value(b) - value(a) || b.thread.lastActiveAt - a.thread.lastActiveAt,
  );
}

export function formatTokens(value: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
    }
  }
  return String(Math.round(value));
}

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  if (value > 0 && value < 0.01) return "<1%";
  return `${Math.round(value * 100)}%`;
}

export function formatCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(value >= 1000 ? 0 : 2)}`;
}

export function formatRelative(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
