import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
  SessionPlanLimit,
  SessionPlanLimits,
  SessionPromptCacheState,
  SessionTokenCounts,
  SessionUsageSnapshot,
} from "@pi-gui/session-driver";

/**
 * Reads context, cache and usage from pi at a turn boundary. pi owns every
 * number here; this only reshapes it for the desktop contract.
 */
export function readSessionUsage(
  session: AgentSession,
  planLimits: SessionPlanLimits | undefined,
): SessionUsageSnapshot | undefined {
  const model = session.model;
  if (!model) return undefined;

  const contextUsage = session.getContextUsage();
  const compaction = session.settingsManager.getCompactionSettings(model);
  const stats = session.getSessionStats();
  const branch = session.sessionManager.getBranch();

  return {
    ...(contextUsage
      ? {
          context: {
            tokens: contextUsage.tokens,
            contextWindow: contextUsage.contextWindow,
            ...(compaction.enabled && contextUsage.contextWindow > compaction.reserveTokens
              ? { compactAtTokens: contextUsage.contextWindow - compaction.reserveTokens }
              : {}),
          },
        }
      : {}),
    ...withLastTurn(latestAssistantUsage(branch)),
    cache: promptCacheState(session, branch),
    totals: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      cost: stats.cost,
    },
    // Kimi Coding is subscription-backed despite API-key auth; pi's footer special-cases it too.
    subscription:
      model.provider === "kimi-coding" || session.modelRuntime.isUsingSubscription(model.provider),
    ...(planLimits && planLimits.provider === model.provider ? { planLimits } : {}),
  };
}

type BranchEntry = ReturnType<AgentSession["sessionManager"]["getBranch"]>[number];

interface AssistantUsage {
  readonly counts: SessionTokenCounts;
  /** When the request started, which is when the provider last touched its cache entry. */
  readonly requestedAtMs: number;
}

function withLastTurn(usage: AssistantUsage | undefined): { lastTurn?: SessionTokenCounts } {
  return usage ? { lastTurn: usage.counts } : {};
}

function latestAssistantUsage(branch: readonly BranchEntry[]): AssistantUsage | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;
    const { input, output, cacheRead, cacheWrite } = message.usage;
    if (input + output + cacheRead + cacheWrite === 0) continue;
    return { counts: { input, output, cacheRead, cacheWrite }, requestedAtMs: message.timestamp };
  }
  return undefined;
}

function promptCacheState(
  session: AgentSession,
  branch: readonly BranchEntry[],
): SessionPromptCacheState {
  const warming = session.cacheWarmingStatus;
  if (warming?.state === "refreshing") {
    return { kind: "warming", nextRefreshAt: new Date().toISOString() };
  }
  if (warming?.state === "scheduled" && warming.nextWarmAt !== undefined) {
    return { kind: "warming", nextRefreshAt: new Date(warming.nextWarmAt).toISOString() };
  }

  const ttlMs = promptCacheTtlMs(session);
  const lastRequestAtMs = latestCacheTouchMs(branch);
  if (ttlMs === undefined || lastRequestAtMs === undefined) return { kind: "unknown" };
  return { kind: "expires", expiresAt: new Date(lastRequestAtMs + ttlMs).toISOString() };
}

/**
 * Mirrors pi's `getPromptCacheTtlMs`, which pi does not export. AgentSession
 * never sets `cacheRetention`, so the tier comes from `PI_CACHE_RETENTION`.
 */
function promptCacheTtlMs(session: AgentSession): number | undefined {
  const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
  const seconds = session.model?.promptCache?.[retention];
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Latest provider request on this branch: a real reply or a cache-warming refresh. */
function latestCacheTouchMs(branch: readonly BranchEntry[]): number | undefined {
  let latest = latestAssistantUsage(branch)?.requestedAtMs;
  for (const entry of branch) {
    if (entry.type !== "usage" || entry.kind !== "cache_warm") continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Captures plan-limit headers from provider responses. pi fires
 * `after_provider_response` only on HTTP transports; Codex over WebSocket
 * (pi's default) never reports them.
 */
export function createPlanLimitsExtension(options: {
  readonly onPlanLimits: (limits: SessionPlanLimits) => void;
}): ExtensionFactory {
  return (pi) => {
    pi.on("after_provider_response", (event, context) => {
      const provider = context.model?.provider;
      if (!provider || event.status < 200 || event.status >= 300) return;
      const limits = parsePlanLimitHeaders(event.headers);
      if (limits.length === 0) return;
      options.onPlanLimits({ provider, limits, reportedAt: new Date().toISOString() });
    });
  };
}

export function parsePlanLimitHeaders(
  rawHeaders: Readonly<Record<string, string>>,
  nowMs = Date.now(),
): SessionPlanLimit[] {
  const headers = new Map(
    Object.entries(rawHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const number = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const epochSeconds = (name: string): string | undefined => {
    const value = number(name);
    return value !== undefined && value > 0 ? new Date(value * 1000).toISOString() : undefined;
  };

  const limits: SessionPlanLimit[] = [];

  // ChatGPT subscription (Codex): verified against a live response on 2026-09-24.
  for (const slot of ["primary", "secondary"] as const) {
    const windowMinutes = number(`x-codex-${slot}-window-minutes`);
    const usedPercent = number(`x-codex-${slot}-used-percent`);
    if (!windowMinutes || usedPercent === undefined) continue;
    const resetAfter = number(`x-codex-${slot}-reset-after-seconds`);
    const resetsAt =
      epochSeconds(`x-codex-${slot}-reset-at`) ??
      (resetAfter ? new Date(nowMs + resetAfter * 1000).toISOString() : undefined);
    limits.push({ windowMinutes, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  }

  // Claude subscription unified limits: utilization is a 0-1 fraction.
  // Not yet checked against a live response.
  for (const [slot, windowMinutes] of [
    ["5h", 5 * 60],
    ["7d", 7 * 24 * 60],
  ] as const) {
    const utilization = number(`anthropic-ratelimit-unified-${slot}-utilization`);
    if (utilization === undefined) continue;
    const resetsAt = epochSeconds(`anthropic-ratelimit-unified-${slot}-reset`);
    limits.push({
      windowMinutes,
      usedPercent: utilization * 100,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  return limits;
}
