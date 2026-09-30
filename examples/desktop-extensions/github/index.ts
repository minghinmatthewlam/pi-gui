import { fileURLToPath } from "node:url";
import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { GitHub, initialState, needsAttention, type GitHubState } from "./contract.ts";
import { loadRepository } from "./source.ts";

const FALLBACK_SNAPSHOT = fileURLToPath(
  new URL("./fixtures/pi-gui-snapshot.json", import.meta.url),
);

export default function githubExtension(pi: ExtensionAPI): void {
  let cwd: string | null = null;
  let snapshot = initialState();
  let lifetime = new AbortController();
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<(state: GitHubState) => void>();
  const publish = (next: GitHubState) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  // One read at a time; a second refresh joins the one already running.
  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const directory = cwd;
    const signal = lifetime.signal;
    if (!directory) return Promise.reject(new Error("The Pi session is still loading."));
    publish({ ...snapshot, refreshing: true });
    inFlight = loadRepository({
      cwd: directory,
      signal,
      env: process.env,
      fallbackSnapshot: FALLBACK_SNAPSHOT,
    })
      .then((loaded) => {
        if (signal.aborted) return;
        publish({
          status: "ready",
          refreshing: false,
          repo: loaded.repo,
          source: loaded.source,
          fetchedAt: new Date().toISOString(),
          pullRequests: loaded.pullRequests,
          issues: loaded.issues,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        // Keep the last good list visible; the error explains why it did not update.
        publish({
          ...snapshot,
          status: snapshot.status === "ready" ? "ready" : "error",
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  pi.on("session_start", (_event, ctx) => {
    lifetime.abort();
    lifetime = new AbortController();
    inFlight = null;
    cwd = ctx.cwd;
    publish(initialState());
    void refresh();
  });
  pi.on("session_shutdown", () => {
    lifetime.abort();
    inFlight = null;
    cwd = null;
  });

  pi.registerCommand("github", {
    description: "Summarize this repository's open GitHub pull requests and issues",
    async handler(_args, ctx) {
      cwd = ctx.cwd;
      await refresh();
      if (!snapshot.repo) {
        ctx.ui.notify(snapshot.error ?? "No GitHub repository found.", "error");
        return;
      }
      const open = snapshot.pullRequests.filter((pr) => pr.state === "open");
      const issues = snapshot.issues.filter((issue) => issue.state === "open");
      const attention = open.filter(needsAttention);
      ctx.ui.notify(
        [
          `${snapshot.repo}: ${open.length} open PRs (${attention.length} need attention), ${issues.length} open issues`,
          ...attention.map(
            (pr) =>
              `#${pr.number} ${pr.title} · ${pr.checks.failed.length ? `failing: ${pr.checks.failed.join(", ")}` : "changes requested"}`,
          ),
          snapshot.source?.kind === "snapshot" ? `Snapshot from ${snapshot.source.capturedAt}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
    },
  });

  registerDesktopView(pi, {
    id: "github",
    title: "GitHub",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "pi-gui.example.github.backend",
        setup(env) {
          const state = env.replicatedState(snapshot);
          const listener = (next: GitHubState) => state.replace(BACKGROUND_CONTEXT, next);
          listeners.add(listener);
          env.own(() => {
            listeners.delete(listener);
          });
          env.provide(GitHub, {
            state,
            async refresh(_request, context) {
              context.abortSignal?.throwIfAborted();
              await refresh();
            },
          });
        },
      }),
  });
}
