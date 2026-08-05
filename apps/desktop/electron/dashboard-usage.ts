// Dashboard usage aggregation: scans pi session JSONL transcripts under
// ~/.pi/agent/sessions and aggregates token/cost usage by day, ISO week, and
// year, plus per-period model breakdowns.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DashboardPeriodModels,
  DashboardUsageByDay,
  DashboardUsageByModel,
  DashboardUsagePeriodKind,
  DashboardUsageSnapshot,
  DashboardUsageTotals,
} from "../src/ipc";

interface UsageFields {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
}

interface SessionMessage {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly usage?: unknown;
}

interface MessageEvent {
  readonly type?: unknown;
  readonly timestamp?: unknown;
  readonly message?: SessionMessage;
}

interface ParsedUsageEvent {
  readonly day: string;
  readonly week: string;
  readonly year: string;
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly reasoning: number;
  readonly cost: number;
}

interface MutableBucket {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cost: number;
}

interface MutableModel {
  model: string;
  provider: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cost: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function sessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

function listSessionFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, String(entry.name));
    if (entry.isDirectory()) {
      listSessionFiles(full, out);
    } else if (entry.isFile() && String(entry.name).endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out.sort();
}

function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function mondayOf(date: Date): Date {
  const d = new Date(date.getTime());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Per-file parsed-event cache. A session transcript is appended to while a
// conversation streams, so the cache key is (mtimeMs, size) per file rather
// than a whole-tree signature — only files that changed since the last read
// get re-parsed, and deleted files are pruned.
const fileCache = new Map<string, { mtimeMs: number; size: number; events: ParsedUsageEvent[] }>();

function parseFileEvents(file: string): ParsedUsageEvent[] {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: ParsedUsageEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.includes('"totalTokens"')) {
      continue;
    }
    let event: MessageEvent;
    try {
      event = JSON.parse(line) as MessageEvent;
    } catch {
      continue;
    }
    if (event.type !== "message") {
      continue;
    }
    const message = event.message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const usage = message.usage as UsageFields | undefined;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    const input = numberOrZero(usage.input);
    const output = numberOrZero(usage.output);
    const cacheRead = numberOrZero(usage.cacheRead);
    const reasoning = numberOrZero(usage.reasoning);
    const totalTokens = numberOrZero(usage.totalTokens);
    const cost = numberOrZero(usage.cost?.total);
    if (totalTokens === 0 && cost === 0) {
      continue;
    }
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    events.push({
      day: dateKey(date),
      week: dateKey(mondayOf(date)),
      year: String(date.getFullYear()),
      provider: typeof message.provider === "string" ? message.provider : "unknown",
      model: typeof message.model === "string" ? message.model : "unknown",
      input,
      output,
      cacheRead,
      reasoning,
      cost,
    });
  }
  return events;
}

function getEvents(): ParsedUsageEvent[] {
  const root = sessionsRoot();
  const files = listSessionFiles(root);
  const seen = new Set<string>();
  const events: ParsedUsageEvent[] = [];
  for (const file of files) {
    seen.add(file);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const cached = fileCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      events.push(...cached.events);
      continue;
    }
    const parsed = parseFileEvents(file);
    fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events: parsed });
    events.push(...parsed);
  }
  for (const key of fileCache.keys()) {
    if (!seen.has(key)) {
      fileCache.delete(key);
    }
  }
  return events;
}

function bucketToSnapshot(bucket: MutableBucket): DashboardUsageByDay {
  return {
    date: bucket.date,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    reasoningTokens: bucket.reasoningTokens,
    cost: Math.round(bucket.cost * 10000) / 10000,
  };
}

function collectBuckets(
  events: readonly ParsedUsageEvent[],
  select: (event: ParsedUsageEvent) => string,
): DashboardUsageByDay[] {
  const map = new Map<string, MutableBucket>();
  for (const event of events) {
    const key = select(event);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { date: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0 };
      map.set(key, bucket);
    }
    bucket.inputTokens += event.input;
    bucket.outputTokens += event.output;
    bucket.cacheReadTokens += event.cacheRead;
    bucket.reasoningTokens += event.reasoning;
    bucket.cost += event.cost;
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).map(bucketToSnapshot);
}

export function readDashboardUsage(): DashboardUsageSnapshot {
  const events = getEvents();

  const days = collectBuckets(events, (event) => event.day);
  const weeks = collectBuckets(events, (event) => event.week);
  const years = collectBuckets(events, (event) => event.year);

  const modelMap = new Map<string, MutableModel>();
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0 };
  for (const event of events) {
    totals.inputTokens += event.input;
    totals.outputTokens += event.output;
    totals.cacheReadTokens += event.cacheRead;
    totals.reasoningTokens += event.reasoning;
    totals.cost += event.cost;
    const modelKey = `${event.provider}/${event.model}`;
    let entry = modelMap.get(modelKey);
    if (!entry) {
      entry = { model: event.model, provider: event.provider, messages: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0 };
      modelMap.set(modelKey, entry);
    }
    entry.messages += 1;
    entry.inputTokens += event.input;
    entry.outputTokens += event.output;
    entry.reasoningTokens += event.reasoning;
    entry.cost += event.cost;
  }

  const byModel = [...modelMap.values()]
    .sort((a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens + b.reasoningTokens - (a.inputTokens + a.outputTokens + a.reasoningTokens))
    .slice(0, 10)
    .map((entry) => ({
      model: entry.model,
      provider: entry.provider,
      messages: entry.messages,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      reasoningTokens: entry.reasoningTokens,
      cost: Math.round(entry.cost * 10000) / 10000,
    }));

  return {
    days,
    weeks,
    years,
    totals: {
      inputTokens: Math.round(totals.inputTokens),
      outputTokens: Math.round(totals.outputTokens),
      cacheReadTokens: Math.round(totals.cacheReadTokens),
      reasoningTokens: Math.round(totals.reasoningTokens),
      cost: Math.round(totals.cost * 10000) / 10000,
    },
    byModel,
  };
}

export function readDashboardUsageForPeriod(
  kind: DashboardUsagePeriodKind,
  key: string,
): DashboardPeriodModels {
  const events = getEvents();
  const filtered = events.filter((event) =>
    kind === "day" ? event.day === key : kind === "week" ? event.week === key : event.year === key,
  );

  const modelMap = new Map<string, MutableModel>();
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0 };
  for (const event of filtered) {
    totals.inputTokens += event.input;
    totals.outputTokens += event.output;
    totals.cacheReadTokens += event.cacheRead;
    totals.reasoningTokens += event.reasoning;
    totals.cost += event.cost;
    const modelKey = `${event.provider}/${event.model}`;
    let entry = modelMap.get(modelKey);
    if (!entry) {
      entry = { model: event.model, provider: event.provider, messages: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0 };
      modelMap.set(modelKey, entry);
    }
    entry.messages += 1;
    entry.inputTokens += event.input;
    entry.outputTokens += event.output;
    entry.reasoningTokens += event.reasoning;
    entry.cost += event.cost;
  }

  return {
    kind,
    key,
    models: [...modelMap.values()]
      .sort((a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens + b.reasoningTokens - (a.inputTokens + a.outputTokens + a.reasoningTokens))
      .map((entry) => ({
        model: entry.model,
        provider: entry.provider,
        messages: entry.messages,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        reasoningTokens: entry.reasoningTokens,
        cost: Math.round(entry.cost * 10000) / 10000,
      })),
    totals: {
      inputTokens: Math.round(totals.inputTokens),
      outputTokens: Math.round(totals.outputTokens),
      cacheReadTokens: Math.round(totals.cacheReadTokens),
      reasoningTokens: Math.round(totals.reasoningTokens),
      cost: Math.round(totals.cost * 10000) / 10000,
    },
  };
}
