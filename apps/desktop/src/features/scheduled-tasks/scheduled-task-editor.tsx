import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  CreateScheduledTaskInput,
  ScheduledTaskRecord,
  ScheduledTaskSchedule,
  ScheduledTaskTarget,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import {
  hostTimeZone,
  MIN_SCHEDULE_INTERVAL_MS,
  MAX_SCHEDULE_INTERVAL_MS,
  WEEKDAY_NAMES,
  type Weekday,
} from "../../../contracts/scheduled-tasks";
import { trapDialogFocus } from "../../ui/dialog-focus";

export type ScheduledEditorState =
  | { readonly mode: "create"; readonly prefill?: Partial<CreateScheduledTaskInput> }
  | { readonly mode: "edit"; readonly taskId: string };

type FrequencyKind = ScheduledTaskSchedule["kind"];

interface ScheduledTaskEditorProps {
  readonly editor: ScheduledEditorState;
  readonly task?: ScheduledTaskRecord;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly busy: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateScheduledTaskInput) => void;
  readonly onOpenChat?: (target: { workspaceId: string; sessionId: string }) => void;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string {
  const date = new Date(value);
  return date.toISOString();
}

function defaultOnceValue(): string {
  return toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000).toISOString());
}

function timeFromSchedule(schedule: ScheduledTaskSchedule | undefined): string {
  if (schedule && (schedule.kind === "daily" || schedule.kind === "weekly")) {
    return `${pad(schedule.hour)}:${pad(schedule.minute)}`;
  }
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function parseTime(value: string): { hour: number; minute: number } {
  const [hourText, minuteText] = value.split(":");
  return { hour: Number(hourText), minute: Number(minuteText) };
}

export function ScheduledTaskEditor({
  editor,
  task,
  workspaces,
  selectedWorkspaceId,
  busy,
  error,
  onClose,
  onSubmit,
  onOpenChat,
}: ScheduledTaskEditorProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const source = editor.mode === "edit" ? task : undefined;
  const prefill = editor.mode === "create" ? editor.prefill : undefined;
  const [title, setTitle] = useState(source?.title ?? prefill?.title ?? "");
  const [instruction, setInstruction] = useState(source?.instruction ?? prefill?.instruction ?? "");
  const [frequency, setFrequency] = useState<FrequencyKind>(
    source?.schedule.kind ?? prefill?.schedule?.kind ?? "daily",
  );
  const [onceAt, setOnceAt] = useState(
    source?.schedule.kind === "once"
      ? toDatetimeLocalValue(source.schedule.at)
      : prefill?.schedule?.kind === "once"
        ? toDatetimeLocalValue(prefill.schedule.at)
        : defaultOnceValue(),
  );
  const [clock, setClock] = useState(timeFromSchedule(source?.schedule ?? prefill?.schedule));
  const [days, setDays] = useState<Weekday[]>(
    source?.schedule.kind === "weekly"
      ? [...source.schedule.days]
      : prefill?.schedule?.kind === "weekly"
        ? [...prefill.schedule.days]
        : [1],
  );
  const [timeZone] = useState(
    source?.schedule.kind === "daily" || source?.schedule.kind === "weekly"
      ? source.schedule.timeZone
      : prefill?.schedule &&
          (prefill.schedule.kind === "daily" || prefill.schedule.kind === "weekly")
        ? prefill.schedule.timeZone
        : hostTimeZone(),
  );
  const [intervalMinutes, setIntervalMinutes] = useState(
    source?.schedule.kind === "interval"
      ? Math.round(source.schedule.everyMs / 60_000)
      : prefill?.schedule?.kind === "interval"
        ? Math.round(prefill.schedule.everyMs / 60_000)
        : 10,
  );
  const initialTarget = source?.target ?? prefill?.target;
  const [workspaceId, setWorkspaceId] = useState(
    initialTarget?.workspaceId ?? selectedWorkspaceId ?? workspaces[0]?.id ?? "",
  );
  const [targetKind, setTargetKind] = useState<"new-thread" | "existing-thread">(
    initialTarget?.kind ?? "new-thread",
  );
  const [sessionId, setSessionId] = useState(
    initialTarget?.kind === "existing-thread" ? initialTarget.sessionId : "",
  );

  const workspace = workspaces.find((entry) => entry.id === workspaceId) ?? workspaces[0];
  const sessions = useMemo(
    () => (workspace?.sessions ?? []).filter((session) => !session.archivedAt),
    [workspace],
  );
  const canSubmit =
    title.trim().length > 0 &&
    instruction.trim().length > 0 &&
    Boolean(workspace) &&
    (targetKind !== "existing-thread" || Boolean(sessionId));
  const openChatTarget =
    source?.target.kind === "existing-thread"
      ? { workspaceId: source.target.workspaceId, sessionId: source.target.sessionId }
      : source?.runs.at(-1)
        ? { workspaceId: source.runs.at(-1)!.workspaceId, sessionId: source.runs.at(-1)!.sessionId }
        : undefined;

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
    }
  };

  const buildSchedule = (): ScheduledTaskSchedule | undefined => {
    if (frequency === "once") {
      if (!onceAt) {
        return undefined;
      }
      return { kind: "once", at: fromDatetimeLocalValue(onceAt) };
    }
    const parsed = parseTime(clock);
    if (frequency === "daily") {
      return {
        kind: "daily",
        hour: parsed.hour,
        minute: parsed.minute,
        timeZone,
      };
    }
    if (frequency === "weekly") {
      return {
        kind: "weekly",
        days: days.length > 0 ? days : [1],
        hour: parsed.hour,
        minute: parsed.minute,
        timeZone,
      };
    }
    const everyMs = Math.round(intervalMinutes) * 60_000;
    if (everyMs < MIN_SCHEDULE_INTERVAL_MS || everyMs > MAX_SCHEDULE_INTERVAL_MS) {
      return undefined;
    }
    return { kind: "interval", everyMs };
  };

  const buildTarget = (): ScheduledTaskTarget | undefined => {
    if (!workspaceId) {
      return undefined;
    }
    if (targetKind === "existing-thread") {
      if (!sessionId) {
        return undefined;
      }
      return { kind: "existing-thread", workspaceId, sessionId };
    }
    return { kind: "new-thread", workspaceId };
  };

  return (
    <div className="scheduled-editor-backdrop" onClick={onClose}>
      <div
        className="scheduled-editor"
        data-testid="scheduled-task-editor"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduled-editor-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="scheduled-editor__header">
          <h2 id="scheduled-editor-title">
            {editor.mode === "edit" ? "Edit scheduled task" : "Set up scheduled task"}
          </h2>
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <label className="scheduled-editor__field">
          <span>Title</span>
          <input
            data-testid="scheduled-task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Weekly status"
          />
        </label>
        <label className="scheduled-editor__field">
          <span>Instructions</span>
          <textarea
            data-testid="scheduled-task-instruction"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="What should pi do when this runs?"
            rows={5}
          />
        </label>

        <label className="scheduled-editor__field">
          <span>Workspace</span>
          <select
            data-testid="scheduled-task-workspace"
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              setSessionId("");
            }}
          >
            {workspaces.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="scheduled-editor__field">
          <legend>Runs in</legend>
          <label className="scheduled-editor__choice">
            <input
              type="radio"
              name="scheduled-target"
              checked={targetKind === "new-thread"}
              onChange={() => setTargetKind("new-thread")}
            />
            New thread for this task
          </label>
          <label className="scheduled-editor__choice">
            <input
              type="radio"
              name="scheduled-target"
              checked={targetKind === "existing-thread"}
              onChange={() => setTargetKind("existing-thread")}
            />
            Existing thread
          </label>
          {targetKind === "existing-thread" ? (
            <select
              data-testid="scheduled-task-session"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
            >
              <option value="">Select a thread</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          ) : null}
        </fieldset>

        <label className="scheduled-editor__field">
          <span>Frequency</span>
          <select
            data-testid="scheduled-task-frequency"
            value={frequency}
            onChange={(event) => setFrequency(event.target.value as FrequencyKind)}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="interval">Interval</option>
            <option value="once">Once</option>
          </select>
        </label>

        {frequency === "once" ? (
          <label className="scheduled-editor__field">
            <span>Run at</span>
            <input
              data-testid="scheduled-task-once-at"
              type="datetime-local"
              value={onceAt}
              onChange={(event) => setOnceAt(event.target.value)}
            />
          </label>
        ) : null}
        {frequency === "daily" || frequency === "weekly" ? (
          <label className="scheduled-editor__field">
            <span>Time</span>
            <input
              data-testid="scheduled-task-time"
              type="time"
              value={clock}
              onChange={(event) => setClock(event.target.value)}
            />
          </label>
        ) : null}
        {frequency === "weekly" ? (
          <fieldset className="scheduled-editor__field">
            <legend>Days</legend>
            <div className="scheduled-editor__days">
              {WEEKDAY_NAMES.map((name, index) => {
                const day = index as Weekday;
                const selected = days.includes(day);
                return (
                  <button
                    className={`scheduled-editor__day${selected ? " scheduled-editor__day--active" : ""}`}
                    key={name}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setDays((current) =>
                        current.includes(day)
                          ? current.filter((entry) => entry !== day)
                          : [...current, day].sort((left, right) => left - right),
                      )
                    }
                  >
                    {name.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}
        {frequency === "interval" ? (
          <label className="scheduled-editor__field">
            <span>Every (minutes)</span>
            <input
              data-testid="scheduled-task-interval"
              type="number"
              min={1}
              max={7 * 24 * 60}
              value={intervalMinutes}
              onChange={(event) => setIntervalMinutes(Number(event.target.value))}
            />
          </label>
        ) : null}

        {error ? <p className="scheduled-editor__error">{error}</p> : null}

        <div className="scheduled-editor__actions">
          {openChatTarget && onOpenChat ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => onOpenChat(openChatTarget)}
            >
              Open chat
            </button>
          ) : null}
          <button className="button button--secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button--primary"
            data-testid="scheduled-task-save"
            type="button"
            disabled={!canSubmit || busy}
            onClick={() => {
              const schedule = buildSchedule();
              const target = buildTarget();
              if (!schedule || !target) {
                return;
              }
              onSubmit({
                title: title.trim(),
                instruction: instruction.trim(),
                schedule,
                target,
              });
            }}
          >
            {editor.mode === "edit" ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
