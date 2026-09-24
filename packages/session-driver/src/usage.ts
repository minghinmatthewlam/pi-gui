import type { Timestamp } from "./types.js";

/** Token counts in one of pi's usage buckets. */
export interface SessionTokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface SessionContextUsage {
  /** Tokens the next request will carry; null right after compaction until the model replies. */
  readonly tokens: number | null;
  readonly contextWindow: number;
  /** Token count at which pi compacts automatically; absent when auto-compaction is off. */
  readonly compactAtTokens?: number;
}

/**
 * What is known about the provider's prompt cache for the current model. Both
 * times are absolute so readers can count down without new snapshots; pi can
 * stop warming without an event, so a past `nextRefreshAt` means no refresh is
 * coming and `expiresAt` applies.
 */
export interface SessionPromptCache {
  /** When the entry lapses unless touched; absent when the model declares no cache lifetime. */
  readonly expiresAt?: Timestamp;
  /** When pi's cache warmer plans its next refresh; absent when warming is not scheduled. */
  readonly nextRefreshAt?: Timestamp;
}

/** One provider-reported plan limit window, such as a 5-hour or weekly limit. */
export interface SessionPlanLimit {
  readonly windowMinutes: number;
  readonly usedPercent: number;
  readonly resetsAt?: Timestamp;
}

export interface SessionPlanLimits {
  readonly provider: string;
  readonly limits: readonly SessionPlanLimit[];
  readonly reportedAt: Timestamp;
}

/** Context, cache and usage for one session, read from pi at turn boundaries. */
export interface SessionUsageSnapshot {
  readonly context?: SessionContextUsage;
  /** Prompt tokens of the latest reply, for the cache hit rate. */
  readonly lastTurn?: SessionTokenCounts;
  readonly cache: SessionPromptCache;
  /** Totals for the whole session, including compaction and cache-warming requests. */
  readonly totals: SessionTokenCounts & { readonly cost: number };
  /** True when the provider bills through a subscription, so `totals.cost` is not money spent. */
  readonly subscription: boolean;
  readonly planLimits?: SessionPlanLimits;
}
