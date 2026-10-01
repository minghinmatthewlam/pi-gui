import { defineService, type Context, type ReplicatedState } from "@earendil-works/chord";

/** Token counts as pi records them on assistant messages; cost is the provider-reported USD total. */
export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** One thread's usage for one local calendar day, keyed by that day's local midnight (ms). */
export interface DayUsage extends UsageCounts {
  dayStart: number;
}

export type ContextKind =
  | "toolResults"
  | "toolCalls"
  | "user"
  | "assistant"
  | "thinking"
  | "images"
  | "summaries"
  | "other";

/** A group of same-kind items in a thread's current context, described without their text. */
export interface ContextGroup {
  kind: ContextKind;
  /** Short, content-free label such as "read" (tool name) or "Compaction summary"; empty for plain text. */
  label: string;
  count: number;
  tokens: number;
}

/** Estimated composition of a thread's current branch context (pi's chars/4 heuristic). */
export interface ContextEstimate {
  byKind: Record<ContextKind, number>;
  total: number;
  largest: ContextGroup[];
}

export interface ThreadUsage {
  id: string;
  title: string;
  current: boolean;
  /** pi's last user/assistant activity for the session (ms). */
  lastActiveAt: number;
  /** Display name of the model that produced the most output, or null when none replied. */
  model: string | null;
  /** Total assistant replies with usage; zero-cost replies mean a subscription provider. */
  replies: number;
  days: DayUsage[];
  context: ContextEstimate;
  /** Only for the thread that hosts this view: pi's own context usage for the active model. */
  contextNow: { tokens: number | null; contextWindow: number } | null;
}

export interface UsageState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  refreshedAt: number | null;
  folderName: string;
  threads: ThreadUsage[];
  /** Session files considered, files that could not be read, and files left out by the cap. */
  scanned: number;
  unreadable: number;
  capped: number;
}

export interface UsageService {
  state: ReplicatedState<UsageState>;
  refresh(request: Record<string, never>, context: Context): Promise<void>;
}

export const Usage = defineService<UsageService>("pi-gui.example.usage.v1");
