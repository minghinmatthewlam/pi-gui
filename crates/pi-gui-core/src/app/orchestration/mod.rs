//! Child threads and supervision (`orchestration/app-store-orchestration.ts` and
//! `orchestration-runtime.ts`). So far: saving children and the membership checks the event
//! path uses. Spawning, supervision and the `pi_gui` tool still answer "not ported"; children
//! restored from ui-state are shown as saved.

use super::dispatch::MethodTable;
use super::Kernel;
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{DesktopAppState, OrchestrationChildThread};
use crate::state::driver::{SessionDriverEvent, SessionRef};
use serde_json::Value;

const MAX_EVIDENCE_RECORDS_PER_CHILD: usize = 80;

/// What the orchestration part keeps besides `state.orchestrationChildren`.
#[derive(Default)]
pub struct OrchestrationState {}

pub fn register(_table: &mut MethodTable) {}

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

/// `capEvidenceRecords`.
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

/// `hydrateOrchestrationChildren`: loads child transcripts. Not ported; nothing to load.
pub async fn hydrate_orchestration_children(_kernel: &Kernel) -> CoreResult<()> {
    Ok(())
}

/// `projectOrchestrationChildren`. Not ported: the children as they are.
pub fn project_orchestration_children(kernel: &Kernel) -> Vec<OrchestrationChildThread> {
    kernel.data.borrow().state.orchestration_children.clone()
}

/// `projectOrchestrationChildrenForSession`. Not ported: the children as they are.
pub fn project_orchestration_children_for_session(
    kernel: &Kernel,
    _session_ref: &SessionRef,
) -> Vec<OrchestrationChildThread> {
    project_orchestration_children(kernel)
}

/// `scheduleSupervision`. Not ported: no supervision runs.
pub fn schedule_supervision(_kernel: &Kernel) {}

/// `handleOrchestrationThreadToolResult`. Not ported.
pub async fn handle_orchestration_thread_tool_result(
    _kernel: &Kernel,
    _event: &SessionDriverEvent,
) -> CoreResult<()> {
    Ok(())
}

/// The orchestration session-event listener. Not ported.
pub async fn on_session_event(
    _kernel: &Kernel,
    _event: &SessionDriverEvent,
    _snapshot: &DesktopAppState,
) -> CoreResult<()> {
    Ok(())
}

/// The host's `app.tool` call (the `pi_gui` tool). Not ported.
pub async fn run_pi_gui_tool(_kernel: &Kernel, _params: Value) -> CoreResult<Value> {
    Err(CoreError::new("not ported: app.tool"))
}
