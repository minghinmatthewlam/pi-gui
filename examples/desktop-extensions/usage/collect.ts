import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  buildSessionProjection,
  estimateTokens,
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = Parameters<typeof estimateTokens>[0];
import type {
  ContextEstimate,
  ContextGroup,
  ContextKind,
  DayUsage,
  ThreadUsage,
  UsageCounts,
  UsageState,
} from "./contract.ts";
import { addCounts, emptyCounts, emptyKinds, localDayStart } from "./model.ts";

/** Most recently active sessions read per refresh. Older ones are counted as capped. */
export const MAX_SESSIONS = 200;
/** Session files larger than this are skipped and counted as unreadable. */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const LARGEST_GROUPS = 3;

export interface CurrentThread {
  id: string;
  /** Live entries, including any not yet flushed to disk. */
  entries: SessionEntry[];
  name: string | undefined;
  contextNow: ThreadUsage["contextNow"];
}

export interface CollectOptions {
  cwd: string;
  sessionDir?: string;
  current?: CurrentThread;
  modelName?: (provider: string, modelId: string) => string | undefined;
  /** Whether replies from this model are billed to a subscription plan rather than per token. */
  isSubscription?: (provider: string, modelId: string) => boolean;
  now?: number;
  signal?: AbortSignal;
}

export type CollectedUsage = Omit<UsageState, "status" | "error">;

/**
 * Reads every saved pi session for the folder (newest first, bounded) and reduces each to
 * per-day token usage plus an estimate of what fills its current context. Yields between
 * files so a large folder never blocks the Pi process for long.
 */
export async function collectUsage(options: CollectOptions): Promise<CollectedUsage> {
  const infos = await SessionManager.list(
    options.cwd,
    options.sessionDir,
    undefined,
    options.signal,
  );
  const selected = infos.slice(0, MAX_SESSIONS);
  const threads: ThreadUsage[] = [];
  let unreadable = 0;
  let sawCurrent = false;
  for (const info of selected) {
    options.signal?.throwIfAborted();
    const isCurrent = info.id === options.current?.id;
    let entries: SessionEntry[] | undefined;
    if (isCurrent) {
      sawCurrent = true;
      entries = options.current!.entries;
    } else {
      entries = await readEntries(info.path);
      await nextTurn();
    }
    if (!entries) {
      unreadable += 1;
      continue;
    }
    const thread = reduceThread({
      id: info.id,
      title: titleFromSessionInfo(info),
      lastActiveAt: info.modified.getTime(),
      entries,
      current: isCurrent,
      contextNow: isCurrent ? options.current!.contextNow : null,
      modelName: options.modelName,
      isSubscription: options.isSubscription,
    });
    threads.push(thread);
  }
  // A new session is not on disk until its first message; its live entries still count.
  const current = options.current;
  if (current && !sawCurrent && current.entries.some((entry) => entry.type === "message")) {
    const thread = reduceThread({
      id: current.id,
      title: current.name?.trim() || firstUserText(current.entries) || "This thread",
      lastActiveAt: lastActivity(current.entries) ?? options.now ?? Date.now(),
      entries: current.entries,
      current: true,
      contextNow: current.contextNow,
      modelName: options.modelName,
      isSubscription: options.isSubscription,
    });
    threads.unshift(thread);
  }
  return {
    refreshedAt: options.now ?? Date.now(),
    folderName: basename(options.cwd) || options.cwd,
    threads,
    scanned: selected.length,
    unreadable,
    capped: infos.length - selected.length,
  };
}

async function readEntries(path: string): Promise<SessionEntry[] | undefined> {
  try {
    if ((await stat(path)).size > MAX_SESSION_BYTES) return undefined;
    const fileEntries = parseSessionEntries(await readFile(path, "utf8"));
    if (fileEntries[0]?.type !== "session") return undefined;
    migrateSessionEntries(fileEntries);
    return fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  } catch {
    return undefined;
  }
}

/** Matches pi-gui's `titleFromSessionInfo`: the session name, else the first user message. */
export function titleFromSessionInfo(info: SessionInfo): string {
  const name = info.name?.trim();
  if (name) return name;
  const first = truncate(info.firstMessage === "(no messages)" ? "" : info.firstMessage, 72);
  return first || basename(info.cwd || info.path);
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

interface ReduceInput {
  id: string;
  title: string;
  lastActiveAt: number;
  entries: SessionEntry[];
  current: boolean;
  contextNow: ThreadUsage["contextNow"];
  modelName: CollectOptions["modelName"];
  isSubscription?: CollectOptions["isSubscription"];
}

/**
 * Usage sums every entry of the session file, all branches included, exactly as pi's
 * `getSessionStats()` (which pi-gui's usage footer shows): assistant and tool-result usage,
 * usage entries such as cache warming, and compaction/branch-summary calls. Replies from a
 * subscription-backed provider keep their tokens but not pi's list-price cost, as pi-gui's
 * footer treats them.
 */
export function reduceThread(input: ReduceInput): ThreadUsage {
  const days = new Map<number, DayUsage>();
  const outputByModel = new Map<string, { provider: string; model: string; output: number }>();
  let replies = 0;
  const add = (time: number, usage: Parameters<typeof toCounts>[0], subscription = false) => {
    const dayStart = localDayStart(time);
    let day = days.get(dayStart);
    if (!day) {
      day = { dayStart, ...emptyCounts() };
      days.set(dayStart, day);
    }
    const counts = toCounts(usage);
    if (subscription) counts.cost = 0;
    addCounts(day, counts);
  };
  for (const entry of input.entries) {
    const entryTime = Date.parse(entry.timestamp);
    if (entry.type === "usage") add(entryTime, entry.usage);
    else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage)
      add(entryTime, entry.usage);
    if (entry.type !== "message") continue;
    const message = entry.message;
    const time = typeof message.timestamp === "number" ? message.timestamp : entryTime;
    if (message.role === "toolResult" && message.usage) add(time, message.usage);
    if (message.role !== "assistant") continue;
    add(time, message.usage, input.isSubscription?.(message.provider, message.model) ?? false);
    replies += 1;
    const key = `${message.provider}/${message.model}`;
    const tally = outputByModel.get(key) ?? {
      provider: message.provider,
      model: message.model,
      output: 0,
    };
    tally.output += message.usage.output;
    outputByModel.set(key, tally);
  }
  const top = [...outputByModel.values()].sort((a, b) => b.output - a.output)[0];
  return {
    id: input.id,
    title: input.title,
    current: input.current,
    lastActiveAt: input.lastActiveAt,
    model: top ? (input.modelName?.(top.provider, top.model) ?? top.model) : null,
    replies,
    days: [...days.values()].sort((a, b) => a.dayStart - b.dayStart),
    context: estimateContext(input.entries),
    contextNow: input.contextNow,
  };
}

function toCounts(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
}): UsageCounts {
  return {
    input: usage.input || 0,
    output: usage.output || 0,
    cacheRead: usage.cacheRead || 0,
    cacheWrite: usage.cacheWrite || 0,
    cost: usage.cost?.total || 0,
  };
}

/**
 * Estimates what fills the current branch's model context: pi's own compaction-aware,
 * context-edit-aware projection, measured with pi's exported chars/4 `estimateTokens`.
 * Only kinds, tool names, counts and sizes leave this function; never message text.
 */
export function estimateContext(entries: SessionEntry[]): ContextEstimate {
  const byKind = emptyKinds();
  const groups = new Map<string, ContextGroup>();
  const record = (kind: ContextKind, label: string, tokens: number) => {
    if (tokens <= 0) return;
    byKind[kind] += tokens;
    const key = `${kind}\u0000${label}`;
    const group = groups.get(key) ?? { kind, label, count: 0, tokens: 0 };
    group.count += 1;
    group.tokens += tokens;
    groups.set(key, group);
  };
  // Measure one block (or string) through pi's estimator by wrapping it in a message.
  const measure = (role: "user" | "assistant", content: unknown) =>
    estimateTokens({ role, content, timestamp: 0 } as unknown as AgentMessage);

  const messages = buildSessionProjection(entries).messages;
  for (const message of messages) {
    switch (message.role) {
      case "user": {
        if (typeof message.content === "string") {
          record("user", "", measure("user", message.content));
          break;
        }
        const blocks = message.content;
        record(
          "user",
          "",
          measure(
            "user",
            blocks.filter((block) => block.type === "text"),
          ),
        );
        for (const image of blocks.filter((block) => block.type === "image"))
          record("images", "attached", measure("user", [image]));
        break;
      }
      case "assistant": {
        const blocks = message.content;
        record(
          "assistant",
          "",
          measure(
            "assistant",
            blocks.filter((b) => b.type === "text"),
          ),
        );
        record(
          "thinking",
          "",
          measure(
            "assistant",
            blocks.filter((b) => b.type === "thinking"),
          ),
        );
        for (const call of blocks.filter((block) => block.type === "toolCall"))
          record("toolCalls", String(call.name), measure("assistant", [call]));
        break;
      }
      case "toolResult": {
        const blocks = message.content;
        const text = blocks.filter((block) => block.type === "text");
        record("toolResults", message.toolName, measure("user", text));
        for (const image of blocks.filter((block) => block.type === "image"))
          record("images", message.toolName, measure("user", [image]));
        break;
      }
      case "bashExecution":
        if (!message.excludeFromContext) record("toolResults", "bash", estimateTokens(message));
        break;
      case "custom": {
        const content = message.content;
        if (typeof content === "string") {
          record("other", message.customType, measure("user", content));
          break;
        }
        const blocks = content;
        record(
          "other",
          message.customType,
          measure(
            "user",
            blocks.filter((b) => b.type === "text"),
          ),
        );
        for (const image of blocks.filter((block) => block.type === "image"))
          record("images", message.customType, measure("user", [image]));
        break;
      }
      case "compactionSummary":
        record("summaries", "Compaction summary", estimateTokens(message));
        break;
      case "branchSummary":
        record("summaries", "Branch summary", estimateTokens(message));
        break;
      default:
        record("other", message.role, estimateTokens(message));
    }
  }
  const total = Object.values(byKind).reduce((sum, value) => sum + value, 0);
  const largest = [...groups.values()].sort((a, b) => b.tokens - a.tokens);
  return { byKind, total, largest: largest.slice(0, LARGEST_GROUPS) };
}

function firstUserText(entries: SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(" ");
    if (text.trim()) return truncate(text, 72);
  }
  return "";
}

function lastActivity(entries: SessionEntry[]): number | undefined {
  let latest: number | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const { role, timestamp } = entry.message as { role: string; timestamp?: number };
    if (role !== "user" && role !== "assistant") continue;
    const time = typeof timestamp === "number" ? timestamp : Date.parse(entry.timestamp);
    if (Number.isFinite(time)) latest = Math.max(latest ?? 0, time);
  }
  return latest;
}
