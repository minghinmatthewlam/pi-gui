import { useMemo, useState } from "react";
import type {
  DesktopAppState,
  ScheduledTaskFilter,
  ScheduledTaskRecord,
} from "../../../contracts/desktop-state";
import {
  filterScheduledTasks,
  formatScheduledTaskRowMeta,
} from "../../../contracts/scheduled-tasks";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { Dispatch, SetStateAction } from "react";
import type { ScheduledEditorState } from "./scheduled-task-editor";

interface ScheduledTasksViewProps {
  readonly tasks: readonly ScheduledTaskRecord[];
  readonly lastError?: string;
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly onCreateWithPi: () => void;
  readonly onOpenEditor: (editor: ScheduledEditorState) => void;
}

const FILTERS: readonly { readonly id: ScheduledTaskFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "completed", label: "Completed" },
];

export function ScheduledTasksView({
  tasks,
  lastError,
  api,
  setSnapshot,
  updateSnapshot,
  onCreateWithPi,
  onOpenEditor,
}: ScheduledTasksViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ScheduledTaskFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [menuTaskId, setMenuTaskId] = useState<string | undefined>();
  const visible = useMemo(() => filterScheduledTasks(tasks, filter, query), [tasks, filter, query]);

  return (
    <section className="canvas scheduled-tasks-view" data-testid="scheduled-tasks-view">
      <header className="view-header">
        <div>
          <h1 className="view-header__title">Scheduled tasks</h1>
          <p className="view-header__body">
            Ask pi to schedule tasks, set reminders, or monitor for updates.
          </p>
        </div>
        <div className="view-header__actions">
          <div className="scheduled-create">
            <button
              className="button button--primary"
              data-testid="scheduled-task-create"
              type="button"
              aria-haspopup="menu"
              aria-expanded={createOpen}
              onClick={() => setCreateOpen((open) => !open)}
            >
              Create
            </button>
            {createOpen ? (
              <div className="workspace-menu scheduled-create__menu" role="menu">
                <button
                  className="workspace-menu__item"
                  data-testid="scheduled-task-create-with-pi"
                  type="button"
                  onClick={() => {
                    setCreateOpen(false);
                    onCreateWithPi();
                  }}
                >
                  Create with pi
                </button>
                <button
                  className="workspace-menu__item"
                  data-testid="scheduled-task-setup-manually"
                  type="button"
                  onClick={() => {
                    setCreateOpen(false);
                    onOpenEditor({ mode: "create" });
                  }}
                >
                  Set up manually
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="scheduled-toolbar">
        <input
          aria-label="Search scheduled tasks"
          className="skills-search"
          data-testid="scheduled-task-search"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="scheduled-tabs" role="tablist">
          {FILTERS.map((entry) => (
            <button
              className={`scheduled-tabs__item${filter === entry.id ? " scheduled-tabs__item--active" : ""}`}
              data-testid={`scheduled-task-filter-${entry.id}`}
              key={entry.id}
              role="tab"
              type="button"
              aria-selected={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {lastError ? <p className="error-banner">{lastError}</p> : null}

      {visible.length === 0 ? (
        <div className="empty-panel" data-testid="scheduled-tasks-empty">
          <h2>{filter === "active" ? "No active scheduled tasks" : "No scheduled tasks"}</h2>
          <p>
            {filter === "active"
              ? "Scheduled tasks run on this device while pi-gui is open. They do not run in the cloud or after you quit."
              : "Create a task manually or ask pi to set one up."}
          </p>
        </div>
      ) : (
        <div className="scheduled-task-list">
          {visible.map((task) => (
            <article
              className="scheduled-task-row"
              data-testid="scheduled-task-row"
              data-task-id={task.id}
              key={task.id}
            >
              <button
                className="scheduled-task-row__body"
                type="button"
                onClick={() => onOpenEditor({ mode: "edit", taskId: task.id })}
              >
                <strong className="scheduled-task-row__title">{task.title}</strong>
                <span className="scheduled-task-row__meta">{formatScheduledTaskRowMeta(task)}</span>
              </button>
              <span className="scheduled-task-row__menu-wrap">
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Actions for ${task.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuTaskId === task.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuTaskId((current) => (current === task.id ? undefined : task.id));
                  }}
                >
                  …
                </button>
                {menuTaskId === task.id ? (
                  <div className="workspace-menu scheduled-task-row__menu" role="menu">
                    {task.status === "paused" ? (
                      <button
                        className="workspace-menu__item"
                        type="button"
                        onClick={() => {
                          setMenuTaskId(undefined);
                          void updateSnapshot(setSnapshot, () =>
                            api.updateScheduledTask(task.id, { status: "active" }),
                          ).catch((error: unknown) => {
                            console.error("[renderer] updateScheduledTask failed", error);
                          });
                        }}
                      >
                        Resume
                      </button>
                    ) : task.status !== "completed" ? (
                      <button
                        className="workspace-menu__item"
                        type="button"
                        onClick={() => {
                          setMenuTaskId(undefined);
                          void updateSnapshot(setSnapshot, () =>
                            api.updateScheduledTask(task.id, { status: "paused" }),
                          ).catch((error: unknown) => {
                            console.error("[renderer] updateScheduledTask failed", error);
                          });
                        }}
                      >
                        Pause
                      </button>
                    ) : null}
                    <button
                      className="workspace-menu__item"
                      type="button"
                      onClick={() => {
                        setMenuTaskId(undefined);
                        onOpenEditor({ mode: "edit", taskId: task.id });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="workspace-menu__item workspace-menu__item--danger"
                      type="button"
                      onClick={() => {
                        setMenuTaskId(undefined);
                        void updateSnapshot(setSnapshot, () =>
                          api.deleteScheduledTask(task.id),
                        ).catch((error: unknown) => {
                          console.error("[renderer] deleteScheduledTask failed", error);
                        });
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
