import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DesktopViewContext } from "@pi-gui/extension-ui/browser";
import { PRReview, staleReason, type ReviewState } from "./contract";

export async function mount(
  root: HTMLElement,
  host: DesktopViewContext,
): Promise<() => Promise<void>> {
  const doc = root.ownerDocument;
  const style = doc.createElement("style");
  style.textContent = `
    .review-view{font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--fg);background:var(--bg);min-height:100%;padding:16px;box-sizing:border-box;overflow-wrap:anywhere}
    .review-view *{box-sizing:border-box}.review-view h2{font-size:15px;margin:0 0 4px;font-weight:600}.review-view h3{font-size:13px;margin:0 0 8px}.review-view p{margin:0 0 12px}.review-meta{font-size:12px;opacity:.65}.review-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
    .review-view button{font:inherit;border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);border-radius:6px;background:transparent;color:inherit;padding:6px 10px;cursor:pointer}.review-view button:hover:not(:disabled){background:color-mix(in srgb,var(--fg) 7%,transparent)}.review-view button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.review-view button:disabled{opacity:.4;cursor:default}.review-view .primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}.review-view button.primary:hover:not(:disabled){background:color-mix(in srgb,var(--fg) 90%,var(--bg));color:var(--bg);border-color:var(--fg)}.review-view .file-link{border:0;padding:0;color:var(--accent);font:12px ui-monospace,monospace;text-align:left}.review-view .notice{padding:10px 12px;border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);border-radius:6px;font-size:12px;margin:12px 0}.review-view .error{border-color:#c06565;color:color-mix(in srgb,var(--fg) 50%,#d54b4b)}.review-view article{padding:16px 0;border-top:1px solid color-mix(in srgb,var(--fg) 14%,transparent)}.review-view article p{white-space:pre-wrap}.review-view details{padding:8px 0}.review-view summary{cursor:pointer;font-size:12px}.review-view ul{padding-left:16px;font-size:12px}.review-view code{font:12px ui-monospace,monospace}.review-footer{font-size:11px;opacity:.55;padding-top:16px;border-top:1px solid color-mix(in srgb,var(--fg) 14%,transparent)}
  `;
  const view = doc.createElement("section");
  view.className = "review-view";
  view.style.setProperty("--bg", host.theme.background);
  view.style.setProperty("--fg", host.theme.foreground);
  view.style.setProperty("--accent", host.theme.accent);
  view.style.colorScheme = host.theme.mode;
  root.append(style, view);
  let active = true;
  let working = false;
  let hydrated = false;
  let messageIsError = false;
  let message = "";
  const binding = host.services.open({
    services: [PRReview],
    assertAccess: () => host.signal.throwIfAborted(),
    onError: (error) => {
      message = error.message;
      messageIsError = true;
      queueMicrotask(render);
    },
  });
  const service = binding.use(PRReview);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, content = "", className = "") => {
    const node = doc.createElement(tag);
    node.textContent = content;
    node.className = className;
    return node;
  };
  const act = (operation: () => Promise<unknown>) => {
    if (working || !active) return;
    working = true;
    message = "";
    messageIsError = false;
    render();
    void operation()
      .catch((error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
        messageIsError = true;
      })
      .finally(() => {
        working = false;
        render();
      });
  };
  const button = (
    label: string,
    operation: () => Promise<unknown>,
    disabled = false,
    className = "",
  ) => {
    const node = element("button", label, className);
    node.type = "button";
    node.disabled = disabled || working;
    node.addEventListener("click", () => act(operation));
    return node;
  };
  function render() {
    if (!active || host.signal.aborted) return;
    const state: ReviewState | undefined = hydrated ? service.state.value : undefined;
    view.replaceChildren(element("h2", "PR Review"));
    if (!state) {
      view.append(element("p", "Connecting to the Pi extension…", "review-meta"));
      return;
    }
    const target = state.target;
    const review = state.review;
    const pending = review?.status === "requested" || review?.status === "running";
    if (target) {
      view.append(
        element("p", `#${target.number} · ${target.title}`),
        element("p", `${target.repository} · ${target.branch}`, "review-meta"),
      );
      view.append(
        element("p", `PR head ${target.head.slice(0, 8)} · committed changes only`, "review-meta"),
      );
      if (target.localHead !== target.head)
        view.append(
          element("p", "Check out this PR’s head to start a review or prepare a fix.", "notice"),
        );
      else if (target.dirty)
        view.append(
          element(
            "p",
            "This checkout has local changes. The review reads the committed PR revision; file links open your current working files.",
            "notice",
          ),
        );
    } else
      view.append(element("p", "Open a checkout with a GitHub PR, then refresh.", "review-meta"));
    const actions = element("div", "", "review-actions");
    actions.append(
      button(
        state.refreshing ? "Refreshing…" : "Refresh PR",
        () => service.refresh({}, BACKGROUND_CONTEXT),
        state.refreshing,
      ),
    );
    actions.append(
      button(
        review?.status === "requested"
          ? "Review requested"
          : pending
            ? "Pi is reviewing…"
            : "Review with Pi",
        () => service.request({ requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT),
        !target || pending || target.localHead !== target.head || state.refreshing,
        "primary",
      ),
    );
    view.append(actions);
    if (state.error || message)
      view.append(
        element(
          "p",
          message || state.error || "",
          state.error || messageIsError ? "notice error" : "notice",
        ),
      );
    if (target) {
      const details = element("details");
      details.append(element("summary", `${target.files.length} changed files`));
      const list = element("ul");
      for (const file of target.files) list.append(element("li", file));
      details.append(list);
      view.append(details);
    }
    if (review) {
      const stale = staleReason(review, target);
      view.append(element("h3", `${stale ? "Previous review" : "Review"} · ${review.status}`));
      view.append(
        element(
          "p",
          `#${review.target.number} at ${review.target.head.slice(0, 8)} · ${new Date(review.requestedAt).toLocaleString()}`,
          "review-meta",
        ),
      );
      view.append(element("p", review.detail, "review-meta"));
      if (stale) view.append(element("p", stale, "notice"));
      if (review.summary) view.append(element("p", review.summary));
      if (review.status === "completed" && !review.findings.length)
        view.append(element("p", "Pi recorded no actionable findings."));
      for (const finding of review.findings) {
        const article = element("article");
        article.append(element("h3", `[${finding.priority}] ${finding.title}`));
        article.append(
          button(
            `${finding.path}:${finding.line}`,
            () => host.actions.openFile({ path: finding.path, line: finding.line }),
            !target || target.localHead !== review.target.head,
            "file-link",
          ),
        );
        article.append(element("p", finding.body));
        article.append(
          button(
            "Prepare fix task",
            async () => {
              const draft = await service.prepareFix(
                { reviewId: review.id, findingId: finding.id },
                BACKGROUND_CONTEXT,
              );
              host.signal.throwIfAborted();
              await host.actions.prepareTaskDraft(draft);
              message = "Fix task prepared. Review the draft before sending it.";
            },
            review.status !== "completed" || !!stale,
          ),
        );
        view.append(article);
      }
    }
    view.append(element("p", "Local Pi extension · nothing is posted to GitHub", "review-footer"));
  }
  let unsubscribe = () => {};
  const abort = () => {
    active = false;
  };
  host.signal.addEventListener("abort", abort, { once: true });
  try {
    await binding.ready(BACKGROUND_CONTEXT);
    host.signal.throwIfAborted();
    hydrated = true;
    unsubscribe = service.state.subscribe(() => render());
    render();
  } catch (error) {
    unsubscribe();
    await binding.dispose(BACKGROUND_CONTEXT);
    root.replaceChildren();
    throw error;
  }
  act(() => service.refresh({}, BACKGROUND_CONTEXT));
  return async () => {
    active = false;
    unsubscribe();
    host.signal.removeEventListener("abort", abort);
    await binding.dispose(BACKGROUND_CONTEXT);
    style.remove();
    view.remove();
  };
}
