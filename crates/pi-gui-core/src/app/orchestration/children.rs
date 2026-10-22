//! Starting a child thread and steering it: `createChildThreadRecord` with its initial prompt
//! handshake, follow-ups, the supervision gate and Stop.

use super::project::{
    child_session_ref, create_supervision_loop, evidence, evidence_id, is_worker_response,
    merge_evidence_records, next_iso, project_children, supervision_interval_ms,
    to_orchestration_status, transcript_for,
};
use super::Kernel;
use crate::app::pi::{args, driver_call};
use crate::app::refresh::{self, RefreshOptions};
use crate::app::{persist, publish, sessions, settings};
use crate::error::{CoreError, CoreResult};
use crate::git::GitCommand;
use crate::persistence::catalog::SessionStatus;
use crate::state::desktop_state::{
    AppView, DesktopAppState, OrchestrationChildThread, OrchestrationChildThreadStatus,
    OrchestrationEvidenceGitRef, OrchestrationEvidenceKind as Kind,
    OrchestrationEvidenceSource as Source, OrchestrationEvidenceStatus as EvidenceStatus,
    OrchestrationSupervisionGate as Gate, OrchestrationSupervisionLoop,
    OrchestrationSupervisionStatus as LoopStatus,
};
use crate::state::driver::{
    session_key, SessionMessageDeliveryMode, SessionRef, SessionSnapshot, SessionTranscriptRole,
};
use crate::state::timeline_types::TranscriptMessage;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

const CHILD_TITLE_LIMIT: usize = 56;
const CHILD_START_TIMEOUT_MS: u64 = 10_000;
const CHILD_RUNNING_FAILURE_GRACE_MS: u64 = 1_000;

/// How far the child's initial prompt got when the tool answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryStatus {
    Running,
    Responded,
}

/// What a launch waiting on its child hears from the child's session events.
pub enum LaunchEvent {
    RunFailed(String),
    ClosedFailed,
    Other,
}

pub struct SpawnChildThreadInput {
    pub parent: SessionRef,
    pub prompt: String,
    pub source_tool_call_id: Option<String>,
}

/// `childForToolCall`.
pub fn child_for_tool_call(
    kernel: &Kernel,
    parent: &SessionRef,
    source_tool_call_id: &str,
) -> Option<OrchestrationChildThread> {
    kernel
        .data
        .borrow()
        .state
        .orchestration_children
        .iter()
        .find(|child| {
            child.source_tool_call_id.as_deref() == Some(source_tool_call_id)
                && child.parent_workspace_id == parent.workspace_id
                && child.parent_session_id == parent.session_id
        })
        .cloned()
}

/// `createChildThreadRecord`: a new thread in the parent's folder, recorded as its child, with
/// the prompt sent and acknowledged. Replaying a tool call answers the child it already made.
pub async fn create_child_thread_record(
    kernel: &Kernel,
    input: SpawnChildThreadInput,
) -> CoreResult<(OrchestrationChildThread, DeliveryStatus)> {
    kernel.initialize().await;
    let prompt = crate::js::trim(&input.prompt).to_owned();
    if prompt.is_empty() {
        return Err(CoreError::new("Child thread prompt cannot be empty."));
    }
    let parent = &input.parent;
    let workspace = {
        let data = kernel.data.borrow();
        if data.session(parent).is_none() {
            return Err(CoreError::new(
                "Select a parent thread before spawning a child.",
            ));
        }
        data.workspace_ref(&parent.workspace_id)
            .ok_or_else(|| CoreError::new(format!("Unknown workspace: {}", parent.workspace_id)))?
    };

    let pending_key = input
        .source_tool_call_id
        .as_deref()
        .map(|call_id| format!("{}\0{}\0{call_id}", parent.workspace_id, parent.session_id));
    if let Some(key) = &pending_key {
        if kernel
            .data
            .borrow()
            .orchestration
            .pending_create_tool_calls
            .contains(key)
        {
            return Err(CoreError::new(
                "Child thread creation is already in progress.",
            ));
        }
    }

    let existing = input
        .source_tool_call_id
        .as_deref()
        .and_then(|call_id| child_for_tool_call(kernel, parent, call_id));
    if let Some(existing) = existing {
        if existing.status == OrchestrationChildThreadStatus::Failed {
            return Err(CoreError::new(if existing.latest_transcript.is_empty() {
                "Failed to start child thread.".to_owned()
            } else {
                existing.latest_transcript.clone()
            }));
        }
        let child_ref = child_session_ref(&existing);
        sessions::ensure_session_ready(kernel, &child_ref).await?;
        let status = initial_prompt_delivery_status(kernel, &child_ref, &prompt)?.ok_or_else(|| {
            CoreError::new(
                "Child thread has no evidence that its initial prompt started a run or produced a response.",
            )
        })?;
        return Ok((existing, status));
    }

    if let Some(key) = &pending_key {
        kernel
            .data
            .borrow_mut()
            .orchestration
            .pending_create_tool_calls
            .insert(key.clone());
    }
    let result = spawn_child(kernel, &input, &prompt, &workspace).await;
    if let Some(key) = &pending_key {
        kernel
            .data
            .borrow_mut()
            .orchestration
            .pending_create_tool_calls
            .remove(key);
    }
    result
}

async fn spawn_child(
    kernel: &Kernel,
    input: &SpawnChildThreadInput,
    prompt: &str,
    workspace: &crate::state::driver::WorkspaceRef,
) -> CoreResult<(OrchestrationChildThread, DeliveryStatus)> {
    let parent = &input.parent;
    let mut options = settings::build_create_session_options(kernel, &parent.workspace_id)
        .await?
        .unwrap_or_default();
    options.insert("title".into(), json!(title_from_prompt(prompt)));
    let session: SessionSnapshot = driver_call(
        kernel.driver(),
        "createSession",
        args([json!(workspace), Value::Object(options)]),
    )
    .await?;
    let child_ref = session.session_ref.clone();
    sessions::seed_session(&mut kernel.data.borrow_mut(), &session);
    sessions::ensure_session_subscription(kernel, &child_ref).await?;

    let now = kernel.env().now_iso();
    let git = workspace_git_ref(&parent.workspace_id, &workspace.path).await;
    let child = {
        let data = kernel.data.borrow();
        let env = kernel.env();
        let status = to_orchestration_status(&data, session.status, &child_ref);
        let mut child = OrchestrationChildThread {
            id: env.random_uuid(),
            source_tool_call_id: input.source_tool_call_id.clone(),
            parent_workspace_id: parent.workspace_id.clone(),
            parent_session_id: parent.session_id.clone(),
            child_workspace_id: child_ref.workspace_id.clone(),
            child_session_id: child_ref.session_id.clone(),
            title: if session.title.is_empty() {
                title_from_prompt(prompt)
            } else {
                session.title.clone()
            },
            goal: prompt.to_owned(),
            status,
            latest_transcript: session
                .preview
                .clone()
                .filter(|preview| !preview.is_empty())
                .unwrap_or_else(|| prompt.to_owned()),
            transcript: Vec::new(),
            evidence: Vec::new(),
            supervision_loop: Some(create_supervision_loop(env, status, &now)),
            created_at: now.clone(),
            updated_at: if session.updated_at.is_empty() {
                now.clone()
            } else {
                session.updated_at.clone()
            },
        };
        let mut created = evidence(
            evidence_id(
                "created",
                input
                    .source_tool_call_id
                    .as_deref()
                    .unwrap_or(&child_ref.session_id),
            ),
            &child,
            (
                Kind::OrchestratorAcceptance,
                Source::OrchestratorAccepted,
                EvidenceStatus::Accepted,
            ),
            "Child thread created",
            &now,
        );
        created.detail = Some(prompt.to_owned());
        created.git = git;
        child.evidence = vec![created];
        child
    };

    {
        let mut data = kernel.data.borrow_mut();
        let mut children = vec![child.clone()];
        children.extend(data.state.orchestration_children.iter().cloned());
        data.state.orchestration_children = project_children(&data, kernel.env(), &children);
    }
    refresh::refresh_state(
        kernel,
        RefreshOptions {
            selected_workspace_id: Some(parent.workspace_id.clone()),
            selected_session_id: Some(parent.session_id.clone()),
            clear_last_error: true,
            active_view: Some(AppView::Threads),
            emit_state: Some(false),
            persist_state: Some(false),
            publish_selected_transcript: Some(false),
            ..Default::default()
        },
    )
    .await?;

    let delivery = match launch_initial_child_prompt(kernel, &child_ref, prompt).await {
        Ok(delivery) => delivery,
        Err(error) => {
            mark_initial_prompt_delivery_failed(kernel, &child.id, &error.message);
            persist::persist_ui_state(kernel).await?;
            return Err(error);
        }
    };
    let stored = kernel
        .data
        .borrow()
        .state
        .orchestration_children
        .iter()
        .find(|entry| entry.id == child.id)
        .cloned();
    Ok((stored.unwrap_or(child), delivery))
}

/// `launchInitialChildPrompt`: sends the prompt and answers once the child shows it running
/// (after a short grace, so a quick failure still wins) or answering, without waiting for the
/// turn to finish.
async fn launch_initial_child_prompt(
    kernel: &Kernel,
    child_ref: &SessionRef,
    prompt: &str,
) -> CoreResult<DeliveryStatus> {
    let (events_tx, mut events) = mpsc::unbounded_channel();
    let launch_id = {
        let mut data = kernel.data.borrow_mut();
        let orchestration = &mut data.orchestration;
        orchestration.next_launch_id += 1;
        let id = orchestration.next_launch_id;
        orchestration
            .launches
            .push((id, session_key(child_ref), events_tx));
        id
    };

    // The submission keeps going after the launch answers, as the TypeScript promise does.
    let (submitted_tx, mut submitted) = oneshot::channel();
    let submitter = kernel.rc();
    let submit_ref = child_ref.clone();
    let submit_prompt = prompt.to_owned();
    tokio::task::spawn_local(async move {
        let result = crate::app::conversation::submit::submit_composer_to_session(
            &submitter,
            &submit_ref,
            &submit_prompt,
            Vec::new(),
            Some(SessionMessageDeliveryMode::FollowUp),
            false,
        )
        .await;
        let _ = submitted_tx.send(result.map(|_| ()));
    });

    let deadline = tokio::time::sleep(Duration::from_millis(CHILD_START_TIMEOUT_MS));
    tokio::pin!(deadline);
    let mut running_grace: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut submission_settled = false;
    let acknowledge = |running_grace: &mut Option<std::pin::Pin<Box<tokio::time::Sleep>>>| {
        match initial_prompt_delivery_status(kernel, child_ref, prompt)? {
            Some(DeliveryStatus::Responded) => return Ok(Some(DeliveryStatus::Responded)),
            Some(DeliveryStatus::Running) if running_grace.is_none() => {
                // The driver publishes `running` just before pi starts the prompt. Racing the
                // submission and failure events against a short grace lets deterministic auth
                // and config failures win without waiting for the turn.
                *running_grace = Some(Box::pin(tokio::time::sleep(Duration::from_millis(
                    CHILD_RUNNING_FAILURE_GRACE_MS,
                ))));
            }
            _ => {}
        }
        Ok(None)
    };
    let result = loop {
        tokio::select! {
            () = &mut deadline => {
                break Err(CoreError::new(format!(
                    "Child thread did not acknowledge its initial prompt within {CHILD_START_TIMEOUT_MS}ms."
                )));
            }
            () = async { running_grace.as_mut().expect("guarded").await }, if running_grace.is_some() => {
                break Ok(DeliveryStatus::Running);
            }
            Some(event) = events.recv() => match event {
                LaunchEvent::RunFailed(message) => {
                    break Err(CoreError::new(format!("Failed to start child thread: {message}")));
                }
                LaunchEvent::ClosedFailed => {
                    break Err(CoreError::new(
                        "Failed to start child thread: the child session closed.",
                    ));
                }
                LaunchEvent::Other => match acknowledge(&mut running_grace) {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => {}
                    Err(error) => break Err(error),
                },
            },
            outcome = &mut submitted, if !submission_settled => {
                submission_settled = true;
                match outcome {
                    Ok(Ok(())) => match acknowledge(&mut running_grace) {
                        Ok(Some(status)) => break Ok(status),
                        Ok(None) if running_grace.is_none() => {
                            break Err(CoreError::new(
                                "Child thread prompt submission completed without starting a run or producing a response.",
                            ));
                        }
                        Ok(None) => {}
                        Err(error) => break Err(error),
                    },
                    Ok(Err(error)) => break Err(error),
                    Err(_) => break Err(CoreError::new("pi-gui is shutting down")),
                }
            }
        }
    };
    kernel
        .data
        .borrow_mut()
        .orchestration
        .launches
        .retain(|(id, _, _)| *id != launch_id);
    result
}

/// Hands a child's session event to the launches waiting on that child.
pub fn notify_launches(kernel: &Kernel, key: &str, event: impl Fn() -> LaunchEvent) {
    let data = kernel.data.borrow();
    for (_, child_key, sender) in &data.orchestration.launches {
        if child_key == key {
            let _ = sender.send(event());
        }
    }
}

/// `initialPromptDeliveryStatus`: whether the child shows the prompt running or answered.
fn initial_prompt_delivery_status(
    kernel: &Kernel,
    child_ref: &SessionRef,
    prompt: &str,
) -> CoreResult<Option<DeliveryStatus>> {
    let data = kernel.data.borrow();
    if let Some(error) = data
        .sessions
        .session_errors_by_session
        .get(&session_key(child_ref))
        .filter(|error| !error.is_empty())
    {
        return Err(CoreError::new(format!(
            "Failed to start child thread: {error}"
        )));
    }
    let session = data.session(child_ref);
    if let Some(session) = session.filter(|session| session.status == SessionStatus::Failed) {
        let reason = if session.preview.is_empty() {
            "the child session failed."
        } else {
            &session.preview
        };
        return Err(CoreError::new(format!(
            "Failed to start child thread: {reason}"
        )));
    }
    let transcript = transcript_for(&data, child_ref);
    let Some(prompt_index) = transcript.iter().position(|item| {
        matches!(item, TranscriptMessage::Message(message)
            if message.role == SessionTranscriptRole::User && message.text == prompt)
    }) else {
        return Ok(None);
    };
    if transcript[prompt_index + 1..]
        .iter()
        .any(is_worker_response)
    {
        return Ok(Some(DeliveryStatus::Responded));
    }
    Ok(session
        .is_some_and(|session| session.status == SessionStatus::Running)
        .then_some(DeliveryStatus::Running))
}

/// `markInitialPromptDeliveryFailed`.
fn mark_initial_prompt_delivery_failed(kernel: &Kernel, child_thread_id: &str, message: &str) {
    let now = kernel.env().now_iso();
    let mut data = kernel.data.borrow_mut();
    for child in data.state.orchestration_children.iter_mut() {
        if child.id != child_thread_id {
            continue;
        }
        let mut failed = evidence(
            evidence_id(
                "delivery-failed",
                child
                    .source_tool_call_id
                    .as_deref()
                    .unwrap_or(&child.child_session_id),
            ),
            child,
            (Kind::Blocker, Source::Blocker, EvidenceStatus::Failed),
            "Initial prompt delivery failed",
            &now,
        );
        failed.detail = Some(message.to_owned());
        child.status = OrchestrationChildThreadStatus::Failed;
        child.latest_transcript = message.to_owned();
        child.evidence = merge_evidence_records(&child.evidence, vec![failed]);
        child.updated_at = now.clone();
    }
}

/// `titleFromPrompt`: one line, at most 56 characters.
fn title_from_prompt(prompt: &str) -> String {
    let normalized = crate::js::trim(&crate::js::collapse_whitespace(prompt)).to_owned();
    if crate::js::length(&normalized) <= CHILD_TITLE_LIMIT {
        return normalized;
    }
    let cut = crate::js::utf16_prefix(&normalized, CHILD_TITLE_LIMIT - 3);
    format!("{}...", cut.trim_end_matches(crate::js::is_space))
}

/// `workspaceGitRef`: the folder's branch and commit when it is a Git checkout.
async fn workspace_git_ref(
    workspace_id: &str,
    workspace_path: &str,
) -> Option<OrchestrationEvidenceGitRef> {
    let output = GitCommand::new(["rev-parse", "--abbrev-ref", "HEAD", "HEAD"])
        .cwd(Path::new(workspace_path))
        .text()
        .await
        .unwrap_or_default();
    let mut lines = output
        .split('\n')
        .map(crate::js::trim)
        .filter(|line| !line.is_empty());
    let branch = lines.next();
    let head = lines.next();
    let branch_name = branch.filter(|branch| *branch != "HEAD");
    if branch_name.is_none() && head.is_none() {
        return None;
    }
    Some(OrchestrationEvidenceGitRef {
        workspace_id: workspace_id.to_owned(),
        branch_name: branch_name.map(str::to_owned),
        head_sha: head.map(str::to_owned),
    })
}

// ---- Follow-ups, the supervision gate and Stop ----

/// `updateChildSupervisionLoop`: the parent's choice for one child's loop.
pub fn update_child_supervision_loop(
    kernel: &Kernel,
    child_thread_id: &str,
    gate: Gate,
    reason: &str,
) {
    let env = kernel.env();
    let now = env.now_iso();
    let mut data = kernel.data.borrow_mut();
    for child in data.state.orchestration_children.iter_mut() {
        if child.id != child_thread_id {
            continue;
        }
        let existing = child
            .supervision_loop
            .clone()
            .unwrap_or_else(|| create_supervision_loop(env, child.status, &now));
        let interval_ms = if existing.interval_ms.0 == 0.0 || existing.interval_ms.0.is_nan() {
            supervision_interval_ms()
        } else {
            existing.interval_ms.0
        };
        let stop = gate == Gate::Stop;
        child.supervision_loop = Some(OrchestrationSupervisionLoop {
            status: if stop {
                LoopStatus::Stopped
            } else {
                LoopStatus::Monitoring
            },
            gate,
            interval_ms: crate::js::JsNumber(interval_ms),
            last_checked_at: now.clone(),
            next_run_at: (!stop).then(|| next_iso(env, &now, interval_ms)),
            reason: reason.to_owned(),
            last_child_status: child.status,
            stopped_at: stop.then(|| now.clone()),
            ..existing
        });
    }
}

fn find_child(kernel: &Kernel, child_thread_id: &str) -> Option<OrchestrationChildThread> {
    kernel
        .data
        .borrow()
        .state
        .orchestration_children
        .iter()
        .find(|child| child.id == child_thread_id)
        .cloned()
}

/// `sendChildThreadFollowUp`.
pub async fn send_child_thread_follow_up(
    kernel: &Kernel,
    child_thread_id: &str,
    text: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let text = crate::js::trim(text);
    if text.is_empty() {
        return sessions::with_error(kernel, "Child thread follow-up cannot be empty.".into())
            .await;
    }
    let Some(child) = find_child(kernel, child_thread_id) else {
        return sessions::with_error(kernel, "Unknown child thread.".into()).await;
    };
    if child.child_session_id.is_empty() {
        return sessions::with_error(kernel, "Legacy child thread records are read-only.".into())
            .await;
    }
    let child_ref = child_session_ref(&child);
    if kernel.data.borrow().session(&child_ref).is_none() {
        return sessions::with_error(
            kernel,
            "Child thread session is no longer available.".into(),
        )
        .await;
    }
    crate::app::conversation::submit::submit_composer_to_session(
        kernel,
        &child_ref,
        text,
        Vec::new(),
        Some(SessionMessageDeliveryMode::FollowUp),
        false,
    )
    .await?;
    update_child_supervision_loop(
        kernel,
        &child.id,
        Gate::Continue,
        "Follow-up sent; monitoring child progress.",
    );
    persist::persist_ui_state(kernel).await?;
    Ok(publish::emit(kernel))
}

/// `setChildSupervisionLoopGate`.
pub async fn set_child_supervision_loop_gate(
    kernel: &Kernel,
    child_thread_id: &str,
    gate: Gate,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(child) = find_child(kernel, child_thread_id) else {
        return sessions::with_error(kernel, "Unknown child thread.".into()).await;
    };
    // Stopping supervision must also stop the child agent: otherwise the loop stops watching
    // but the child keeps running (and spending) unsupervised.
    if gate == Gate::Stop {
        cancel_child_run(kernel, &child).await;
    }
    update_child_supervision_loop(
        kernel,
        child_thread_id,
        gate,
        if gate == Gate::Stop {
            "Parent stopped app-owned supervision for this child."
        } else {
            "Parent continued app-owned supervision."
        },
    );
    persist::persist_ui_state(kernel).await?;
    Ok(publish::emit(kernel))
}

/// `cancelChildRun`: best effort.
async fn cancel_child_run(kernel: &Kernel, child: &OrchestrationChildThread) {
    if child.child_session_id.is_empty() {
        return;
    }
    let _ = kernel
        .driver()
        .call("cancelCurrentRun", args([json!(child_session_ref(child))]))
        .await;
}

/// `cancelChildRunsForParent`: Stop on a thread also stops its children, so they do not keep
/// running unsupervised.
pub async fn cancel_child_runs_for_parent(kernel: &Kernel, parent: &SessionRef) {
    let children: Vec<OrchestrationChildThread> = kernel
        .data
        .borrow()
        .state
        .orchestration_children
        .iter()
        .filter(|child| {
            child.parent_workspace_id == parent.workspace_id
                && child.parent_session_id == parent.session_id
        })
        .cloned()
        .collect();
    crate::app::futures_join_all(children.iter().map(|child| cancel_child_run(kernel, child)))
        .await;
}
