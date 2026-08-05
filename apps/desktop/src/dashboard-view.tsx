import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DashboardPeriodModels,
  DashboardUsageByDay,
  DashboardUsageByModel,
  DashboardUsagePeriodKind,
  DashboardUsageSnapshot,
} from "./ipc";
import type { SessionRecord, WorkspaceRecord } from "./desktop-state";
import { DashboardIcon, RefreshIcon } from "./icons";
import { formatRelativeTime } from "./string-utils";

interface DashboardViewProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly onOpenSession: (workspaceId: string, sessionId: string) => void;
}

interface SessionWithWorkspace {
  readonly workspace: WorkspaceRecord;
  readonly session: SessionRecord;
}

interface WindowEntry {
  readonly key: string;
  readonly bucket: DashboardUsageByDay;
}

const COLUMNS = [
  { kind: "running", label: "Running" },
  { kind: "idle", label: "Idle" },
  { kind: "archived", label: "Archived" },
] as const;

type ColumnKind = (typeof COLUMNS)[number]["kind"];

const WINDOW_SIZES: Record<DashboardUsagePeriodKind, number> = { day: 14, week: 12, year: 6 };
const GRANULARITY_LABELS: Record<DashboardUsagePeriodKind, string> = {
  day: "Day",
  week: "Week",
  year: "Year",
};

export function DashboardView({ workspaces, onOpenSession }: DashboardViewProps) {
  const [usage, setUsage] = useState<DashboardUsageSnapshot | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [granularity, setGranularity] = useState<DashboardUsagePeriodKind>("day");
  const [anchor, setAnchor] = useState(() => todayKey());
  const [selected, setSelected] = useState<{ kind: DashboardUsagePeriodKind; key: string } | null>(null);
  const [periodDetail, setPeriodDetail] = useState<DashboardPeriodModels | null>(null);
  const [periodError, setPeriodError] = useState<string | null>(null);

  const loadUsage = useCallback(() => {
    setUsageError(null);
    const api = window.piApp;
    if (!api) {
      return;
    }
    void api.getDashboardUsage().then(
      (snapshot) => setUsage(snapshot),
      (error: unknown) => setUsageError(error instanceof Error ? error.message : String(error)),
    );
  }, []);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const allSessions = useMemo<readonly SessionWithWorkspace[]>(
    () =>
      workspaces.flatMap((workspace) =>
        workspace.sessions.map((session) => ({ workspace, session })),
      ),
    [workspaces],
  );

  const filteredSessions = useMemo(
    () =>
      workspaceFilter === "all"
        ? allSessions
        : allSessions.filter((entry) => entry.workspace.id === workspaceFilter),
    [allSessions, workspaceFilter],
  );

  const columns = useMemo(() => {
    const group: Record<ColumnKind, SessionWithWorkspace[]> = {
      running: [],
      idle: [],
      archived: [],
    };
    for (const entry of filteredSessions) {
      if (entry.session.archivedAt) {
        group.archived.push(entry);
      } else if (entry.session.status === "running") {
        group.running.push(entry);
      } else {
        group.idle.push(entry);
      }
    }
    return group;
  }, [filteredSessions]);

  const windowSize = WINDOW_SIZES[granularity];
  const today = todayKey();

  const anchorKey = useMemo(() => {
    if (granularity === "day") {
      return anchor;
    }
    if (granularity === "week") {
      return mondayKeyOf(anchor);
    }
    return anchor.slice(0, 4);
  }, [granularity, anchor]);

  const buckets = useMemo(() => {
    if (!usage) {
      return [];
    }
    return granularity === "day" ? usage.days : granularity === "week" ? usage.weeks : usage.years;
  }, [usage, granularity]);

  const windowEntries = useMemo<readonly WindowEntry[]>(
    () => buildWindow(buckets, granularity, anchorKey, windowSize),
    [buckets, granularity, anchorKey, windowSize],
  );

  const windowTotals = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let reasoningTokens = 0;
    let cost = 0;
    for (const entry of windowEntries) {
      inputTokens += entry.bucket.inputTokens;
      outputTokens += entry.bucket.outputTokens;
      cacheReadTokens += entry.bucket.cacheReadTokens;
      reasoningTokens += entry.bucket.reasoningTokens;
      cost += entry.bucket.cost;
    }
    return { inputTokens, outputTokens, cacheReadTokens, reasoningTokens, cost };
  }, [windowEntries]);

  const maxTokens = useMemo(
    () => Math.max(1, ...windowEntries.map((entry) => entry.bucket.inputTokens + entry.bucket.outputTokens)),
    [windowEntries],
  );

  const cacheHitRate = useMemo(() => {
    const total = windowTotals.cacheReadTokens + windowTotals.inputTokens;
    return total > 0 ? windowTotals.cacheReadTokens / total : 0;
  }, [windowTotals]);

  const handleGranularityChange = (kind: DashboardUsagePeriodKind) => {
    setGranularity(kind);
    setSelected(null);
    setPeriodDetail(null);
    setPeriodError(null);
  };

  const shiftAnchor = (direction: -1 | 1) => {
    if (granularity === "day") {
      setAnchor(addDays(anchor, direction));
    } else if (granularity === "week") {
      setAnchor(addDays(anchor, direction * 7));
    } else {
      const date = parseKey(anchor);
      date.setFullYear(date.getFullYear() + direction);
      setAnchor(dateKeyOf(date));
    }
  };

  const handleSelectPeriod = (entry: WindowEntry) => {
    const kind = granularity;
    const key = entry.key;
    setSelected({ kind, key });
    setPeriodDetail(null);
    setPeriodError(null);
    const api = window.piApp;
    if (!api) {
      return;
    }
    void api.getDashboardPeriodModels({ kind, key }).then(
      (detail) => setPeriodDetail(detail),
      (error: unknown) => setPeriodError(error instanceof Error ? error.message : String(error)),
    );
  };

  const labelEvery = window.length > 15 ? 5 : 1;

  return (
    <section className="canvas canvas--dashboard">
      <div className="dashboard">
        <header className="dashboard__header">
          <div className="dashboard__heading">
            <h1>Dashboard</h1>
            <span className="dashboard__subtitle">Threads and token usage across workspaces</span>
          </div>
          <div className="dashboard__controls">
            <label className="dashboard__filter">
              <span>Workspace</span>
              <select value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}>
                <option value="all">All</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="dashboard__refresh" type="button" onClick={loadUsage} disabled={!usage && !usageError}>
              <RefreshIcon />
              <span>Refresh</span>
            </button>
          </div>
        </header>

        <div className="dashboard__section">
          <h2 className="dashboard__section-title">Usage</h2>
          {usageError ? (
            <div className="dashboard__notice dashboard__notice--error" role="status">
              Failed to load usage: {usageError}
            </div>
          ) : !usage ? (
            <div className="dashboard__notice">Loading usage…</div>
          ) : (
            <div className="dashboard__usage">
              <div className="dashboard__kpis">
                <div className="kpi-card">
                  <span className="kpi-card__label">Window tokens</span>
                  <span className="kpi-card__value">
                    {formatTokens(windowTotals.inputTokens + windowTotals.outputTokens + windowTotals.reasoningTokens)}
                  </span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-card__label">Window cost</span>
                  <span className="kpi-card__value">{formatCost(windowTotals.cost)}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-card__label">Total cost</span>
                  <span className="kpi-card__value">{formatCost(usage.totals.cost)}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-card__label">Cache hit rate</span>
                  <span className="kpi-card__value">{(cacheHitRate * 100).toFixed(0)}%</span>
                </div>
              </div>

              <div className="chart">
                <div className="chart__toolbar">
                  <div className="chart__tabs" role="tablist" aria-label="Granularity">
                    {(["day", "week", "year"] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        role="tab"
                        aria-selected={granularity === kind}
                        className={`chart__tab ${granularity === kind ? "chart__tab--active" : ""}`}
                        onClick={() => handleGranularityChange(kind)}
                      >
                        {GRANULARITY_LABELS[kind]}
                      </button>
                    ))}
                  </div>
                  <div className="chart__nav">
                    <button type="button" className="chart__nav-btn" onClick={() => shiftAnchor(-1)} aria-label="Earlier">
                      ‹
                    </button>
                    <label className="chart__date">
                      <span>{granularity === "day" ? "Ends" : granularity === "week" ? "Week of" : "Year"}</span>
                      <input
                        type="date"
                        value={anchor}
                        max={today}
                        onChange={(event) => {
                          if (event.target.value) {
                            setAnchor(event.target.value);
                          }
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="chart__nav-btn"
                      onClick={() => shiftAnchor(1)}
                      disabled={anchorKey >= todayAnchorKey(granularity)}
                      aria-label="Later"
                    >
                      ›
                    </button>
                  </div>
                </div>

                <div className="bar-chart" role="img" aria-label={`Token usage per ${granularity}`}>
                  {windowEntries.map((entry, index) => {
                    const total = entry.bucket.inputTokens + entry.bucket.outputTokens;
                    const height = Math.max(2, Math.round((total / maxTokens) * 100));
                    const isSelected = selected?.kind === granularity && selected.key === entry.key;
                    return (
                      <div
                        key={entry.key}
                        className={`bar-chart__bar-wrap ${isSelected ? "bar-chart__bar-wrap--selected" : ""}`}
                        title={`${periodTitle(granularity, entry.key)}: ${formatTokens(total)} tokens · ${formatCost(entry.bucket.cost)}`}
                      >
                        <button
                          type="button"
                          className="bar-chart__bar"
                          style={{ height: `${height}%` }}
                          onClick={() => handleSelectPeriod(entry)}
                          aria-label={`Select ${periodTitle(granularity, entry.key)}`}
                        />
                        {index % labelEvery === 0 ? (
                          <span className="bar-chart__label">{barLabel(granularity, entry.key)}</span>
                        ) : (
                          <span className="bar-chart__label bar-chart__label--empty" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {selected ? (
                <div className="chart">
                  <div className="chart__head">
                    <h3>{periodTitle(selected.kind, selected.key)}</h3>
                    <button
                      type="button"
                      className="chart__clear"
                      onClick={() => {
                        setSelected(null);
                        setPeriodDetail(null);
                        setPeriodError(null);
                      }}
                    >
                      × Show all-time
                    </button>
                  </div>
                  {periodError ? (
                    <div className="dashboard__notice dashboard__notice--error">{periodError}</div>
                  ) : !periodDetail ? (
                    <div className="dashboard__notice">Loading period…</div>
                  ) : (
                    <>
                      <div className="dashboard__kpis">
                        <div className="kpi-card">
                          <span className="kpi-card__label">Tokens</span>
                          <span className="kpi-card__value">
                            {formatTokens(periodDetail.totals.inputTokens + periodDetail.totals.outputTokens + periodDetail.totals.reasoningTokens)}
                          </span>
                        </div>
                        <div className="kpi-card">
                          <span className="kpi-card__label">Cost</span>
                          <span className="kpi-card__value">{formatCost(periodDetail.totals.cost)}</span>
                        </div>
                        <div className="kpi-card">
                          <span className="kpi-card__label">Cache read</span>
                          <span className="kpi-card__value">{formatTokens(periodDetail.totals.cacheReadTokens)}</span>
                        </div>
                      </div>
                      {periodDetail.models.length === 0 ? (
                        <div className="dashboard__notice">No usage in this period.</div>
                      ) : (
                        <ModelBars models={periodDetail.models} />
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="chart">
                  <h3>Top models (all time)</h3>
                  {usage.byModel.length === 0 ? (
                    <div className="dashboard__notice">No usage recorded yet.</div>
                  ) : (
                    <ModelBars models={usage.byModel} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dashboard__section">
          <h2 className="dashboard__section-title">Threads</h2>
          <div className="kanban">
            {COLUMNS.map((column) => {
              const items = columns[column.kind];
              return (
                <div key={column.kind} className="kanban__column">
                  <h3 className="kanban__column-head">
                    {column.label}
                    <span className="kanban__count">{items.length}</span>
                  </h3>
                  <div className="kanban__cards">
                    {items.length === 0 ? (
                      <p className="kanban__empty">Nothing here</p>
                    ) : (
                      items.map(({ workspace, session }) => (
                        <button
                          key={session.id}
                          type="button"
                          className="kanban__card"
                          onClick={() => onOpenSession(workspace.id, session.id)}
                        >
                          <span className="kanban__card-title">{session.title || "Untitled"}</span>
                          <span className="kanban__card-preview">{session.preview || "No preview yet"}</span>
                          <span className="kanban__card-meta">
                            <span>{workspace.name}</span>
                            <span>{formatRelativeTime(session.updatedAt)}</span>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <footer className="dashboard__footer">
          <DashboardIcon />
          <span>Dashboard is read-only. Open a card to continue a thread.</span>
        </footer>
      </div>
    </section>
  );
}

function ModelBars({ models }: { readonly models: readonly DashboardUsageByModel[] }) {
  const maxCost = Math.max(1, ...models.map((entry) => entry.cost));
  return (
    <ul className="model-bars">
      {models.map((entry) => (
        <li key={`${entry.provider}/${entry.model}`} className="model-bar">
          <span className="model-bar__label">
            {entry.model}
            <span className="model-bar__meta">
              {entry.provider} · {entry.messages} msgs · {formatTokens(entry.inputTokens + entry.outputTokens + entry.reasoningTokens)} ·{" "}
              {formatCost(entry.cost)}
            </span>
          </span>
          <span className="model-bar__track">
            <span
              className="model-bar__fill"
              style={{ width: `${Math.max(1, Math.round((entry.cost / maxCost) * 100))}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

function buildWindow(
  buckets: readonly DashboardUsageByDay[],
  kind: DashboardUsagePeriodKind,
  anchorKey: string,
  size: number,
): WindowEntry[] {
  const map = new Map(buckets.map((bucket) => [bucket.date, bucket]));
  const todayAnchor = todayAnchorKey(kind);
  const end = anchorKey > todayAnchor ? todayAnchor : anchorKey;
  const out: WindowEntry[] = [];
  const zero = (key: string): DashboardUsageByDay => ({
    date: key,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    cost: 0,
  });
  for (let i = size - 1; i >= 0; i -= 1) {
    const key =
      kind === "day"
        ? addDays(end, -i)
        : kind === "week"
          ? addDays(end, -7 * i)
          : String(Number(end) - i);
    out.push({ key, bucket: map.get(key) ?? zero(key) });
  }
  return out;
}

function todayAnchorKey(kind: DashboardUsagePeriodKind): string {
  const today = todayKey();
  return kind === "day" ? today : kind === "week" ? mondayKeyOf(today) : today.slice(0, 4);
}

function todayKey(): string {
  return dateKeyOf(new Date());
}

function dateKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseKey(key: string): Date {
  const [y = 0, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key: string, days: number): string {
  const date = parseKey(key);
  date.setDate(date.getDate() + days);
  return dateKeyOf(date);
}

function mondayKeyOf(key: string): string {
  const date = parseKey(key);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return dateKeyOf(date);
}

function barLabel(kind: DashboardUsagePeriodKind, key: string): string {
  return kind === "year" ? key : key.slice(5);
}

function periodTitle(kind: DashboardUsagePeriodKind, key: string): string {
  if (kind === "day") {
    return key;
  }
  if (kind === "week") {
    return `Week of ${key}`;
  }
  return key;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(Math.round(value));
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}
