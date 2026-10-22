//! Child threads and supervision (`orchestration/app-store-orchestration.ts` and
//! `orchestration-runtime.ts`): children a thread starts through the thread tools, what they
//! show (`project`), starting and steering them (`children`), the tool bodies (`tools`) and the
//! supervision timer that wakes a parent when a child finishes.

pub mod children;
pub mod project;
pub mod tools;

use super::dispatch::{self, MethodTable};
use super::{persist, publish, sessions, Kernel};
use crate::error::CoreResult;
use crate::state::desktop_state::{
    DesktopAppState, OrchestrationChildThread, OrchestrationSupervisionGate,
};
use crate::state::driver::{
    session_key, SessionClosedReason, SessionDriverEvent, SessionEventKind, SessionRef,
};
use children::LaunchEvent;
use project::MAX_EVIDENCE_RECORDS_PER_CHILD;
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::AbortHandle;

/// What the orchestration part keeps besides `state.orchestrationChildren`.
#[derive(Default)]
pub struct OrchestrationState {
    /// `pendingCreateChildThreadToolCalls`: tool calls whose child is being created.
    pending_create_tool_calls: HashSet<String>,
    /// Children waiting for their initial prompt's acknowledgement: launch id, child session
    /// key and where its events go.
    launches: Vec<(u64, String, UnboundedSender<LaunchEvent>)>,
    next_launch_id: u64,
    supervision_timer: Option<AbortHandle>,
    supervision_run_at: Option<String>,
}

pub fn register(table: &mut MethodTable) {
    table.on("sendChildThreadFollowUp", |kernel, call| {
        Box::pin(async move {
            let input = call.arg(0).cloned();
            dispatch::run(&kernel, &call, || async {
                let input =
                    super::validation::expect_send_child_thread_follow_up_input(input.as_ref())?;
                let state = children::send_child_thread_follow_up(
                    &kernel,
                    input["childThreadId"].as_str().unwrap_or_default(),
                    input["text"].as_str().unwrap_or_default(),
                )
                .await;
                schedule_supervision(&kernel);
                state
            })
            .await
        })
    });
    table.on("setChildSupervisionLoop", |kernel, call| {
        Box::pin(async move {
            let input = call.arg(0).cloned();
            dispatch::run(&kernel, &call, || async {
                let input =
                    super::validation::expect_set_child_supervision_loop_input(input.as_ref())?;
                let gate = if input["gate"] == "stop" {
                    OrchestrationSupervisionGate::Stop
                } else {
                    OrchestrationSupervisionGate::Continue
                };
                let state = children::set_child_supervision_loop_gate(
                    &kernel,
                    input["childThreadId"].as_str().unwrap_or_default(),
                    gate,
                )
                .await;
                schedule_supervision(&kernel);
                state
            })
            .await
        })
    });
}

/// `toPersistedOrchestrationChildren`: a child with its own thread keeps only its goal, and
/// evidence is capped with blocked, failed and accepted records first.
pub fn to_persisted_children(children: &[OrchestrationChildThread]) -> Option<Value> {
    if children.is_empty() {
        return None;
    }
    let persisted: Vec<Value> = children
        .iter()
        .map(|child| {
            let mut value = serde_json::to_value(child).unwrap_or(Value::Null);
            if let Some(object) = value.as_object_mut() {
                if !child.child_session_id.is_empty() {
                    object.insert("latestTranscript".into(), Value::String(child.goal.clone()));
                    object.insert("transcript".into(), Value::Array(Vec::new()));
                }
                if let Some(Value::Array(evidence)) = object.get("evidence").cloned() {
                    object.insert("evidence".into(), Value::Array(cap_evidence(evidence)));
                }
            }
            value
        })
        .collect();
    Some(Value::Array(persisted))
}

/// `capEvidenceRecords` over saved JSON.
fn cap_evidence(records: Vec<Value>) -> Vec<Value> {
    if records.len() <= MAX_EVIDENCE_RECORDS_PER_CHILD {
        return records;
    }
    let is_priority = |record: &Value| {
        matches!(record["status"].as_str(), Some("blocked" | "failed"))
            || record["source"].as_str() == Some("orchestrator-accepted")
    };
    let (priority, remaining): (Vec<Value>, Vec<Value>) =
        records.into_iter().partition(is_priority);
    priority
        .into_iter()
        .chain(remaining)
        .take(MAX_EVIDENCE_RECORDS_PER_CHILD)
        .collect()
}

/// `hasOrchestrationChildSession`.
pub fn has_orchestration_child_session(kernel: &Kernel, session_ref: &SessionRef) -> bool {
    kernel
        .data
        .borrow()
        .state
        .orchestration_children
        .iter()
        .any(|child| {
            !child.child_session_id.is_empty()
                && child.child_workspace_id == session_ref.workspace_id
                && child.child_session_id == session_ref.session_id
        })
}

/// `hasOrchestrationParentSession`.
pub fn has_orchestration_parent_session(kernel: &Kernel, session_ref: &SessionRef) -> bool {
    kernel
        .data
        .borrow()
        .state
        .orchestration_children
        .iter()
        .any(|child| {
            child.parent_workspace_id == session_ref.workspace_id
                && child.parent_session_id == session_ref.session_id
        })
}

/// `hydrateOrchestrationChildren`: loads the transcripts of the selected thread's children.
pub async fn hydrate_orchestration_children(kernel: &Kernel) -> CoreResult<()> {
    let child_refs: Vec<SessionRef> = {
        let data = kernel.data.borrow();
        let mut seen = HashSet::new();
        data.state
            .orchestration_children
            .iter()
            .filter(|child| {
                child.parent_workspace_id == data.state.selected_workspace_id
                    && child.parent_session_id == data.state.selected_session_id
                    && !child.child_session_id.is_empty()
            })
            .map(project::child_session_ref)
            .filter(|child_ref| {
                let key = session_key(child_ref);
                !seen.contains(&key)
                    && data.session(child_ref).is_some()
                    && !data.sessions.loaded_transcript_keys.contains(&key)
                    && seen.insert(key)
            })
            .collect()
    };
    super::futures_join_all(child_refs.iter().map(|child_ref| async move {
        if let Err(error) = sessions::ensure_session_ready(kernel, child_ref).await {
            kernel
                .data
                .borrow_mut()
                .sessions
                .session_errors_by_session
                .insert(session_key(child_ref), error.message);
        }
    }))
    .await;
    Ok(())
}

/// `projectOrchestrationChildren`.
pub fn project_orchestration_children(kernel: &Kernel) -> Vec<OrchestrationChildThread> {
    let data = kernel.data.borrow();
    project::project_children(&data, kernel.env(), &data.state.orchestration_children)
}

/// `projectOrchestrationChildrenForSession`.
pub fn project_orchestration_children_for_session(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> Vec<OrchestrationChildThread> {
    project::project_children_for_session(&kernel.data.borrow(), kernel.env(), session_ref)
}

/// `scheduleOrchestrationSupervision`: one timer for the earliest supervision check.
pub fn schedule_supervision(kernel: &Kernel) {
    let env = kernel.env();
    let mut data = kernel.data.borrow_mut();
    let next = project::next_supervision_run_at(env, &data.state.orchestration_children);
    let orchestration = &mut data.orchestration;
    if next.is_some()
        && next == orchestration.supervision_run_at
        && orchestration.supervision_timer.is_some()
    {
        return;
    }
    if let Some(timer) = orchestration.supervision_timer.take() {
        timer.abort();
    }
    orchestration.supervision_run_at = next.clone();
    let Some(next) = next else {
        return;
    };
    let delay = (env.date_parse(&next) - env.now_ms()).max(0.0);
    let weak = kernel.this_weak();
    let timer = tokio::task::spawn_local(async move {
        tokio::time::sleep(Duration::from_millis(delay as u64)).await;
        let Some(kernel) = weak.upgrade() else {
            return;
        };
        {
            let mut data = kernel.data.borrow_mut();
            data.orchestration.supervision_timer = None;
            data.orchestration.supervision_run_at = None;
        }
        if kernel.is_stopping() {
            return;
        }
        if let Err(error) = run_supervision_tick(&kernel).await {
            eprintln!(
                "[app-store] runOrchestrationSupervisionTick failed: {}",
                error.message
            );
        }
    });
    orchestration.supervision_timer = Some(timer.abort_handle());
}

/// `runOrchestrationSupervisionTick`.
async fn run_supervision_tick(kernel: &Kernel) -> CoreResult<()> {
    kernel.initialize().await;
    let changed = {
        let mut data = kernel.data.borrow_mut();
        let (children, changed) = project::reconcile_due_supervision_loops(&data, kernel.env());
        data.state.orchestration_children = children;
        changed
    };
    if changed {
        persist::persist_ui_state(kernel).await?;
        publish::emit(kernel);
    }
    schedule_supervision(kernel);
    Ok(())
}

/// `handleOrchestrationThreadToolResult`.
pub async fn handle_orchestration_thread_tool_result(
    kernel: &Kernel,
    event: &SessionDriverEvent,
) -> CoreResult<()> {
    tools::handle_orchestration_thread_tool_result(kernel, event).await?;
    Ok(())
}

/// The listener a child launch subscribes while it waits for its initial prompt.
pub async fn on_session_event(
    kernel: &Kernel,
    event: &SessionDriverEvent,
    _snapshot: &DesktopAppState,
) -> CoreResult<()> {
    children::notify_launches(kernel, &session_key(&event.session_ref), || {
        match &event.kind {
            SessionEventKind::RunFailed { error } => LaunchEvent::RunFailed(error.message.clone()),
            SessionEventKind::SessionClosed {
                reason: SessionClosedReason::Failed,
            } => LaunchEvent::ClosedFailed,
            _ => LaunchEvent::Other,
        }
    });
    Ok(())
}

/// `cancelChildRunsForParent`: Stop on a thread also stops its children.
pub async fn cancel_child_runs_for_parent(
    kernel: &Kernel,
    parent_ref: &SessionRef,
) -> CoreResult<()> {
    children::cancel_child_runs_for_parent(kernel, parent_ref).await;
    Ok(())
}

/// The host's `app.tool` call for the thread tools.
pub async fn run_pi_gui_tool(kernel: &Kernel, params: Value) -> CoreResult<Value> {
    tools::run_tool(kernel, params).await
}
