import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DesktopViewContext } from "@pi-gui/extension-ui/browser";
import {
  Trace,
  type ModelSpan,
  type Outcome,
  type Run,
  type Span,
  type TraceState,
} from "./contract.ts";
import {
  callContext,
  formatDuration,
  formatPercent,
  formatTokens,
  runTitle,
  runTotals,
  spanTitle,
  treeOrder,
} from "./format.ts";
import { promptTokens } from "./trace.ts";

const STYLES = `
*{box-sizing:border-box}
html,body{margin:0;background:var(--background)}
.trace{
  --fg:var(--foreground);
  --muted:color-mix(in srgb,var(--fg) 56%,transparent);
  --faint:color-mix(in srgb,var(--fg) 36%,transparent);
  --line:color-mix(in srgb,var(--fg) 10%,transparent);
  --hover:color-mix(in srgb,var(--fg) 5%,transparent);
  --selected:color-mix(in srgb,var(--accent) 12%,transparent);
  --track:color-mix(in srgb,var(--fg) 7%,transparent);
  --s-run:color-mix(in srgb,var(--fg) 34%,transparent);
  --s-turn:color-mix(in srgb,var(--fg) 20%,transparent);
  --s-model:#3f7be0;--s-tool:#3d9c74;--s-compaction:#8a6fd6;--s-error:#d64a4a;
  container:trace/inline-size;
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
  font-size:13px;line-height:1.45;color:var(--fg);background:var(--background);
  padding:20px 20px 28px;min-height:100vh;-webkit-font-smoothing:antialiased;
}
button,select{font:inherit;color:inherit}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.muted{color:var(--muted)}
h1{font-size:15px;font-weight:600;margin:0}
h2{font-size:12px;font-weight:500;color:var(--muted);margin:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.picker{position:relative;display:inline-flex;align-items:center;white-space:nowrap}
.picker select{appearance:none;-webkit-appearance:none;border:0;background:none;padding:3px 18px 3px 6px;border-radius:6px;cursor:pointer;color:var(--fg);max-width:220px;text-overflow:ellipsis}
.picker select:hover{background:var(--hover)}
.picker svg{position:absolute;right:4px;width:10px;height:10px;pointer-events:none;color:var(--muted)}
.picker select:focus-visible,.row:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 70%,transparent);outline-offset:-2px}
.status{display:flex;align-items:center;gap:8px;margin:6px 0 0;color:var(--muted)}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--s-tool);box-shadow:0 0 0 0 color-mix(in srgb,var(--s-tool) 60%,transparent);animation:pulse 1.6s ease-out infinite}
@keyframes pulse{to{box-shadow:0 0 0 6px transparent}}
.badge{font-size:11px;padding:0 6px;border-radius:4px;background:var(--track);color:var(--muted)}
.badge.error{color:var(--s-error);background:color-mix(in srgb,var(--s-error) 12%,transparent)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));column-gap:20px;margin:14px 0 0}
.stat{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid var(--line);min-width:0}
.stat dt{color:var(--muted);white-space:nowrap}
.stat dd{margin:0;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.waterfall{margin-top:22px;--name:minmax(140px,36%);--dur:58px}
.axis,.row{display:grid;grid-template-columns:var(--name) minmax(0,1fr) var(--dur);column-gap:10px;align-items:center}
.axis{padding:0 0 6px;border-bottom:1px solid var(--line);color:var(--faint);font-size:11px}
.ticks{position:relative;height:16px}
.ticks span{position:absolute;top:0;transform:translateX(-50%);font-variant-numeric:tabular-nums;white-space:nowrap}
.ticks span:first-child{transform:none}
.rows{list-style:none;margin:0;padding:0;position:relative}
.row{all:unset;box-sizing:border-box;display:grid;grid-template-columns:var(--name) minmax(0,1fr) var(--dur);column-gap:10px;align-items:center;width:100%;height:28px;padding:0 2px 0 0;border-radius:5px;cursor:pointer}
.row:hover{background:var(--hover)}
.row[aria-current=true]{background:var(--selected)}
.name{display:flex;align-items:center;gap:6px;min-width:0;padding-left:calc(var(--depth) * 14px + 4px)}
.name .dot{width:8px;height:8px;border-radius:2px;flex:none;background:var(--c)}
.name .label{white-space:nowrap}
.name .meta{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.name .meta.ctx{font-variant-numeric:tabular-nums}
.lane{position:relative;height:100%}
.lane::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(to right,transparent 0,transparent calc(var(--grid) - 1px),var(--line) calc(var(--grid) - 1px),var(--line) var(--grid));opacity:.6;pointer-events:none}
.bar{position:absolute;top:50%;height:10px;margin-top:-5px;min-width:2px;border-radius:3px;background:var(--c);display:flex;overflow:hidden}
.bar .wait{height:100%;background:color-mix(in srgb,var(--c) 38%,var(--background))}
.bar[data-open=true]{background-image:linear-gradient(90deg,transparent 0,transparent 60%,color-mix(in srgb,var(--background) 35%,transparent) 100%);background-size:24px 100%;animation:flow 0.9s linear infinite}
@keyframes flow{from{background-position:0 0}to{background-position:24px 0}}
.bar[data-outcome=aborted]{opacity:.45}
.row .dur{color:var(--muted)}
.row[data-outcome=error] .dur,.row[data-outcome=error] .label{color:var(--s-error)}
.k-run{--c:var(--s-run)}.k-turn{--c:var(--s-turn)}.k-model{--c:var(--s-model)}.k-tool{--c:var(--s-tool)}.k-compaction{--c:var(--s-compaction)}
.row[data-outcome=error]{--c:var(--s-error)}
.detail{margin-top:20px;border-top:1px solid var(--line);padding-top:14px}
.detail-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:6px}
.detail-head h3{font-size:13px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:18px;margin:0}
.facts dt{color:var(--muted);padding:5px 0}
.facts dd{margin:0;padding:5px 0;font-variant-numeric:tabular-nums;min-width:0;overflow-wrap:anywhere}
.meter{display:flex;align-items:center;gap:8px}
.meter .track{flex:1;max-width:160px;height:4px;border-radius:2px;background:var(--track);overflow:hidden}
.meter .track span{display:block;height:100%;background:var(--s-model)}
.phases{display:flex;height:6px;border-radius:3px;overflow:hidden;max-width:220px;margin-top:4px;background:var(--track)}
.phases span:first-child{background:color-mix(in srgb,var(--s-model) 38%,var(--background))}
.phases span:last-child{background:var(--s-model)}
pre{margin:4px 0 0;padding:8px 10px;border-radius:6px;background:var(--track);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}
.block{margin-top:12px}
.empty{padding:28px 0}
.empty p{margin:0 0 4px}
.note{color:var(--faint);font-size:12px;margin:12px 0 0}
@container trace (max-width:520px){
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .waterfall{--name:minmax(120px,48%);--dur:50px}
}
`;

const CHEVRON_ICON =
  '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.8 5 6.6 8 3.8"/></svg>';

/** Tick steps in ms; the axis uses the first that gives at most three ticks after zero. */
const STEPS = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
];

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name === "class") node.className = String(value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children)
    if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** The run itself is the tree's root row; its spans hang below it. */
type Row = { kind: "run"; run: Run; depth: 0 } | { kind: "span"; span: Span; depth: number };

const outcomeText: Record<Outcome, string> = { ok: "Done", error: "Failed", aborted: "Stopped" };

export async function mount(root: HTMLElement, host: DesktopViewContext): Promise<() => void> {
  host.signal.throwIfAborted();
  const style = h("style");
  style.textContent = STYLES;
  const view = h("main", { class: "trace" });
  // The frame document sets --background/--foreground/--accent and updates them on theme changes.
  root.replaceChildren(style, view);

  let state: TraceState | null = null;
  /** The run shown; `null` follows the newest run as replies arrive. */
  let pinnedRun: string | null = null;
  let selected: string | null = null;
  let error = "";
  let disposed = false;
  let frame = 0;

  const shownRun = (): Run | undefined => {
    const runs = state?.runs ?? [];
    return (pinnedRun && runs.find((run) => run.id === pinnedRun)) || runs.at(-1);
  };

  // The header stays put across renders so the reply picker keeps focus and stays open.
  const select = h("select", { "aria-label": "Reply", "data-testid": "trace-run-picker" });
  select.onchange = () => {
    pinnedRun = select.value === state?.runs.at(-1)?.id ? null : select.value;
    selected = null;
    render();
  };
  const picker = h("span", { class: "picker" }, select);
  picker.insertAdjacentHTML("beforeend", CHEVRON_ICON);
  const status = h("p", { class: "status", "data-testid": "trace-status" });
  const body = h("div", {});
  view.append(
    h("header", {}, h("div", { class: "top" }, h("h1", {}, "Trace"), picker), status),
    body,
  );
  let pickerOptions = "";

  const render = () => {
    if (disposed) return;
    const run = shownRun();
    syncHeader(run);
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.id;
    const children: Child[] = [];
    if (error) children.push(h("p", { class: "note", role: "alert" }, error));
    if (!state) {
      children.push(h("p", { class: "muted empty" }, "Connecting…"));
    } else if (!run) {
      children.push(
        h(
          "div",
          { class: "empty" },
          h("p", {}, "No replies traced yet."),
          h(
            "p",
            { class: "muted" },
            "Send a message in this thread. Each model call and tool call shows up here as it happens, with the context it sent.",
          ),
        ),
      );
    } else {
      const rows: Row[] = [
        { kind: "run", run, depth: 0 },
        ...treeOrder(run).map(({ span, depth }) => ({
          kind: "span" as const,
          span,
          depth: depth + 1,
        })),
      ];
      if (!selected || !rows.some((row) => rowId(row) === selected)) selected = run.id;
      children.push(stats(run), waterfall(run, rows), detail(run, rows));
      if (run.dropped)
        children.push(h("p", { class: "note" }, `${run.dropped} more spans not shown.`));
    }
    body.replaceChildren(...children.filter((child): child is Node => child instanceof Node));
    if (focused) body.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"]`)?.focus();
    layout();
  };

  const syncHeader = (run: Run | undefined) => {
    const runs = state?.runs ?? [];
    picker.hidden = runs.length === 0;
    const options = runs
      .map((candidate) => `${candidate.id}:${candidate.endedAt === null ? "live" : ""}`)
      .join(",");
    if (options !== pickerOptions) {
      pickerOptions = options;
      select.replaceChildren(
        ...[...runs]
          .reverse()
          .map((candidate) =>
            h(
              "option",
              { value: candidate.id },
              `${runTitle(candidate)}${candidate.endedAt === null ? " · live" : ""}`,
            ),
          ),
      );
    }
    select.value = run?.id ?? "";
    status.hidden = !run;
    if (!run) return;
    const started = new Date(run.startedAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
    status.replaceChildren(
      ...(run.endedAt === null
        ? [h("span", { class: "live-dot", "aria-hidden": "true" }), "Running"]
        : [outcomeText[run.outcome ?? "ok"]]),
      ` · started ${started}`,
    );
  };

  const stats = (run: Run) => {
    const totals = runTotals(run, Date.now());
    const stat = (label: string, value: string, testId: string, title?: string) =>
      h(
        "div",
        { class: "stat" },
        h("dt", {}, label),
        h("dd", { "data-testid": testId, ...(title ? { title } : {}) }, value),
      );
    const peak = totals.peak;
    return h(
      "dl",
      { class: "stats" },
      stat("Time", formatDuration(totals.durationMs), "trace-duration"),
      stat("Model calls", String(totals.modelCalls), "trace-model-calls"),
      stat("Tool calls", String(totals.toolCalls), "trace-tool-calls"),
      stat(
        "Peak context",
        peak ? callContext(peak) : "—",
        "trace-peak-context",
        "The largest prompt any model call in this reply sent",
      ),
    );
  };

  const waterfall = (run: Run, rows: Row[]) => {
    const list = h("ol", { class: "rows", role: "tree", "aria-label": `${runTitle(run)} spans` });
    for (const row of rows) list.append(h("li", { role: "none" }, rowButton(row)));
    return h(
      "section",
      { class: "waterfall", "aria-label": "Waterfall" },
      h(
        "div",
        { class: "axis", "aria-hidden": "true" },
        h("span", {}, "Span"),
        h("div", { class: "ticks" }),
        h("span", { class: "num" }, "Time"),
      ),
      list,
    );
  };

  const rowButton = (row: Row) => {
    const id = rowId(row);
    const kind = row.kind === "run" ? "run" : row.span.kind;
    const startedAt = row.kind === "run" ? row.run.startedAt : row.span.startedAt;
    const endedAt = row.kind === "run" ? row.run.endedAt : row.span.endedAt;
    const outcome = row.kind === "run" ? row.run.outcome : row.span.outcome;
    const title = row.kind === "run" ? runTitle(row.run) : spanTitle(row.span);
    const meta =
      row.kind === "span" && row.span.kind === "model" && row.span.endedAt !== null
        ? h("span", { class: "meta ctx", title: "Context sent" }, callContext(row.span))
        : row.kind === "span" && row.span.kind === "tool" && row.span.summary
          ? h("span", { class: "meta" }, row.span.summary)
          : null;
    const bar = h("span", {
      class: "bar",
      "data-start": startedAt,
      "data-end": endedAt ?? "",
      "data-open": String(endedAt === null),
      "data-outcome": outcome ?? "",
    });
    if (row.kind === "span" && row.span.kind === "model" && row.span.firstResponseAt !== null) {
      // The lighter part is waiting on the request; the solid part is the response streaming in.
      const wait = h("span", { class: "wait", "data-first": row.span.firstResponseAt });
      bar.append(wait);
    }
    const button = h(
      "button",
      {
        class: `row k-${kind}`,
        type: "button",
        role: "treeitem",
        "aria-level": row.depth + 1,
        "aria-current": String(id === selected),
        "data-testid": "trace-row",
        "data-id": id,
        "data-kind": kind,
        "data-title": title,
        "data-depth": row.depth,
        "data-outcome": outcome ?? "",
        "data-open": String(endedAt === null),
        style: `--depth:${row.depth}`,
      },
      h(
        "span",
        { class: "name" },
        h("span", { class: "dot", "aria-hidden": "true" }),
        h("span", { class: "label" }, title),
        meta,
      ),
      h("span", { class: "lane" }, bar),
      h("span", { class: "num dur", "data-start": startedAt, "data-end": endedAt ?? "" }),
    );
    button.onclick = () => {
      selected = id;
      render();
    };
    return button;
  };

  const detail = (run: Run, rows: Row[]) => {
    const row = rows.find((candidate) => rowId(candidate) === selected) ?? rows[0]!;
    const facts = h("dl", { class: "facts" });
    const fact = (label: string, value: Child, testId?: string) =>
      facts.append(h("dt", {}, label), h("dd", testId ? { "data-testid": testId } : {}, value));
    const now = Date.now();
    const blocks: Node[] = [];
    let title: string;
    let badge: Outcome | null;
    if (row.kind === "run") {
      title = runTitle(run);
      badge = run.outcome;
      const totals = runTotals(run, now);
      fact("Time", formatDuration(totals.durationMs));
      fact("Model calls", String(totals.modelCalls));
      fact("Tool calls", String(totals.toolCalls));
      fact("Tokens", `${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out`);
      fact("Peak context", totals.peak ? contextMeter(totals.peak) : "—");
    } else {
      const span = row.span;
      title = spanTitle(span);
      badge = span.outcome;
      fact("Started", `+${formatDuration(span.startedAt - run.startedAt)}`);
      fact(
        "Time",
        h("span", { "data-start": span.startedAt, "data-end": span.endedAt ?? "", class: "dur" }),
        "trace-detail-time",
      );
      if (span.kind === "model") modelFacts(span, fact, now);
      if (span.kind === "turn") {
        const inside = run.spans.filter((candidate) => candidate.parentId === span.id);
        fact("Tool calls", String(inside.filter((candidate) => candidate.kind === "tool").length));
      }
      if (span.kind === "compaction") {
        fact(
          "Reason",
          {
            manual: "You ran /compact",
            threshold: "Context reached the threshold",
            overflow: "The model said the context was too long",
          }[span.reason],
        );
        if (span.error) fact("Error", span.error);
      }
      if (span.kind === "tool") {
        if (span.args && span.args !== "{}")
          blocks.push(
            h(
              "div",
              { class: "block" },
              h("h2", {}, "Arguments"),
              h("pre", { "data-testid": "trace-args" }, span.args),
            ),
          );
        if (span.result !== null)
          blocks.push(
            h(
              "div",
              { class: "block" },
              h("h2", {}, span.outcome === "error" ? "Error" : "Result"),
              h("pre", { "data-testid": "trace-result" }, span.result || "(empty)"),
            ),
          );
      }
    }
    return h(
      "section",
      { class: "detail", "data-testid": "trace-detail", "aria-label": "Selected span" },
      h(
        "div",
        { class: "detail-head" },
        h(
          "h3",
          {},
          title,
          badge === null
            ? h("span", { class: "badge" }, "Running")
            : badge === "ok"
              ? null
              : h(
                  "span",
                  { class: `badge ${badge === "error" ? "error" : ""}` },
                  outcomeText[badge],
                ),
        ),
      ),
      facts,
      ...blocks,
    );
  };

  const modelFacts = (
    span: ModelSpan,
    fact: (label: string, value: Child, testId?: string) => void,
    now: number,
  ) => {
    fact("Model", span.model);
    if (span.firstResponseAt !== null) {
      const wait = span.firstResponseAt - span.startedAt;
      const stream = (span.endedAt ?? now) - span.firstResponseAt;
      const phases = h(
        "div",
        { class: "phases", "aria-hidden": "true" },
        h("span", {}),
        h("span", {}),
      );
      (phases.firstChild as HTMLElement).style.flex = `${Math.max(wait, 1)} 1 0`;
      (phases.lastChild as HTMLElement).style.flex = `${Math.max(stream, 1)} 1 0`;
      fact(
        "First response",
        h(
          "span",
          {},
          `after ${formatDuration(wait)} · then ${formatDuration(stream)} streaming`,
          phases,
        ),
        "trace-first-response",
      );
    } else if (span.endedAt === null) {
      fact("First response", "Waiting…");
    }
    fact("Context sent", contextMeter(span), "trace-detail-context");
    if (span.usage) {
      const usage = span.usage;
      fact(
        "Tokens",
        `${formatTokens(usage.input)} new · ${formatTokens(usage.cacheRead)} cached${usage.cacheWrite ? ` · ${formatTokens(usage.cacheWrite)} written to cache` : ""} · ${formatTokens(usage.output)} out`,
        "trace-detail-tokens",
      );
    }
    if (span.stopReason) fact("Stop reason", span.stopReason);
    if (span.error) fact("Error", span.error);
  };

  const contextMeter = (span: ModelSpan): Node => {
    if (!span.usage) return document.createTextNode(span.endedAt === null ? "Sending…" : "—");
    const tokens = promptTokens(span.usage);
    if (!span.contextWindow) return document.createTextNode(formatTokens(tokens));
    const share = tokens / span.contextWindow;
    const fill = h("span", {});
    fill.style.width = `${Math.min(100, share * 100)}%`;
    return h(
      "span",
      { class: "meter" },
      `${formatTokens(tokens)} of ${formatTokens(span.contextWindow)} · ${formatPercent(share)}`,
      h("span", { class: "track", "aria-hidden": "true" }, fill),
    );
  };

  /** Places bars on the run's time axis and fills durations; repeats each frame while live. */
  const layout = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    const run = shownRun();
    if (disposed || !run) return;
    const now = Date.now();
    const end = run.endedAt ?? now;
    const total = Math.max(end - run.startedAt, 1);
    const position = (time: number) => ((time - run.startedAt) / total) * 100;
    const step = STEPS.find((candidate) => total / candidate <= 3) ?? STEPS.at(-1)!;
    const ticks = view.querySelector<HTMLElement>(".ticks");
    if (ticks) {
      const labels: Node[] = [];
      for (let at = 0; at <= total; at += step) {
        const label = h("span", {}, at === 0 ? "0" : formatTick(at));
        label.style.left = `${(at / total) * 100}%`;
        labels.push(label);
      }
      // Drop a last label that would crowd the right edge.
      if (
        labels.length > 1 &&
        (total - (labels.length - 1) * step) / total < 0.08 &&
        labels.length > 2
      )
        labels.pop();
      ticks.replaceChildren(...labels);
    }
    const grid = `${(step / total) * 100}%`;
    for (const lane of view.querySelectorAll<HTMLElement>(".lane"))
      lane.style.setProperty("--grid", grid);
    for (const bar of view.querySelectorAll<HTMLElement>(".bar")) {
      const start = Number(bar.dataset.start);
      const stop = bar.dataset.end ? Number(bar.dataset.end) : now;
      bar.style.left = `${position(start)}%`;
      bar.style.width = `${Math.max(position(stop) - position(start), 0)}%`;
      const wait = bar.querySelector<HTMLElement>(".wait");
      if (wait)
        wait.style.width = `${((Math.min(Number(wait.dataset.first), stop) - start) / Math.max(stop - start, 1)) * 100}%`;
    }
    for (const cell of view.querySelectorAll<HTMLElement>(".dur")) {
      const start = Number(cell.dataset.start);
      const stop = cell.dataset.end ? Number(cell.dataset.end) : now;
      cell.textContent = formatDuration(stop - start);
    }
    if (run.endedAt === null) frame = requestAnimationFrame(layout);
  };

  const binding = host.services.open({
    services: [Trace],
    assertAccess: () => host.signal.throwIfAborted(),
    onError: (reason) => {
      error = reason instanceof Error ? reason.message : String(reason);
      render();
    },
  });
  const service = binding.use(Trace);

  let unsubscribe = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    unsubscribe();
    host.signal.removeEventListener("abort", dispose);
    binding.dispose(BACKGROUND_CONTEXT).catch(() => {});
    root.replaceChildren();
  };
  host.signal.addEventListener("abort", dispose, { once: true });
  render();
  try {
    await binding.ready(BACKGROUND_CONTEXT);
    host.signal.throwIfAborted();
    unsubscribe = service.state.subscribe((next) => {
      state = next;
      render();
    });
    if (service.state.value) state = service.state.value;
    render();
  } catch (reason) {
    dispose();
    throw reason;
  }
  return dispose;
}

function rowId(row: Row): string {
  return row.kind === "run" ? row.run.id : row.span.id;
}

function formatTick(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${ms / 1_000}s`;
  return `${ms / 60_000}m`;
}
