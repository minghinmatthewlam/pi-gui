//! Scheduled tasks (`scheduled-tasks/app-store-scheduled-tasks.ts` and the store's timer):
//! saving `scheduled-tasks.json`, creating, editing and deleting tasks, the timer that fires
//! them, and the `scheduled.*` tool bodies pi calls through the host.
//!
//! Edits, claims and run results go through one mutation queue. A claim is saved before its
//! instruction is delivered, so quitting mid-run cannot fire it twice; delivery itself runs
//! outside the queue, since it lasts as long as the target's turn and that turn may call the
//! scheduled-task tools.

pub mod tools;

use super::dispatch::{self, MethodTable};
use super::refresh::{self, RefreshOptions};
use super::{conversation, publish, sessions, settings, workspace, Kernel};
use crate::error::{CoreError, CoreResult};
use crate::js;
use crate::state::app_store_utils::to_session_queued_messages;
use crate::state::desktop_state::{
    DesktopAppState, QueuedComposerMessage, ScheduledTaskRecord, ScheduledTaskRun,
    ScheduledTaskRunOutcome, ScheduledTaskSchedule, ScheduledTaskStatus, ScheduledTaskTarget,
};
use crate::state::driver::{
    session_key, SessionMessageDeliveryMode, SessionRef, SessionSnapshot, SessionStatus,
    SessionTranscriptRole,
};
use crate::state::scheduled_task_schedule::{
    earliest_scheduled_wake_at, next_run_at, ScheduledWake,
};
use crate::state::session_state::NEW_THREAD_PLACEHOLDER_TITLE;
use crate::state::timeline::{append_user_message, clear_active_assistant_message};
use crate::state::timeline_types::TranscriptMessage;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::rc::Rc;
use std::time::Duration;
use tokio::task::AbortHandle;

/// `MAX_SCHEDULED_TASK_RUNS`.
const MAX_SCHEDULED_TASK_RUNS: usize = 40;
/// `SCHEDULED_TASK_INTERVIEW_PROMPT`.
pub const SCHEDULED_TASK_INTERVIEW_PROMPT: &str = "Let's set up a scheduled task together. First, explain how scheduled tasks work in pi-gui. Then interview me to figure out what I need scheduled and when it should run.";
/// Node's `setTimeout` treats longer delays as 1 ms, so the timer never waits longer.
const MAX_TIMER_DELAY_MS: f64 = 2_147_483_647.0;
const NOT_LOADED: &str = "Scheduled tasks could not be loaded; repair scheduled-tasks.json.";
const RUN_DID_NOT_FINISH: &str = "Scheduled run did not finish.";

/// What the scheduled-task part keeps besides `state.scheduledTasks`.
#[derive(Default)]
pub struct ScheduledState {
    /// `mutationTail`: shared out of the `RefCell` so it can be held across awaits.
    mutations: Rc<tokio::sync::Mutex<()>>,
    /// `inFlightTaskIds`: tasks whose claimed run has not recorded its result yet.
    in_flight: HashSet<String>,
    timer: Option<AbortHandle>,
    /// `scheduledTaskWakeAt`.
    wake_at: Option<String>,
}

pub fn register(table: &mut MethodTable) {
    table.on("createScheduledTask", |kernel, call| {
        Box::pin(async move {
            let input = call.arg(0).cloned();
            dispatch::run(&kernel, &call, || async {
                let input = super::validation::expect_create_scheduled_task_input(input.as_ref())?;
                create_scheduled_task(&kernel, input).await
            })
            .await
        })
    });
    table.on("updateScheduledTask", |kernel, call| {
        Box::pin(async move {
            let id = call.arg(0).cloned();
            let patch = call.arg(1).cloned();
            dispatch::run(&kernel, &call, || async {
                let id = super::validation::expect_non_empty_string(id.as_ref(), "id")?;
                let patch = super::validation::expect_update_scheduled_task_input(patch.as_ref())?;
                update_scheduled_task(&kernel, &id, patch).await
            })
            .await
        })
    });
    table.on("deleteScheduledTask", |kernel, call| {
        Box::pin(async move {
            let id = call.arg(0).cloned();
            dispatch::run(&kernel, &call, || async {
                let id = super::validation::expect_non_empty_string(id.as_ref(), "id")?;
                delete_scheduled_task(&kernel, &id).await
            })
            .await
        })
    });
    table.on("beginScheduledTaskInterview", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let mutations = mutation_queue(&kernel);
                let _turn = mutations.lock().await;
                begin_scheduled_task_interview(&kernel).await
            })
            .await
        })
    });
}

#[derive(Deserialize)]
struct LoadedTasks {
    tasks: Vec<ScheduledTaskRecord>,
}

/// Startup's `readScheduledTasksFile`: the error message when the file could not be read,
/// which also turns the runner and saving off.
pub async fn load_scheduled_tasks(kernel: &Kernel) -> Option<String> {
    let loaded = kernel
        .core_call(crate::methods::SCHEDULED_TASKS_READ, Value::Null)
        .await
        .and_then(crate::parse::<LoadedTasks>);
    match loaded {
        Ok(loaded) => {
            let mut data = kernel.data.borrow_mut();
            data.state.scheduled_tasks = loaded.tasks;
            data.scheduled_tasks_writable = true;
            None
        }
        Err(error) => {
            eprintln!(
                "[app-store] scheduled-tasks.json is invalid; runner disabled: {}",
                error.message
            );
            let mut data = kernel.data.borrow_mut();
            data.scheduled_tasks_writable = false;
            data.state.scheduled_tasks = Vec::new();
            Some(error.message)
        }
    }
}

/// `persistScheduledTasks`: only once the file was read.
pub async fn persist_scheduled_tasks(kernel: &Kernel) -> CoreResult<()> {
    let tasks = {
        let data = kernel.data.borrow();
        if !data.scheduled_tasks_writable {
            return Ok(());
        }
        data.state.scheduled_tasks.clone()
    };
    kernel
        .core_call(
            crate::methods::SCHEDULED_TASKS_WRITE,
            json!({ "tasks": tasks }),
        )
        .await?;
    Ok(())
}

// ---- The timer ----

/// `scheduleScheduledTasks`: one timer for the earliest active task. A task whose run is still
/// in flight re-arms the timer when that run settles.
pub fn schedule_scheduled_tasks(kernel: &Kernel) {
    let now = kernel.env().now_ms();
    let mut data = kernel.data.borrow_mut();
    let data = &mut *data;
    let scheduled = &mut data.scheduled;
    if !data.scheduled_tasks_writable {
        if let Some(timer) = scheduled.timer.take() {
            timer.abort();
        }
        scheduled.wake_at = None;
        return;
    }
    let wakes: Vec<ScheduledWake> = data
        .state
        .scheduled_tasks
        .iter()
        .filter(|task| !scheduled.in_flight.contains(&task.id))
        .map(|task| ScheduledWake {
            status: status_name(task.status),
            next_run_at: task.next_run_at.as_deref(),
        })
        .collect();
    let next = earliest_scheduled_wake_at(kernel.env(), &wakes, now);
    if next.is_some() && next == scheduled.wake_at && scheduled.timer.is_some() {
        return;
    }
    if let Some(timer) = scheduled.timer.take() {
        timer.abort();
    }
    scheduled.wake_at = next.clone();
    let Some(next) = next else {
        return;
    };
    let delay = (kernel.env().date_parse(&next) - now).clamp(0.0, MAX_TIMER_DELAY_MS);
    let weak = kernel.this_weak();
    let timer = tokio::task::spawn_local(async move {
        tokio::time::sleep(Duration::from_millis(delay as u64)).await;
        let Some(kernel) = weak.upgrade() else {
            return;
        };
        {
            let mut data = kernel.data.borrow_mut();
            data.scheduled.timer = None;
            data.scheduled.wake_at = None;
        }
        if kernel.is_stopping() {
            return;
        }
        let now = kernel.env().now_ms();
        if let Err(error) = fire_due_scheduled_tasks(&kernel, now).await {
            eprintln!(
                "[app-store] fireDueScheduledTasks failed: {}",
                error.message
            );
            schedule_scheduled_tasks(&kernel);
        }
    });
    scheduled.timer = Some(timer.abort_handle());
}

fn status_name(status: ScheduledTaskStatus) -> &'static str {
    match status {
        ScheduledTaskStatus::Active => "active",
        ScheduledTaskStatus::Paused => "paused",
        ScheduledTaskStatus::Completed => "completed",
    }
}

// ---- Helpers ----

fn mutation_queue(kernel: &Kernel) -> Rc<tokio::sync::Mutex<()>> {
    kernel.data.borrow().scheduled.mutations.clone()
}

fn iso(ms: f64) -> String {
    js::to_iso_string(ms).unwrap_or_default()
}

fn tasks(kernel: &Kernel) -> Vec<ScheduledTaskRecord> {
    kernel.data.borrow().state.scheduled_tasks.clone()
}

fn writable(kernel: &Kernel) -> bool {
    kernel.data.borrow().scheduled_tasks_writable
}

fn is_in_flight(kernel: &Kernel, id: &str) -> bool {
    kernel.data.borrow().scheduled.in_flight.contains(id)
}

fn append_run(mut task: ScheduledTaskRecord, run: ScheduledTaskRun) -> ScheduledTaskRecord {
    task.runs.push(run);
    let excess = task.runs.len().saturating_sub(MAX_SCHEDULED_TASK_RUNS);
    task.runs.drain(..excess);
    task
}

/// `bindingConflict`: a thread has at most one task that is not completed.
fn binding_conflict(
    tasks: &[ScheduledTaskRecord],
    target: &ScheduledTaskTarget,
    ignore_id: Option<&str>,
) -> bool {
    let ScheduledTaskTarget::ExistingThread { session_id, .. } = target else {
        return false;
    };
    tasks.iter().any(|task| {
        Some(task.id.as_str()) != ignore_id
            && task.status != ScheduledTaskStatus::Completed
            && matches!(&task.target, ScheduledTaskTarget::ExistingThread { session_id: bound, .. } if bound == session_id)
    })
}

/// `nextRunOrUndefined`.
fn next_run_or_none(
    kernel: &Kernel,
    schedule: &ScheduledTaskSchedule,
    from: f64,
) -> Option<String> {
    next_run_at(kernel.env(), schedule, from).ok().flatten()
}

fn missing_next_run_error(schedule: &ScheduledTaskSchedule) -> String {
    match schedule {
        ScheduledTaskSchedule::Once { .. } => "One-time tasks must be scheduled in the future.",
        _ => "Scheduled task has no next run.",
    }
    .to_owned()
}

/// `onceActivationNeedsNewTime`.
fn once_activation_needs_new_time(
    kernel: &Kernel,
    schedule: &ScheduledTaskSchedule,
    last_run_at: Option<&str>,
    now: f64,
) -> bool {
    match schedule {
        ScheduledTaskSchedule::Once { at } => {
            last_run_at.is_some_and(|last| !last.is_empty()) && kernel.env().date_parse(at) <= now
        }
        _ => false,
    }
}

fn is_claimable(kernel: &Kernel, task: &ScheduledTaskRecord, now: f64) -> bool {
    let Some(next) = task.next_run_at.as_deref().filter(|next| !next.is_empty()) else {
        return false;
    };
    if task.status != ScheduledTaskStatus::Active || kernel.env().date_parse(next) > now {
        return false;
    }
    !(matches!(task.schedule, ScheduledTaskSchedule::Once { .. }) && has(&task.last_run_at))
}

fn has(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|value| !value.is_empty())
}

/// `lastUserMessageId`: the newest user message with exactly this text, sent no earlier than
/// `fired_at`.
fn last_user_message_id(
    kernel: &Kernel,
    session_ref: &SessionRef,
    instruction: &str,
    fired_at: Option<&str>,
) -> Option<String> {
    let min_created_at = fired_at.map_or(f64::NEG_INFINITY, |at| kernel.env().date_parse(at));
    let data = kernel.data.borrow();
    let transcript = data
        .sessions
        .transcript_cache
        .get(&session_key(session_ref))?;
    transcript.iter().rev().find_map(|item| {
        let TranscriptMessage::Message(message) = item else {
            return None;
        };
        if message.role != SessionTranscriptRole::User || message.text != instruction {
            return None;
        }
        let created_at = kernel.env().date_parse(&message.created_at);
        if created_at.is_nan() || created_at < min_created_at {
            return None;
        }
        Some(message.id.clone())
    })
}

fn pause_with_error(mut task: ScheduledTaskRecord, now: f64, error: String) -> ScheduledTaskRecord {
    task.status = ScheduledTaskStatus::Paused;
    task.updated_at = iso(now);
    task.last_error = Some(error);
    task.next_run_at = None;
    task.completed_at = None;
    task
}

fn target_ref(target: &ScheduledTaskTarget) -> (&str, Option<&str>) {
    match target {
        ScheduledTaskTarget::NewThread { workspace_id } => (workspace_id, None),
        ScheduledTaskTarget::ExistingThread {
            workspace_id,
            session_id,
        } => (workspace_id, Some(session_id)),
    }
}

/// `replaceAndPersist`.
async fn replace_and_persist(
    kernel: &Kernel,
    tasks: Vec<ScheduledTaskRecord>,
    refresh: bool,
) -> CoreResult<DesktopAppState> {
    kernel.data.borrow_mut().state.scheduled_tasks = tasks;
    persist_scheduled_tasks(kernel).await?;
    if refresh {
        return refresh::refresh_state(
            kernel,
            RefreshOptions {
                clear_last_error: true,
                persist_state: Some(false),
                mark_selected_session_viewed: Some(false),
                ..Default::default()
            },
        )
        .await;
    }
    Ok(publish::emit(kernel))
}

/// `writeTask`: replaces one task, if it still exists, and saves.
async fn write_task(kernel: &Kernel, updated: ScheduledTaskRecord) -> CoreResult<()> {
    {
        let mut data = kernel.data.borrow_mut();
        let Some(slot) = data
            .state
            .scheduled_tasks
            .iter_mut()
            .find(|task| task.id == updated.id)
        else {
            return Ok(());
        };
        *slot = updated;
    }
    persist_scheduled_tasks(kernel).await
}

fn parse_schedule(value: &Value, name: &str) -> CoreResult<ScheduledTaskSchedule> {
    crate::parse(super::validation::assert_scheduled_task_schedule(
        Some(value),
        name,
    )?)
}

fn parse_target(value: &Value, name: &str) -> CoreResult<ScheduledTaskTarget> {
    crate::parse(super::validation::assert_scheduled_task_target(
        Some(value),
        name,
    )?)
}

// ---- Creating, editing and deleting ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    title: String,
    instruction: String,
    schedule: Value,
    target: Value,
    #[serde(default)]
    origin_session_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdatePatch {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    instruction: Option<String>,
    #[serde(default)]
    schedule: Option<Value>,
    #[serde(default)]
    target: Option<Value>,
    #[serde(default)]
    status: Option<ScheduledTaskStatus>,
}

/// The store's `createScheduledTask`: queued, then the timer re-armed.
pub async fn create_scheduled_task(kernel: &Kernel, input: Value) -> CoreResult<DesktopAppState> {
    let state = {
        let mutations = mutation_queue(kernel);
        let _turn = mutations.lock().await;
        create_task(kernel, input).await
    };
    schedule_scheduled_tasks(kernel);
    state
}

/// The store's `updateScheduledTask`.
pub async fn update_scheduled_task(
    kernel: &Kernel,
    id: &str,
    patch: Value,
) -> CoreResult<DesktopAppState> {
    let state = {
        let mutations = mutation_queue(kernel);
        let _turn = mutations.lock().await;
        update_task(kernel, id, patch).await
    };
    schedule_scheduled_tasks(kernel);
    state
}

/// The store's `deleteScheduledTask`.
pub async fn delete_scheduled_task(kernel: &Kernel, id: &str) -> CoreResult<DesktopAppState> {
    let state = {
        let mutations = mutation_queue(kernel);
        let _turn = mutations.lock().await;
        delete_task(kernel, id).await
    };
    schedule_scheduled_tasks(kernel);
    state
}

/// `createScheduledTask`, inside the mutation queue.
async fn create_task(kernel: &Kernel, input: Value) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    if !writable(kernel) {
        return sessions::with_error(kernel, NOT_LOADED.to_owned()).await;
    }
    let input: CreateInput = crate::parse(input)?;
    let title = js::trim(&input.title).to_owned();
    let instruction = js::trim(&input.instruction).to_owned();
    if title.is_empty() || instruction.is_empty() {
        return sessions::with_error(
            kernel,
            "Scheduled tasks need a title and instructions.".to_owned(),
        )
        .await;
    }
    let schedule = parse_schedule(&input.schedule, "schedule")?;
    let target = parse_target(&input.target, "target")?;
    if let Some(message) = target_error(kernel, &target, false) {
        return sessions::with_error(kernel, message).await;
    }
    let current = tasks(kernel);
    if binding_conflict(&current, &target, None) {
        return sessions::with_error(
            kernel,
            "This thread already has a scheduled task.".to_owned(),
        )
        .await;
    }
    let now = kernel.env().now_ms();
    let Some(next) = next_run_or_none(kernel, &schedule, now) else {
        return sessions::with_error(kernel, missing_next_run_error(&schedule)).await;
    };
    let created = ScheduledTaskRecord {
        id: kernel.env().random_uuid(),
        title,
        instruction,
        status: ScheduledTaskStatus::Active,
        schedule,
        target,
        created_at: iso(now),
        updated_at: iso(now),
        next_run_at: Some(next),
        last_run_at: None,
        completed_at: None,
        origin_session_id: input.origin_session_id.filter(|id| !id.is_empty()),
        last_error: None,
        runs: Vec::new(),
    };
    let mut next_tasks = vec![created];
    next_tasks.extend(current);
    replace_and_persist(kernel, next_tasks, true).await
}

/// Why `target` cannot be used: an unknown folder, or a missing or archived thread. Editing
/// words the thread error differently from creating, as the TypeScript does.
fn target_error(kernel: &Kernel, target: &ScheduledTaskTarget, editing: bool) -> Option<String> {
    let data = kernel.data.borrow();
    let (workspace_id, session_id) = target_ref(target);
    if data.workspace_ref(workspace_id).is_none() {
        return Some(format!("Unknown workspace: {workspace_id}"));
    }
    let session_id = session_id?;
    let archived = data
        .session(&crate::state::driver::session_ref(workspace_id, session_id))
        .map(|session| session.archived_at.is_some());
    match archived {
        None | Some(true) if editing => {
            Some("Cannot bind a scheduled task to a missing or archived thread.".to_owned())
        }
        None => Some(format!("Unknown session: {workspace_id}:{session_id}")),
        Some(true) => Some("Cannot bind a scheduled task to an archived thread.".to_owned()),
        Some(false) => None,
    }
}

/// `updateScheduledTask`, inside the mutation queue.
async fn update_task(kernel: &Kernel, id: &str, patch: Value) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    if !writable(kernel) {
        return sessions::with_error(kernel, NOT_LOADED.to_owned()).await;
    }
    let current = tasks(kernel);
    let Some(existing) = current.iter().find(|task| task.id == id).cloned() else {
        return sessions::with_error(kernel, format!("Unknown scheduled task: {id}")).await;
    };
    let patch: UpdatePatch = crate::parse(patch)?;
    let title = patch
        .title
        .as_deref()
        .map_or(existing.title.clone(), |title| js::trim(title).to_owned());
    let instruction = patch
        .instruction
        .as_deref()
        .map_or(existing.instruction.clone(), |text| {
            js::trim(text).to_owned()
        });
    if title.is_empty() || instruction.is_empty() {
        return sessions::with_error(
            kernel,
            "Scheduled tasks need a title and instructions.".to_owned(),
        )
        .await;
    }
    let schedule = match &patch.schedule {
        Some(schedule) => parse_schedule(schedule, "schedule")?,
        None => existing.schedule.clone(),
    };
    let target = match &patch.target {
        Some(target) => parse_target(target, "target")?,
        None => existing.target.clone(),
    };
    if let Some(message) = target_error(kernel, &target, true) {
        return sessions::with_error(kernel, message).await;
    }
    if binding_conflict(&current, &target, Some(id)) {
        return sessions::with_error(
            kernel,
            "This thread already has a scheduled task.".to_owned(),
        )
        .await;
    }
    let now = kernel.env().now_ms();
    let status = patch.status.unwrap_or(existing.status);
    let schedule_changed = patch.schedule.is_some() && existing.schedule != schedule;
    let last_run_at = if schedule_changed {
        None
    } else {
        existing.last_run_at.clone().filter(|at| !at.is_empty())
    };
    // A one-time run in flight holds its claim until it records its result.
    let claim_in_flight = is_in_flight(kernel, id) && !schedule_changed;
    if status == ScheduledTaskStatus::Active
        && !claim_in_flight
        && once_activation_needs_new_time(kernel, &schedule, last_run_at.as_deref(), now)
    {
        return sessions::with_error(
            kernel,
            "This one-time task already claimed its run. Set a new time to run it again."
                .to_owned(),
        )
        .await;
    }
    let (next_run_at, completed_at) = match status {
        ScheduledTaskStatus::Active
            if !schedule_changed
                && existing.status == ScheduledTaskStatus::Active
                && has(&existing.next_run_at) =>
        {
            (existing.next_run_at.clone(), None)
        }
        ScheduledTaskStatus::Active => {
            let Some(next) = next_run_or_none(kernel, &schedule, now) else {
                return sessions::with_error(kernel, missing_next_run_error(&schedule)).await;
            };
            (Some(next), None)
        }
        ScheduledTaskStatus::Completed => (
            None,
            Some(
                existing
                    .completed_at
                    .clone()
                    .filter(|at| !at.is_empty())
                    .unwrap_or_else(|| iso(now)),
            ),
        ),
        ScheduledTaskStatus::Paused => (None, None),
    };
    let updated = ScheduledTaskRecord {
        title,
        instruction,
        schedule,
        target,
        status,
        updated_at: iso(now),
        next_run_at,
        last_run_at,
        completed_at,
        ..existing
    };
    let next_tasks = current
        .into_iter()
        .map(|task| if task.id == id { updated.clone() } else { task })
        .collect();
    replace_and_persist(kernel, next_tasks, true).await
}

/// `deleteScheduledTask`, inside the mutation queue.
async fn delete_task(kernel: &Kernel, id: &str) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    if !writable(kernel) {
        return sessions::with_error(kernel, NOT_LOADED.to_owned()).await;
    }
    let remaining = tasks(kernel)
        .into_iter()
        .filter(|task| task.id != id)
        .collect();
    replace_and_persist(kernel, remaining, true).await
}

/// `beginScheduledTaskInterview`: a new thread with the interview prompt in its composer,
/// not sent.
async fn begin_scheduled_task_interview(kernel: &Kernel) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let workspace_id = {
        let data = kernel.data.borrow();
        Some(data.state.selected_workspace_id.clone())
            .filter(|id| !id.is_empty())
            .or_else(|| {
                data.state
                    .workspaces
                    .first()
                    .map(|workspace| workspace.id.clone())
            })
    };
    let Some(workspace_id) = workspace_id else {
        return sessions::with_error(
            kernel,
            "Open a folder before creating a scheduled task.".to_owned(),
        )
        .await;
    };
    let state = workspace::create_session(
        kernel,
        &json!({ "workspaceId": workspace_id, "title": NEW_THREAD_PLACEHOLDER_TITLE }),
    )
    .await?;
    if state.selected_workspace_id.is_empty() || state.selected_session_id.is_empty() {
        return sessions::with_error(
            kernel,
            "Could not open a thread for the scheduled-task interview.".to_owned(),
        )
        .await;
    }
    let session_ref =
        crate::state::driver::session_ref(&state.selected_workspace_id, &state.selected_session_id);
    conversation::update_composer_draft(kernel, Some(&session_ref), SCHEDULED_TASK_INTERVIEW_PROMPT)
        .await
}

// ---- Firing ----

/// A run whose claim is saved and whose instruction is still to be delivered.
struct ClaimedRun {
    task: ScheduledTaskRecord,
    claimed_at: String,
    fired_at: String,
    session_ref: SessionRef,
}

/// Claims saved so far, and the error that stopped claiming more.
struct Claims {
    claims: Vec<ClaimedRun>,
    error: Option<CoreError>,
}

/// The store's `fireDueScheduledTasks`: claims every due task, delivers each claimed run, then
/// re-arms the timer. Tasks due at `now` count.
pub async fn fire_due_scheduled_tasks(kernel: &Kernel, now: f64) -> CoreResult<DesktopAppState> {
    let state = fire_due(kernel, now).await?;
    schedule_scheduled_tasks(kernel);
    Ok(state)
}

async fn fire_due(kernel: &Kernel, now: f64) -> CoreResult<DesktopAppState> {
    let claimed = {
        let mutations = mutation_queue(kernel);
        let _turn = mutations.lock().await;
        claim_due_scheduled_tasks(kernel, now).await?
    };
    let Some(claimed) = claimed else {
        return Ok(publish::emit(kernel));
    };
    // Re-arm and publish now and as each run settles, so other tasks keep their times and
    // their results show during a long run.
    schedule_scheduled_tasks(kernel);
    publish::emit(kernel);
    let settled = super::futures_join_all(claimed.claims.into_iter().map(|claim| async move {
        let result = deliver_claimed_run(kernel, claim).await;
        schedule_scheduled_tasks(kernel);
        publish::emit(kernel);
        result
    }))
    .await;
    // Deliver every saved claim before reporting a failure, so one bad save costs no other run.
    if let Some(error) = claimed.error {
        return Err(error);
    }
    if let Some(Err(error)) = settled.into_iter().find(Result::is_err) {
        return Err(error);
    }
    refresh::refresh_state(
        kernel,
        RefreshOptions {
            clear_last_error: true,
            persist_state: Some(false),
            mark_selected_session_viewed: Some(false),
            ..Default::default()
        },
    )
    .await
}

/// `leftoverClaimedOnce`: a one-time task claimed by an earlier launch whose run never
/// recorded a result is paused with a failed run. `None` leaves the task as it is.
fn leftover_claimed_once(
    kernel: &Kernel,
    task: &ScheduledTaskRecord,
    now: f64,
) -> Option<ScheduledTaskRecord> {
    if task.status != ScheduledTaskStatus::Active
        || !matches!(task.schedule, ScheduledTaskSchedule::Once { .. })
        || !has(&task.last_run_at)
        || is_in_flight(kernel, &task.id)
    {
        return None;
    }
    let failed_run = match &task.target {
        ScheduledTaskTarget::ExistingThread {
            workspace_id,
            session_id,
        } => Some(ScheduledTaskRun {
            id: kernel.env().random_uuid(),
            session_id: session_id.clone(),
            workspace_id: workspace_id.clone(),
            fired_at: task.last_run_at.clone().unwrap_or_default(),
            instruction: task.instruction.clone(),
            user_message_id: None,
            outcome: ScheduledTaskRunOutcome::Failed,
            error: Some(RUN_DID_NOT_FINISH.to_owned()),
        }),
        ScheduledTaskTarget::NewThread { .. } => None,
    };
    let task = match failed_run {
        Some(run) => append_run(task.clone(), run),
        None => task.clone(),
    };
    Some(pause_with_error(task, now, RUN_DID_NOT_FINISH.to_owned()))
}

/// `claimDueScheduledTasks`: `None` when nothing is due.
async fn claim_due_scheduled_tasks(kernel: &Kernel, now: f64) -> CoreResult<Option<Claims>> {
    kernel.initialize().await;
    if !writable(kernel) {
        return Ok(None);
    }
    let mut changed = false;
    let leftover: Vec<ScheduledTaskRecord> = tasks(kernel)
        .into_iter()
        .map(|task| match leftover_claimed_once(kernel, &task, now) {
            Some(paused) => {
                changed = true;
                paused
            }
            None => task,
        })
        .collect();
    if changed {
        replace_and_persist(kernel, leftover.clone(), false).await?;
    }
    let due: Vec<String> = leftover
        .iter()
        .filter(|task| !is_in_flight(kernel, &task.id) && is_claimable(kernel, task, now))
        .map(|task| task.id.clone())
        .collect();
    if due.is_empty() {
        return Ok(None);
    }
    let mut claims = Vec::new();
    for id in due {
        match claim_task(kernel, &id, now).await {
            Ok(Some(claim)) => claims.push(claim),
            Ok(None) => {}
            // Claims already saved are still delivered; the error is reported after them.
            Err(error) => {
                return Ok(Some(Claims {
                    claims,
                    error: Some(error),
                }))
            }
        }
    }
    Ok(Some(Claims {
        claims,
        error: None,
    }))
}

/// Claims one due task: works out its next time and its thread, and saves the claim.
async fn claim_task(kernel: &Kernel, id: &str, now: f64) -> CoreResult<Option<ClaimedRun>> {
    let Some(claimed) = tasks(kernel).into_iter().find(|task| task.id == id) else {
        return Ok(None);
    };
    if !is_claimable(kernel, &claimed, now) {
        return Ok(None);
    }
    let advanced_next = match &claimed.schedule {
        ScheduledTaskSchedule::Once { .. } => claimed.next_run_at.clone(),
        schedule => match next_run_at(kernel.env(), schedule, now) {
            Ok(Some(next)) => Some(next),
            Ok(None) => {
                let message = "Scheduled task has no next run.".to_owned();
                write_task(kernel, pause_with_error(claimed, now, message)).await?;
                return Ok(None);
            }
            Err(error) => {
                write_task(kernel, pause_with_error(claimed, now, error.message)).await?;
                return Ok(None);
            }
        },
    };
    let fired_at = kernel.env().now_iso();
    let session_ref = match &claimed.target {
        ScheduledTaskTarget::NewThread { workspace_id } => {
            create_background_session(kernel, workspace_id, &claimed.title)
                .await
                .map_err(|error| (None, error))
        }
        ScheduledTaskTarget::ExistingThread {
            workspace_id,
            session_id,
        } => {
            let session_ref = crate::state::driver::session_ref(workspace_id, session_id);
            let usable = kernel
                .data
                .borrow()
                .session(&session_ref)
                .is_some_and(|session| session.archived_at.is_none());
            if usable {
                Ok(session_ref)
            } else {
                Err((
                    Some(session_ref),
                    CoreError::new("Scheduled task target thread is missing or archived."),
                ))
            }
        }
    };
    let session_ref = match session_ref {
        Ok(session_ref) => session_ref,
        Err((session_ref, error)) => {
            let failed = failed_run_task(
                kernel,
                claimed,
                session_ref.as_ref(),
                &fired_at,
                now,
                error.message,
            );
            write_task(kernel, failed).await?;
            return Ok(None);
        }
    };
    let claimed_at = iso(now);
    write_task(
        kernel,
        ScheduledTaskRecord {
            last_run_at: Some(claimed_at.clone()),
            next_run_at: advanced_next,
            updated_at: claimed_at.clone(),
            ..claimed.clone()
        },
    )
    .await?;
    kernel
        .data
        .borrow_mut()
        .scheduled
        .in_flight
        .insert(claimed.id.clone());
    Ok(Some(ClaimedRun {
        task: claimed,
        claimed_at,
        fired_at,
        session_ref,
    }))
}

/// `createBackgroundSession`: a new thread for a run, without selecting it.
async fn create_background_session(
    kernel: &Kernel,
    workspace_id: &str,
    title: &str,
) -> CoreResult<SessionRef> {
    let Some(workspace) = kernel.data.borrow().workspace_ref(workspace_id) else {
        return Err(CoreError::new(format!("Unknown workspace: {workspace_id}")));
    };
    let mut options = settings::build_create_session_options(kernel, workspace_id)
        .await?
        .unwrap_or_default();
    options.insert("title".into(), json!(title));
    let snapshot: SessionSnapshot = super::pi::driver_call(
        kernel.driver(),
        "createSession",
        super::pi::args([json!(workspace), Value::Object(options)]),
    )
    .await?;
    sessions::seed_session(&mut kernel.data.borrow_mut(), &snapshot);
    sessions::ensure_session_subscription(kernel, &snapshot.session_ref).await?;
    refresh::refresh_state(
        kernel,
        RefreshOptions {
            clear_last_error: true,
            persist_state: Some(false),
            emit_state: Some(false),
            mark_selected_session_viewed: Some(false),
            publish_selected_transcript: Some(false),
            ..Default::default()
        },
    )
    .await?;
    Ok(snapshot.session_ref)
}

/// `failedRunTask`: the task paused, with a failed run on its thread when it has one.
fn failed_run_task(
    kernel: &Kernel,
    task: ScheduledTaskRecord,
    session_ref: Option<&SessionRef>,
    fired_at: &str,
    now: f64,
    message: String,
) -> ScheduledTaskRecord {
    let failed_run = session_ref.map(|session_ref| ScheduledTaskRun {
        id: kernel.env().random_uuid(),
        session_id: session_ref.session_id.clone(),
        workspace_id: session_ref.workspace_id.clone(),
        fired_at: fired_at.to_owned(),
        instruction: task.instruction.clone(),
        user_message_id: last_user_message_id(
            kernel,
            session_ref,
            &task.instruction,
            Some(fired_at),
        ),
        outcome: ScheduledTaskRunOutcome::Failed,
        error: Some(message.clone()),
    });
    let task = match failed_run {
        Some(run) => append_run(task, run),
        None => task,
    };
    pause_with_error(task, now, message)
}

/// `deliverClaimedRun`: sends the instruction, then records the run on the task as it is now.
async fn deliver_claimed_run(kernel: &Kernel, claim: ClaimedRun) -> CoreResult<()> {
    let result = record_delivery(kernel, &claim).await;
    kernel
        .data
        .borrow_mut()
        .scheduled
        .in_flight
        .remove(&claim.task.id);
    result
}

async fn record_delivery(kernel: &Kernel, claim: &ClaimedRun) -> CoreResult<()> {
    let ClaimedRun {
        task,
        claimed_at,
        fired_at,
        session_ref,
    } = claim;
    let outcome = deliver_instruction(kernel, session_ref, &task.instruction, fired_at).await;
    let mutations = mutation_queue(kernel);
    let _turn = mutations.lock().await;
    // The task may have been edited, paused or deleted while the run was in flight.
    let Some(current) = tasks(kernel).into_iter().find(|entry| entry.id == task.id) else {
        return Ok(());
    };
    let still_claimed = current.last_run_at.as_deref() == Some(claimed_at.as_str());
    let now = kernel.env().date_parse(claimed_at);
    let updated = match outcome {
        Err(error) => {
            let failed = failed_run_task(
                kernel,
                current.clone(),
                Some(session_ref),
                fired_at,
                now,
                error.message,
            );
            // A run that never started gives its claim back, as if it had not fired. If the
            // task was rescheduled, paused or completed meanwhile, keep that and only record
            // the failure.
            if still_claimed && current.status == ScheduledTaskStatus::Active {
                ScheduledTaskRecord {
                    last_run_at: task.last_run_at.clone(),
                    ..failed
                }
            } else {
                ScheduledTaskRecord {
                    runs: failed.runs,
                    last_error: failed.last_error,
                    ..current
                }
            }
        }
        Ok(user_message_id) => {
            let run = ScheduledTaskRun {
                id: kernel.env().random_uuid(),
                session_id: session_ref.session_id.clone(),
                workspace_id: session_ref.workspace_id.clone(),
                fired_at: fired_at.clone(),
                instruction: task.instruction.clone(),
                user_message_id: user_message_id.filter(|id| !id.is_empty()),
                outcome: ScheduledTaskRunOutcome::Started,
                error: None,
            };
            let finishes_once = still_claimed
                && current.status == ScheduledTaskStatus::Active
                && matches!(current.schedule, ScheduledTaskSchedule::Once { .. });
            let mut with_run = append_run(current, run);
            with_run.last_error = None;
            if finishes_once {
                with_run.status = ScheduledTaskStatus::Completed;
                with_run.completed_at = Some(claimed_at.clone());
                with_run.next_run_at = None;
                with_run.updated_at = claimed_at.clone();
            }
            with_run
        }
    };
    write_task(kernel, updated).await
}

/// `deliverInstruction`: the id of the user message the run sent, when it can be found.
async fn deliver_instruction(
    kernel: &Kernel,
    session_ref: &SessionRef,
    instruction: &str,
    fired_at: &str,
) -> CoreResult<Option<String>> {
    let delivered_id = deliver_background_instruction(kernel, session_ref, instruction).await?;
    Ok(last_user_message_id(kernel, session_ref, instruction, Some(fired_at)).or(delivered_id))
}

/// `deliverBackgroundInstruction`: sends a run's instruction without touching the composer.
/// A running thread gets it queued as a follow-up instead.
async fn deliver_background_instruction(
    kernel: &Kernel,
    session_ref: &SessionRef,
    text: &str,
) -> CoreResult<Option<String>> {
    let instruction = js::trim(text);
    if instruction.is_empty() {
        return Err(CoreError::new("Scheduled task instruction is empty."));
    }
    Box::pin(sessions::ensure_session_ready(kernel, session_ref)).await?;
    let status = {
        let data = kernel.data.borrow();
        let Some(session) = data.session(session_ref) else {
            return Err(CoreError::new(format!(
                "Unknown session: {}:{}",
                session_ref.workspace_id, session_ref.session_id
            )));
        };
        if session.archived_at.is_some() {
            return Err(CoreError::new("Scheduled task target thread is archived."));
        }
        session.status
    };
    sessions::record_user_message_recency(kernel, session_ref);

    if status == SessionStatus::Running {
        let timestamp = kernel.env().now_iso();
        // `getQueuedComposerMessages`: steers too, unlike the composer's projection.
        let mut queued = kernel
            .data
            .borrow()
            .sessions
            .queued_composer_messages_by_session
            .get(&session_key(session_ref))
            .cloned()
            .unwrap_or_default();
        queued.push(QueuedComposerMessage {
            id: kernel.env().random_uuid(),
            mode: SessionMessageDeliveryMode::FollowUp,
            text: instruction.to_owned(),
            attachments: Vec::new(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        });
        kernel
            .driver()
            .call(
                "replaceQueuedMessages",
                super::pi::args([
                    json!(session_ref),
                    json!(to_session_queued_messages(&queued)),
                ]),
            )
            .await?;
        refresh::refresh_state(
            kernel,
            RefreshOptions {
                clear_last_error: true,
                mark_selected_session_viewed: Some(false),
                ..Default::default()
            },
        )
        .await?;
        return Ok(None);
    }

    let optimistic_id = {
        let mut data = kernel.data.borrow_mut();
        let sessions = &mut data.sessions;
        let id = append_user_message(
            kernel.env(),
            &mut sessions.transcript_cache,
            session_ref,
            instruction,
            &[],
        );
        clear_active_assistant_message(
            &mut sessions.active_assistant_message_by_session,
            session_ref,
        );
        sessions
            .session_errors_by_session
            .shift_remove(&session_key(session_ref));
        id
    };
    publish::publish_selected_transcript_for(kernel, session_ref);
    kernel
        .driver()
        .call(
            "sendUserMessage",
            super::pi::args([
                json!(session_ref),
                json!({ "text": instruction, "attachments": [] }),
            ]),
        )
        .await?;
    Ok(Some(optimistic_id))
}
