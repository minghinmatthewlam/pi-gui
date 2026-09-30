import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { collectUsage, reduceThread, type CurrentThread } from "./collect.ts";
import { Usage, type UsageState } from "./contract.ts";
import { cacheHitRate, formatCost, formatPercent, formatTokens, summarize } from "./model.ts";

const initialState = (): UsageState => ({
  status: "idle",
  error: null,
  refreshedAt: null,
  folderName: "",
  threads: [],
  scanned: 0,
  unreadable: 0,
  capped: 0,
});

export default function usageExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | null = null;
  let state = initialState();
  const listeners = new Set<(next: UsageState) => void>();
  let running: Promise<void> | null = null;
  let again = false;

  const publish = (next: UsageState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const currentThread = (ctx: ExtensionContext): CurrentThread => {
    const usage = ctx.getContextUsage();
    return {
      id: ctx.sessionManager.getSessionId(),
      entries: ctx.sessionManager.getEntries(),
      name: ctx.sessionManager.getSessionName(),
      contextNow: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow } : null,
    };
  };
  // Short names like the reference ("Opus 4.8"): drop the vendor prefix and "(latest)".
  const modelName = (ctx: ExtensionContext) => (provider: string, modelId: string) =>
    ctx.modelRegistry
      .find(provider, modelId)
      ?.name.replace(/^Claude\s+/, "")
      .replace(/\s*\(latest\)$/, "");
  // Mirrors pi-gui's footer: OAuth to a subscription provider (and Kimi Coding) has no per-token cost.
  const isSubscription = (ctx: ExtensionContext) => (provider: string, modelId: string) => {
    if (provider === "kimi-coding") return true;
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) return false;
    return ctx.modelRegistry.getProvider(provider)?.auth?.oauth?.isSubscription === true;
  };

  const fail = (error: unknown) =>
    publish({
      ...state,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });

  const collectOnce = async () => {
    const ctx = context;
    if (!ctx) return;
    publish({ ...state, status: "loading", error: null });
    try {
      const collected = await collectUsage({
        cwd: ctx.cwd,
        sessionDir: ctx.sessionManager.getSessionDir(),
        current: currentThread(ctx),
        modelName: modelName(ctx),
        isSubscription: isSubscription(ctx),
      });
      if (ctx === context) publish({ status: "ready", error: null, ...collected });
    } catch (error) {
      fail(error);
    }
  };

  /** Coalesces overlapping requests into at most one follow-up pass. */
  const refresh = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await collectOnce();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  /** After a turn only this thread changed; recompute it from live entries, not the folder. */
  const refreshCurrent = () => {
    const ctx = context;
    if (!ctx || state.status !== "ready") return;
    const live = currentThread(ctx);
    const existing = state.threads.find((thread) => thread.id === live.id);
    const thread = reduceThread({
      id: live.id,
      title: existing?.title ?? live.name ?? "This thread",
      lastActiveAt: Date.now(),
      entries: live.entries,
      current: true,
      contextNow: live.contextNow,
      modelName: modelName(ctx),
      isSubscription: isSubscription(ctx),
    });
    publish({
      ...state,
      threads: existing
        ? state.threads.map((candidate) => (candidate.id === live.id ? thread : candidate))
        : [thread, ...state.threads],
    });
  };

  /** Only recompute while a view is connected; opening one always refreshes. */
  const refreshInBackground = () => {
    if (listeners.size > 0) refresh().catch(fail);
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    state = initialState();
    refreshInBackground();
  });
  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
    refreshInBackground();
  });
  pi.on("turn_end", () => {
    if (listeners.size > 0) refreshCurrent();
  });
  pi.on("agent_end", refreshInBackground);
  pi.on("session_shutdown", () => {
    context = null;
  });

  pi.registerCommand("usage", {
    description: "Summarize token usage and cache hit across this folder's threads",
    async handler(_args, ctx) {
      context = ctx;
      await refresh();
      const summary = summarize(state.threads, "all", Date.now());
      const lines = [
        `Usage · ${state.folderName}`,
        `Threads ${summary.rows.length} · Tokens ${formatTokens(summary.tokens)} · Cache hit ${formatPercent(summary.cacheHit)} · ${summary.subscription ? "Subscription" : formatCost(summary.totals.cost)}`,
        ...summary.rows
          .slice(0, 8)
          .map(
            (row) =>
              `${formatTokens(row.tokens).padStart(7)}  ${formatPercent(cacheHitRate(row.counts)).padStart(4)}  ${row.thread.title}`,
          ),
      ];
      ctx.ui.notify(lines.join("\n"), state.status === "error" ? "error" : "info");
    },
  });

  registerDesktopView(pi, {
    id: "usage",
    title: "Usage",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "pi-gui.example.usage.backend",
        setup(env) {
          const replicated = env.replicatedState(state);
          const listener = (next: UsageState) => replicated.replace(BACKGROUND_CONTEXT, next);
          listeners.add(listener);
          env.own(() => {
            listeners.delete(listener);
          });
          env.provide(Usage, {
            state: replicated,
            async refresh(_request, callContext) {
              callContext.abortSignal?.throwIfAborted();
              await refresh();
            },
          });
        },
      }),
  });
}
