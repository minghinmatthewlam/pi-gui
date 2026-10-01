import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DesktopViewContext } from "@pi-gui/extension-ui/browser";
import {
  GH_INSTALL_URL,
  GH_MISSING,
  GitHub,
  initialState,
  needsAttention,
  type GitHubState,
  type Issue,
  type PullRequest,
} from "./contract.ts";
import { issueDraft, pullRequestDraft } from "./drafts.ts";

type Tab = "prs" | "issues";
type Filter = "open" | "closed" | "attention";

// Static glyphs drawn on a 16px grid. Only these constants are parsed as markup;
// every GitHub-provided string is written with textContent.
const ICONS = {
  prOpen:
    '<circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="12.5" r="1.75"/><path d="M4.5 5.25v5.5M11.5 10.75V6.5a2 2 0 0 0-2-2H7.25"/><path d="M8.75 3 7.25 4.5 8.75 6"/>',
  prDraft:
    '<circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="12.5" r="1.75"/><path d="M4.5 5.25v5.5M11.5 8.5v.25M11.5 5.5v.25M11.5 2.5v.25"/>',
  prMerged:
    '<circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="9" r="1.75"/><path d="M4.5 5.25v5.5M4.5 5.5c0 2 1.5 3.5 3.5 3.5h1.75"/>',
  prClosed:
    '<circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="12.5" r="1.75"/><path d="M4.5 5.25v5.5M11.5 10.75V8.25M9.75 2.75l3.5 3.5M13.25 2.75l-3.5 3.5"/>',
  issueOpen:
    '<circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none"/>',
  issueClosed: '<circle cx="8" cy="8" r="6.25"/><path d="m5.5 8.25 1.75 1.75 3.25-3.5"/>',
  check: '<path d="m3.75 8.25 2.75 2.75 5.75-6"/>',
  cross: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
  pending: '<circle cx="8" cy="8" r="2.75" fill="currentColor" stroke="none"/>',
  none: '<circle cx="8" cy="8" r="2.75"/>',
  comment: '<path d="M2.75 3.25h10.5v7.25H8l-3.25 2.75V10.5h-2Z"/>',
  refresh: '<path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3"/><path d="M12.25 1.75v3h-3"/>',
  external:
    '<path d="M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11.25 9.5v3.25a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-7.5a.5.5 0 0 1 .5-.5H6.5"/>',
} as const;

const STYLE = `
.gh{--muted:color-mix(in srgb,var(--foreground) 58%,transparent);--faint:color-mix(in srgb,var(--foreground) 38%,transparent);--line:color-mix(in srgb,var(--foreground) 9%,transparent);--hover:color-mix(in srgb,var(--foreground) 4%,transparent);--press:color-mix(in srgb,var(--foreground) 8%,transparent);--green:light-dark(#2e9d47,#46c07a);--red:light-dark(#c24a5c,#e0677a);--purple:light-dark(#7c5cc4,#a88be6);--amber:light-dark(#b66d0a,#d9a044);--mono:ui-monospace,"SF Mono","Cascadia Code","Consolas",monospace;
  font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;color:var(--foreground);min-height:100vh;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.gh *{box-sizing:border-box}
:where(.gh button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.gh button:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:-2px;border-radius:6px}
.gh svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.gh-head{display:flex;align-items:center;gap:8px;padding:12px 10px 10px 14px}
.gh-head-text{flex:1;min-width:0}
.gh-repo{margin:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gh-sub{margin:1px 0 0;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gh-icon{width:26px;height:26px;display:grid;place-items:center;border-radius:6px;color:var(--muted)}
.gh-icon:hover:not(:disabled){background:var(--press);color:var(--foreground)}
.gh-icon:disabled{cursor:default}
.gh-icon[data-busy] svg{animation:gh-spin .9s linear infinite}
@keyframes gh-spin{to{transform:rotate(360deg)}}
.gh-notice{margin:0 14px 10px;padding:7px 10px;border-radius:6px;background:var(--hover);font-size:12px;line-height:1.45;color:var(--muted)}
.gh-notice code{font:11.5px var(--mono)}
.gh-notice[data-tone=error]{color:var(--red);background:color-mix(in srgb,var(--red) 7%,transparent)}
.gh-tabs{display:flex;gap:18px;padding:0 14px;border-bottom:1px solid var(--line)}
.gh-tab{display:flex;align-items:center;gap:6px;padding:7px 0 8px;margin-bottom:-1px;border-bottom:1.5px solid transparent;color:var(--muted)}
.gh-tab:hover{color:var(--foreground)}
.gh-tab[aria-selected=true]{color:var(--foreground);border-bottom-color:var(--foreground);font-weight:500}
.gh-count{font-size:11px;line-height:16px;min-width:18px;padding:0 5px;border-radius:999px;background:var(--press);color:var(--muted);text-align:center;font-weight:500}
.gh-filters{display:flex;flex-wrap:wrap;gap:4px;padding:8px 14px;border-bottom:1px solid var(--line)}
.gh-chip{display:flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;font-size:12px;color:var(--muted)}
.gh-chip:hover{background:var(--hover);color:var(--foreground)}
.gh-chip[aria-pressed=true]{background:var(--press);color:var(--foreground);font-weight:500}
.gh-chip span{color:var(--faint);font-weight:400}
.gh-chip[aria-pressed=true] span{color:var(--muted)}
.gh-list{list-style:none;margin:0;padding:0}
.gh-row{border-bottom:1px solid var(--line)}
.gh-row-main{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:10px;align-items:start;width:100%;padding:8px 12px 8px 14px;text-align:left}
.gh-row-main:hover,.gh-row[data-expanded] .gh-row-main{background:var(--hover)}
.gh-row-main>svg{margin-top:1px}
.gh-title-line{display:block;overflow-wrap:anywhere;font-weight:500}
.gh-title-line .gh-badge{margin-left:6px;vertical-align:1px}
.gh-badge{display:inline-block;font-size:10.5px;font-weight:500;line-height:15px;padding:0 6px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.gh-meta{display:flex;align-items:baseline;gap:5px;margin-top:3px;min-width:0;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden}
.gh-meta>*{flex:none}
.gh-meta .gh-sep{color:var(--faint)}
.gh-num{font:11.5px var(--mono);color:var(--muted)}
.gh-branch{font:11.5px var(--mono);flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.gh-labels{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.gh-label{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;background:var(--press);color:var(--muted);white-space:nowrap}
.gh-trail{display:flex;align-items:center;gap:10px;margin-top:1px;font-size:12px;color:var(--muted);white-space:nowrap}
.gh-stat{display:flex;align-items:center;gap:3px}
.gh-stat svg{width:14px;height:14px}
.gh-review{font-size:12px}
.is-green{color:var(--green)}.is-red{color:var(--red)}.is-purple{color:var(--purple)}.is-amber{color:var(--amber)}.is-muted{color:var(--faint)}
.gh-detail{padding:2px 14px 12px 40px;background:var(--hover);font-size:12px}
.gh-section{margin:0 0 10px}
.gh-section-title{margin:0 0 4px;font-size:11px;font-weight:500;color:var(--muted)}
.gh-checks{list-style:none;margin:0;padding:0}
.gh-checks li{display:flex;align-items:center;gap:6px;min-height:20px}
.gh-checks svg{width:14px;height:14px}
.gh-checks .gh-check-name{font:11.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-facts{display:flex;flex-wrap:wrap;gap:4px 10px;margin:0 0 10px;color:var(--muted)}
.gh-add{color:var(--green)}.gh-del{color:var(--red)}
.gh-body{margin:0 0 10px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5;color:color-mix(in srgb,var(--foreground) 82%,transparent);display:-webkit-box;-webkit-line-clamp:9;-webkit-box-orient:vertical;overflow:hidden}
.gh-body[data-empty]{color:var(--faint);font-style:italic}
.gh-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.gh-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:6px;font-size:12px;font-weight:500;border:1px solid color-mix(in srgb,var(--foreground) 14%,transparent);white-space:nowrap}
.gh-btn svg{width:13px;height:13px}
.gh-btn:hover:not(:disabled){background:var(--press)}
.gh-btn:disabled{cursor:default;opacity:.45}
.gh-btn-primary{background:var(--foreground);color:var(--background);border-color:var(--foreground)}
.gh-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--foreground) 88%,var(--background))}
.gh-hint{margin:6px 0 0;color:var(--faint);font-size:11.5px;overflow-wrap:anywhere}
.gh-hint[data-tone=ok]{color:var(--muted)}.gh-hint[data-tone=error]{color:var(--red)}
.gh-empty{padding:28px 14px;color:var(--muted);font-size:12px;text-align:center}
.gh-empty strong{display:block;margin-bottom:4px;color:var(--foreground);font-size:13px;font-weight:500}
`;

/** Data older than this refreshes when the view opens. */
const STALE_AFTER_MS = 60_000;

export async function mount(
  root: HTMLElement,
  host: DesktopViewContext,
): Promise<() => Promise<void>> {
  host.signal.throwIfAborted();
  const doc = root.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const icon = (name: keyof typeof ICONS, className = "") => {
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    svg.innerHTML = ICONS[name];
    return svg;
  };
  const sep = () => el("span", "gh-sep", "·");

  const style = el("style");
  style.textContent = STYLE;
  const view = el("div", "gh");
  root.replaceChildren(style, view);

  let state: GitHubState = initialState();
  let hydrated = false;
  let tab: Tab = "prs";
  const filters: Record<Tab, Filter> = { prs: "open", issues: "open" };
  let expanded: string | null = null;
  let actionError = "";
  const drafts = new Map<string, { pending: boolean; message: string; tone: "ok" | "error" }>();
  let active = true;

  const binding = host.services.open({
    services: [GitHub],
    assertAccess: () => host.signal.throwIfAborted(),
    onError: (error) => {
      actionError = error.message;
      queueMicrotask(render);
    },
  });
  const service = binding.use(GitHub);

  const refresh = () => {
    actionError = "";
    service.refresh({}, BACKGROUND_CONTEXT).catch((error: unknown) => {
      actionError = error instanceof Error ? error.message : String(error);
      render();
    });
  };

  function render() {
    if (!active || host.signal.aborted) return;
    // Rebuilding is cheap at this size; keep keyboard focus on the same control.
    const focusKey = (doc.activeElement as HTMLElement | null)?.dataset?.focus;
    view.replaceChildren(header(), ...notices(), ...body());
    if (focusKey)
      view.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
  }

  function header(): HTMLElement {
    const head = el("header", "gh-head");
    const text = el("div", "gh-head-text");
    const repo = el("h1", "gh-repo", state.repo ?? "GitHub");
    const sub = el("p", "gh-sub");
    if (!hydrated || state.status === "loading") sub.textContent = "Loading…";
    else if (state.fetchedAt) sub.textContent = `Updated ${relativeLong(state.fetchedAt)}`;
    else sub.textContent = "Not loaded";
    text.append(repo, sub);
    const button = el("button", "gh-icon");
    button.type = "button";
    button.dataset.focus = "refresh";
    button.setAttribute("aria-label", state.refreshing ? "Refreshing" : "Refresh");
    button.title = "Refresh";
    button.disabled = !hydrated || state.refreshing;
    if (state.refreshing) button.dataset.busy = "";
    button.append(icon("refresh"));
    button.addEventListener("click", refresh);
    head.append(text, button);
    return head;
  }

  function notices(): HTMLElement[] {
    const list: HTMLElement[] = [];
    const error = actionError || (state.status === "ready" ? state.error : null);
    if (error) {
      const notice = el("p", "gh-notice", error);
      notice.dataset.tone = "error";
      notice.setAttribute("role", "alert");
      list.push(notice);
    }
    return list;
  }

  function body(): HTMLElement[] {
    if (!hydrated || state.status === "loading")
      return [empty("Loading pull requests and issues…")];
    if (state.status === "error") {
      const box = empty(state.error ?? "GitHub could not be read.", "Can't show GitHub data");
      box.setAttribute("role", "alert");
      if (state.error === GH_MISSING) {
        const install = el("button", "gh-btn", "Get the GitHub CLI");
        install.type = "button";
        install.append(icon("external"));
        install.addEventListener("click", () => openLink(GH_INSTALL_URL));
        box.append(install);
      }
      return [box];
    }
    const openPrs = state.pullRequests.filter((pr) => pr.state === "open");
    const openIssues = state.issues.filter((issue) => issue.state === "open");
    const tabs = el("div", "gh-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "GitHub lists");
    tabs.append(
      tabButton("prs", "Pull requests", openPrs.length),
      tabButton("issues", "Issues", openIssues.length),
    );

    const chips = el("div", "gh-filters");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Filter");
    const panel = el("ul", "gh-list");
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-label", tab === "prs" ? "Pull requests" : "Issues");
    if (tab === "prs") {
      const closed = state.pullRequests.length - openPrs.length;
      const attention = openPrs.filter(needsAttention);
      chips.append(
        chip("open", "Open", openPrs.length),
        chip("closed", "Closed", closed),
        chip("attention", "Needs attention", attention.length),
      );
      const filter = filters.prs;
      const rows =
        filter === "open"
          ? openPrs
          : filter === "attention"
            ? attention
            : state.pullRequests.filter((pr) => pr.state !== "open");
      panel.append(...rows.map(pullRequestRow));
      if (!rows.length)
        return [
          tabs,
          chips,
          empty(
            filter === "attention"
              ? "Nothing needs attention. Open PRs have passing checks and no requested changes."
              : `No ${filter} pull requests.`,
          ),
        ];
    } else {
      const closed = state.issues.length - openIssues.length;
      chips.append(chip("open", "Open", openIssues.length), chip("closed", "Closed", closed));
      const rows =
        filters.issues === "open" ? openIssues : state.issues.filter((i) => i.state === "closed");
      panel.append(...rows.map(issueRow));
      if (!rows.length) return [tabs, chips, empty(`No ${filters.issues} issues.`)];
    }
    return [tabs, chips, panel];
  }

  function tabButton(id: Tab, label: string, count: number) {
    const button = el("button", "gh-tab");
    button.type = "button";
    button.dataset.focus = `tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-label", `${label} ${count}`);
    button.setAttribute("aria-selected", String(tab === id));
    button.append(label, el("span", "gh-count", String(count)));
    button.addEventListener("click", () => {
      tab = id;
      expanded = null;
      render();
    });
    return button;
  }

  function chip(id: Filter, label: string, count: number) {
    const button = el("button", "gh-chip");
    button.type = "button";
    button.dataset.focus = `filter-${tab}-${id}`;
    button.setAttribute("aria-pressed", String(filters[tab] === id));
    button.setAttribute("aria-label", `${label} ${count}`);
    button.append(label, el("span", "", String(count)));
    button.addEventListener("click", () => {
      filters[tab] = id;
      expanded = null;
      render();
    });
    return button;
  }

  function empty(text: string, title = "") {
    const box = el("div", "gh-empty");
    if (title) box.append(el("strong", "", title));
    box.append(text);
    return box;
  }

  function rowShell(
    key: string,
    label: string,
    stateIcon: SVGElement,
    main: HTMLElement[],
    trail: HTMLElement,
  ) {
    const item = el("li", "gh-row");
    item.dataset.key = key;
    const isOpen = expanded === key;
    if (isOpen) item.dataset.expanded = "";
    const button = el("button", "gh-row-main");
    button.type = "button";
    button.dataset.focus = `row-${key}`;
    button.setAttribute("aria-expanded", String(isOpen));
    button.setAttribute("aria-label", label);
    const text = el("span", "gh-row-text");
    text.append(...main);
    button.append(stateIcon, text, trail);
    button.addEventListener("click", () => {
      expanded = expanded === key ? null : key;
      render();
    });
    item.append(button);
    return item;
  }

  function pullRequestRow(pr: PullRequest): HTMLElement {
    const key = `pr-${pr.number}`;
    const [iconName, tone, stateLabel] =
      pr.state === "merged"
        ? (["prMerged", "is-purple", "Merged"] as const)
        : pr.state === "closed"
          ? (["prClosed", "is-red", "Closed"] as const)
          : pr.draft
            ? (["prDraft", "is-muted", "Draft"] as const)
            : (["prOpen", "is-green", "Open"] as const);
    const title = el("span", "gh-title-line", pr.title);
    if (pr.draft) title.append(el("span", "gh-badge", "Draft"));
    const meta = el("span", "gh-meta");
    meta.append(
      el("span", "gh-num", `#${pr.number}`),
      sep(),
      el("span", "", pr.author),
      sep(),
      timeAgo(pr.updatedAt),
    );
    if (pr.branch) meta.append(sep(), el("span", "gh-branch", pr.branch));
    const trail = el("span", "gh-trail");
    const review = reviewLabel(pr);
    if (review) trail.append(review);
    trail.append(ciStatus(pr));
    const item = rowShell(
      key,
      `${stateLabel} pull request #${pr.number}: ${pr.title}. ${ciText(pr)}`,
      icon(iconName, tone),
      [title, meta],
      trail,
    );
    if (expanded === key) item.append(pullRequestDetail(pr));
    return item;
  }

  function issueRow(issue: Issue): HTMLElement {
    const key = `issue-${issue.number}`;
    const title = el("span", "gh-title-line", issue.title);
    const meta = el("span", "gh-meta");
    meta.append(
      el("span", "gh-num", `#${issue.number}`),
      sep(),
      el("span", "", issue.author),
      sep(),
      timeAgo(issue.updatedAt),
    );
    const main: HTMLElement[] = [title, meta];
    if (issue.labels.length) {
      const labels = el("span", "gh-labels");
      labels.append(...issue.labels.map((label) => el("span", "gh-label", label)));
      main.splice(1, 0, labels);
    }
    const trail = el("span", "gh-trail");
    if (issue.comments) {
      const comments = el("span", "gh-stat");
      comments.title = `${issue.comments} comment${issue.comments === 1 ? "" : "s"}`;
      comments.append(icon("comment"), String(issue.comments));
      trail.append(comments);
    }
    const open = issue.state === "open";
    const item = rowShell(
      key,
      `${open ? "Open" : "Closed"} issue #${issue.number}: ${issue.title}`,
      icon(open ? "issueOpen" : "issueClosed", open ? "is-green" : "is-purple"),
      main,
      trail,
    );
    if (expanded === key) item.append(issueDetail(issue));
    return item;
  }

  function ciStatus(pr: PullRequest): HTMLElement {
    const stat = el("span", "gh-stat");
    stat.title = ciText(pr);
    const { checks } = pr;
    if (checks.state === "failing") {
      stat.classList.add("is-red");
      stat.append(icon("cross"), String(checks.failedCount));
    } else if (checks.state === "passing") {
      stat.classList.add("is-green");
      stat.append(icon("check"));
    } else if (checks.state === "pending") {
      stat.classList.add("is-amber");
      stat.append(icon("pending"));
    } else {
      stat.classList.add("is-muted");
      stat.append(icon("none"));
    }
    return stat;
  }

  function ciText(pr: PullRequest): string {
    const { checks } = pr;
    switch (checks.state) {
      case "failing":
        return `${checks.failedCount} of ${checks.total} checks failing`;
      case "passing":
        return checks.skipped
          ? `${checks.passed} checks passing · ${checks.skipped} skipped`
          : `All ${checks.total} checks passing`;
      case "pending":
        return `Checks running · ${checks.passed} of ${checks.total} passed`;
      default:
        return checks.total ? `All ${checks.total} checks skipped` : "No checks reported";
    }
  }

  function reviewLabel(pr: PullRequest): HTMLElement | null {
    if (pr.state !== "open") return null;
    if (pr.review === "approved") return el("span", "gh-review is-green", "Approved");
    if (pr.review === "changes_requested")
      return el("span", "gh-review is-red", "Changes requested");
    if (pr.review === "review_required") return el("span", "gh-review", "Review required");
    return null;
  }

  function pullRequestDetail(pr: PullRequest): HTMLElement {
    const detail = el("div", "gh-detail");
    const checks = el("div", "gh-section");
    checks.append(el("p", "gh-section-title", "Checks"));
    const list = el("ul", "gh-checks");
    for (const name of pr.checks.failed) {
      const item = el("li", "is-red");
      item.append(icon("cross"), el("span", "gh-check-name", name));
      list.append(item);
    }
    const unnamed = pr.checks.failedCount - pr.checks.failed.length;
    if (unnamed > 0) {
      const item = el("li", "is-red");
      item.append(icon("cross"), el("span", "gh-check-name", `${unnamed} more failing`));
      list.append(item);
    }
    const passed = el("li", pr.checks.passed ? "is-green" : "is-muted");
    if (pr.checks.state === "pending") {
      passed.className = "is-amber";
      passed.append(icon("pending"), el("span", "", ciText(pr)));
    } else if (pr.checks.total) {
      const skipped = pr.checks.skipped ? ` · ${pr.checks.skipped} skipped` : "";
      passed.append(
        icon(pr.checks.passed ? "check" : "none"),
        el("span", "", `${pr.checks.passed} passed${skipped}`),
      );
    } else passed.append(icon("none"), el("span", "", "No checks reported"));
    list.append(passed);
    checks.append(list);
    detail.append(checks);

    const facts = el("p", "gh-facts");
    if (pr.additions !== null && pr.deletions !== null) {
      const diff = el("span");
      diff.append(
        el("span", "gh-add", `+${pr.additions}`),
        " ",
        el("span", "gh-del", `−${pr.deletions}`),
      );
      facts.append(diff);
    }
    facts.append(el("span", "", `Opened by ${pr.author} ${relativeLong(pr.createdAt)}`));
    detail.append(facts);
    const draft = pullRequestDraft(state.repo ?? "this repository", pr);
    detail.append(actions(`pr-${pr.number}`, pr.url, draft));
    return detail;
  }

  function issueDetail(issue: Issue): HTMLElement {
    const detail = el("div", "gh-detail");
    const text = el("p", "gh-body", issue.body || "No description provided.");
    if (!issue.body) text.dataset.empty = "";
    const facts = el("p", "gh-facts");
    facts.append(
      el("span", "", `Opened by ${issue.author} ${relativeLong(issue.createdAt)}`),
      el("span", "", `${issue.comments} comment${issue.comments === 1 ? "" : "s"}`),
    );
    const draft = issueDraft(state.repo ?? "this repository", issue);
    detail.append(text, facts, actions(`issue-${issue.number}`, issue.url, draft));
    return detail;
  }

  function openLink(url: string) {
    actionError = "";
    host.actions.openUrl(url).catch((error: unknown) => {
      actionError = error instanceof Error ? error.message : String(error);
      render();
    });
  }

  function actions(
    key: string,
    url: string,
    draft: { title: string; prompt: string },
  ): HTMLElement {
    const wrap = el("div");
    const row = el("div", "gh-actions");
    const status = drafts.get(key);
    const start = el(
      "button",
      "gh-btn gh-btn-primary",
      status?.pending ? "Preparing…" : "Start thread",
    );
    start.type = "button";
    start.dataset.focus = `start-${key}`;
    start.disabled = Boolean(status?.pending);
    start.addEventListener("click", () => {
      drafts.set(key, { pending: true, message: "", tone: "ok" });
      render();
      host.actions
        .prepareTaskDraft(draft)
        .then(() => {
          drafts.set(key, {
            pending: false,
            message: "Draft opened in a new thread. Nothing is sent until you send it.",
            tone: "ok",
          });
        })
        .catch((error: unknown) => {
          drafts.set(key, {
            pending: false,
            message: error instanceof Error ? error.message : String(error),
            tone: "error",
          });
        })
        .finally(render);
    });
    const link = el("button", "gh-btn");
    link.type = "button";
    link.title = url;
    link.append("Open on GitHub", icon("external"));
    link.addEventListener("click", () => openLink(url));
    row.append(start, link);
    const hint = el("p", "gh-hint");
    if (status?.message) {
      hint.textContent = status.message;
      hint.dataset.tone = status.tone;
      hint.setAttribute("role", status.tone === "error" ? "alert" : "status");
    } else hint.textContent = `Prepares an unsent draft: ${draft.title}`;
    wrap.append(row, hint);
    return wrap;
  }

  function timeAgo(iso: string): HTMLElement {
    const node = el("time", "", relativeShort(iso));
    node.dateTime = iso;
    node.title = formatDate(iso);
    return node;
  }

  let unsubscribe = () => {};
  const tick = setInterval(render, 30_000);
  const abort = () => {
    active = false;
    clearInterval(tick);
  };
  host.signal.addEventListener("abort", abort, { once: true });
  render();
  try {
    await binding.ready(BACKGROUND_CONTEXT);
    host.signal.throwIfAborted();
    hydrated = true;
    if (service.state.value) state = service.state.value;
    unsubscribe = service.state.subscribe((next) => {
      state = next;
      render();
    });
    render();
  } catch (error) {
    abort();
    unsubscribe();
    await binding.dispose(BACKGROUND_CONTEXT);
    root.replaceChildren();
    throw error;
  }
  // Opening the view is what asks for data; a recent read is shown as is.
  if (
    !state.refreshing &&
    (state.status !== "ready" ||
      !state.fetchedAt ||
      Date.now() - Date.parse(state.fetchedAt) > STALE_AFTER_MS)
  )
    refresh();
  return async () => {
    abort();
    unsubscribe();
    host.signal.removeEventListener("abort", abort);
    await binding.dispose(BACKGROUND_CONTEXT);
    root.replaceChildren();
  };
}

function relativeShort(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

function relativeLong(iso: string, now = Date.now()): string {
  const short = relativeShort(iso, now);
  if (short === "now") return "just now";
  const match = /^(\d+)([mhd])$/.exec(short);
  if (!match) return `on ${short}`;
  const unit = { m: "min", h: "hr", d: "day" }[match[2] as "m" | "h" | "d"];
  const plural = unit === "day" && match[1] !== "1" ? "s" : "";
  return `${match[1]} ${unit}${plural} ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
