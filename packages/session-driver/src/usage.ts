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
 * What is known about the provider's prompt cache for this session's last request.
 * - `warming`: pi is keeping it alive and sends a refresh at `nextRefreshAt`.
 * - `expires`: the model declares a cache lifetime; the entry lapses at `expiresAt`.
 * - `unknown`: the model does not declare a lifetime, so expiry cannot be shown.
 */
export type SessionPromptCacheState =
  | { readonly kind: "warming"; readonly nextRefreshAt: Timestamp }
  | { readonly kind: "expires"; readonly expiresAt: Timestamp }
  | { readonly kind: "unknown" };

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
  readonly cache: SessionPromptCacheState;
  /** Totals for the whole session, including compaction and cache-warming requests. */
  readonly totals: SessionTokenCounts & { readonly cost: number };
  /** True when the provider bills through a subscription, so `totals.cost` is not money spent. */
  readonly subscription: boolean;
  readonly planLimits?: SessionPlanLimits;
}
