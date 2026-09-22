import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { PRReview, type ReviewRecord, type ReviewState } from "./contract";
import { ReviewRepository } from "./repository";
import {
  busy,
  ENTRY,
  finishReview,
  initialState,
  prepareFix,
  recordFindings,
  requestRecord,
  restoreRecord,
} from "./review";

const READ_TOOL = "pr_review_read";
const RECORD_TOOL = "pr_review_record";

export default function prReview(pi: ExtensionAPI) {
  let ctx: ExtensionContext | null = null;
  let snapshot = initialState();
  let lifetime = new AbortController();
  let submitting = false;
  let restoreTools: string[] | null = null;
  let outcome: "completed" | "error" | "aborted" = "completed";
  const listeners = new Set<(state: ReviewState) => void>();
  const publish = (next: ReviewState) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };
  const currentContext = () => {
    lifetime.signal.throwIfAborted();
    if (!ctx) throw new Error("The Pi session is still loading.");
    return ctx;
  };
  const repository = (signal?: AbortSignal) =>
    new ReviewRepository(
      currentContext().cwd,
      signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
    );
  const persist = (record: ReviewRecord) => {
    pi.appendEntry(ENTRY, record);
    publish({ ...snapshot, review: record, error: null });
  };
  const refresh = async () => {
    currentContext();
    publish({ ...snapshot, refreshing: true, error: null });
    try {
      const target = await repository().current();
      publish({ ...snapshot, target, refreshing: false });
      return target;
    } catch (error) {
      if (lifetime.signal.aborted) return;
      publish({
        ...snapshot,
        target: null,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const request = async (requestId: string) => {
    const context = currentContext();
    if (snapshot.review?.id === requestId) return { reviewId: requestId };
    if (submitting || busy(snapshot.review) || !context.isIdle() || context.hasPendingMessages())
      throw new Error("Finish the current Pi operation before starting another review.");
    if (!context.model) throw new Error("Choose a Pi model before starting a review.");
    submitting = true;
    try {
      const target = await refresh();
      if (!target) throw new Error("No current PR is available.");
      if (!context.isIdle() || context.hasPendingMessages())
        throw new Error("Pi became busy. Try again when it is idle.");
      const record = requestRecord(target, requestId);
      persist(record);
      // Pi's public API is fire-and-forget. Only before_agent_start confirms admission.
      pi.sendUserMessage(
        [
          `[pr-review:${record.id}]`,
          `Review ${record.target.url} at head ${record.target.head}.`,
          `Read the committed PR diff from merge base ${record.target.mergeBase}.`,
          `Use ${READ_TOOL} to inspect diffs and source from that captured revision, including relevant unchanged files.`,
          "Look for important, concrete bugs introduced by this PR. Do not edit files or post anything to GitHub.",
          `Finish by calling ${RECORD_TOOL} with reviewId ${record.id}, head ${record.target.head}, a short summary, and findings.`,
          "Use an empty findings array when no actionable issue was found. Every finding must cite a changed file and a line in the reviewed head.",
          `Changed files:\n${record.target.files.join("\n")}`,
        ].join("\n\n"),
      );
      return { reviewId: record.id };
    } finally {
      submitting = false;
    }
  };

  pi.on("session_start", (_event, context) => {
    ctx = context;
    lifetime = new AbortController();
    publish({ ...initialState(), review: restoreRecord(context.sessionManager.getBranch()) });
  });
  pi.on("session_before_tree", () => {
    if (submitting || busy(snapshot.review)) {
      ctx?.ui.notify("Finish or stop the PR review before changing the session tree.", "warning");
      return { cancel: true };
    }
  });
  pi.on("session_tree", (_event, context) => {
    ctx = context;
    publish({ ...initialState(), review: restoreRecord(context.sessionManager.getBranch()) });
  });
  pi.on("before_agent_start", (event, context) => {
    ctx = context;
    const review = snapshot.review;
    if (review?.status !== "requested" || !event.prompt.includes(`[pr-review:${review.id}]`))
      return;
    outcome = "completed";
    restoreTools = pi.getActiveTools();
    event.systemPromptOptions.selectedTools = [READ_TOOL, RECORD_TOOL];
    persist({ ...review, status: "running", detail: "Pi is reviewing the captured PR revision." });
  });
  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
  });
  pi.on("agent_settled", () => {
    if (restoreTools) {
      pi.setActiveTools(restoreTools);
      restoreTools = null;
    }
    if (snapshot.review?.status === "running") persist(finishReview(snapshot.review, outcome));
  });
  pi.on("session_shutdown", () => {
    if (busy(snapshot.review) && snapshot.review)
      persist({
        ...snapshot.review,
        status: "interrupted",
        detail: "The Pi session closed before this review settled.",
      });
    lifetime.abort();
    ctx = null;
  });

  pi.registerTool({
    name: READ_TOOL,
    label: "Read PR snapshot",
    description:
      "Read a file or changed-file diff from the active review's immutable Git revision. Does not read uncommitted working files.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("diff"), Type.Literal("file")]),
      path: Type.String({ minLength: 1, maxLength: 2048 }),
    }),
    async execute(_id, input, signal) {
      const review = snapshot.review;
      if (review?.status !== "running") throw new Error("No Pi PR review is running.");
      const content = await repository(signal).read(review.target, input.kind, input.path);
      return {
        content: [{ type: "text", text: content || "No content at this revision." }],
        details: { head: review.target.head, path: input.path },
      };
    },
  });
  pi.registerTool({
    name: RECORD_TOOL,
    label: "Record PR findings",
    description:
      "Record the current PR review's structured findings. This does not post a GitHub review or change files.",
    parameters: Type.Object({
      reviewId: Type.String({ minLength: 1, maxLength: 80 }),
      head: Type.String(),
      summary: Type.String({ minLength: 1, maxLength: 2000 }),
      findings: Type.Array(
        Type.Object({
          priority: Type.Union([Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")]),
          title: Type.String({ minLength: 1, maxLength: 160 }),
          body: Type.String({ minLength: 1, maxLength: 4000 }),
          path: Type.String({ minLength: 1, maxLength: 2048 }),
          line: Type.Integer({ minimum: 1 }),
        }),
        { maxItems: 20 },
      ),
    }),
    async execute(_id, input, signal) {
      if (!snapshot.review) throw new Error("No active review exists.");
      const next = recordFindings(snapshot.review, input);
      for (const finding of next.findings) {
        const source = await repository(signal).read(next.target, "file", finding.path);
        if (finding.line > source.split("\n").length)
          throw new Error(
            `Line ${finding.line} is outside ${finding.path} at the reviewed revision.`,
          );
      }
      signal?.throwIfAborted();
      if (snapshot.review?.id !== next.id || snapshot.review.status !== "running")
        throw new Error("The review ended before these findings were recorded.");
      persist(next);
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${next.findings.length} findings for PR #${next.target.number}. These are local results; nothing was posted.`,
          },
        ],
        details: { reviewId: next.id, count: next.findings.length },
      };
    },
  });
  pi.registerCommand("pr-review", {
    description: "Review the current branch's GitHub PR and save structured local findings",
    handler: async (_args, context) => {
      ctx = context;
      await request(crypto.randomUUID());
    },
  });

  registerDesktopView(pi, {
    id: "pr-review",
    title: "PR Review",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "pi-gui.examples.pr-review.backend",
        setup(env) {
          const state = env.replicatedState(snapshot);
          const listener = (next: ReviewState) => state.replace(BACKGROUND_CONTEXT, next);
          listeners.add(listener);
          env.own(() => {
            listeners.delete(listener);
          });
          env.provide(PRReview, {
            state,
            async refresh() {
              await refresh();
            },
            async request(input) {
              return request(input.requestId);
            },
            async prepareFix(input) {
              if (!snapshot.review || snapshot.review.id !== input.reviewId)
                throw new Error("This review is no longer selected.");
              const target = await refresh();
              if (!snapshot.review || snapshot.review.id !== input.reviewId)
                throw new Error("The review changed while its PR was being refreshed.");
              return prepareFix(snapshot.review, target ?? null, input.findingId);
            },
          });
        },
      }),
  });
}
