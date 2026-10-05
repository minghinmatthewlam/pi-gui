//! The thread tools pi runs (`create_child_thread`, `list_threads`, `read_thread`,
//! `send_message_to_thread`): their bodies, which the pi host calls through `app.tool`, and the
//! rewrite of their timeline rows once they finish. The tool definitions stay in the pi host
//! (`orchestration-runtime.ts`); these get the parsed input.

use super::children::{
    child_for_tool_call, create_child_thread_record, update_child_supervision_loop, DeliveryStatus,
    SpawnChildThreadInput,
};
use super::project::{
    child_session_ref, project_children, queued_message_count, text_from_tool_output,
    to_child_transcript, transcript_for, CREATE_CHILD_THREAD_ACTION, LIST_THREADS_ACTION,
    READ_THREAD_ACTION, SEND_MESSAGE_TO_THREAD_ACTION,
};
use super::Kernel;
use crate::app::scheduled::tools::{session_ref_from_caller, ToolCaller};
use crate::app::{persist, sessions, AppData};
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{
    OrchestrationChildThread, OrchestrationChildTranscriptMessage,
    OrchestrationSupervisionGate as Gate,
};
use crate::state::driver::{
    session_key, session_ref, SessionDriverEvent, SessionEventKind, SessionMessageDeliveryMode,
    SessionRef,
};
use crate::state::timeline_types::{TimelineToolStatus, TranscriptMessage};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;

const CREATE_CHILD_THREAD_TOOL: &str = "create_child_thread";
const LIST_THREADS_TOOL: &str = "list_threads";
const READ_THREAD_TOOL: &str = "read_thread";
const SEND_MESSAGE_TO_THREAD_TOOL: &str = "send_message_to_thread";
const MAX_READ_THREAD_MESSAGES: usize = 60;

#[derive(Deserialize)]
struct ToolCall {
    tool: String,
    caller: ToolCaller,
    #[serde(default)]
    input: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChildThreadInput {
    prompt: String,
    tool_call_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageInput {
    thread_id: String,
    message: String,
}

/// `runPiGuiTool` for the `orchestration.*` tools, in the thread the tool runs in.
pub async fn run_tool(kernel: &Kernel, params: Value) -> CoreResult<Value> {
    let call: ToolCall = crate::parse(params)?;
    kernel.initialize().await;
    let input = call.input.unwrap_or(Value::Null);
    match call.tool.as_str() {
        "orchestration.createChildThread" => {
            let parent = session_ref_from_caller(kernel, &call.caller)?;
            let input: CreateChildThreadInput = crate::parse(input)?;
            create_child_thread_tool_result(kernel, &parent, &input.prompt, &input.tool_call_id)
                .await
        }
        "orchestration.listThreads" => {
            let parent = session_ref_from_caller(kernel, &call.caller)?;
            Ok(list_threads_tool_result(kernel, &parent))
        }
        "orchestration.readThread" => {
            let parent = session_ref_from_caller(kernel, &call.caller)?;
            let thread_id: String = crate::parse(input)?;
            read_thread_tool_result(kernel, &parent, &thread_id).await
        }
        "orchestration.sendMessageToThread" => {
            let parent = session_ref_from_caller(kernel, &call.caller)?;
            let input: SendMessageInput = crate::parse(input)?;
            send_message_to_thread_tool_result(kernel, &parent, &input.thread_id, &input.message)
                .await
        }
        other => Err(CoreError::new(format!("Unknown pi-gui tool: {other}"))),
    }
}

fn tool_result(text: &str, details: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "details": details })
}

// ---- Tool bodies ----

/// `createChildThreadToolResult`.
async fn create_child_thread_tool_result(
    kernel: &Kernel,
    parent: &SessionRef,
    prompt: &str,
    tool_call_id: &str,
) -> CoreResult<Value> {
    let (child, delivery) = create_child_thread_record(
        kernel,
        SpawnChildThreadInput {
            parent: parent.clone(),
            prompt: prompt.to_owned(),
            source_tool_call_id: Some(tool_call_id.to_owned()),
        },
    )
    .await?;
    let prompt = crate::js::trim(prompt);
    let text = format!(
        "Created child thread: {}\nchildThreadId: {}\nchildWorkspaceId: {}\nchildSessionId: {}\ninitialPrompt: {}",
        child.title,
        child.id,
        child.child_workspace_id,
        child.child_session_id,
        delivery_name(delivery)
    );
    Ok(tool_result(
        &text,
        create_child_thread_details(prompt, &child, delivery),
    ))
}

fn delivery_name(delivery: DeliveryStatus) -> &'static str {
    match delivery {
        DeliveryStatus::Running => "running",
        DeliveryStatus::Responded => "responded",
    }
}

fn create_child_thread_details(
    prompt: &str,
    child: &OrchestrationChildThread,
    delivery: DeliveryStatus,
) -> Value {
    json!({
        "action": CREATE_CHILD_THREAD_ACTION,
        "prompt": prompt,
        "childThreadId": child.id,
        "childWorkspaceId": child.child_workspace_id,
        "childSessionId": child.child_session_id,
        "title": child.title,
        "deliveryStatus": delivery,
    })
}

/// `listThreadsToolResult`.
fn list_threads_tool_result(kernel: &Kernel, parent: &SessionRef) -> Value {
    let mut data = kernel.data.borrow_mut();
    let children = project_children(&data, kernel.env(), &data.state.orchestration_children);
    data.state.orchestration_children = children;
    let threads = list_threads_for_context(&data, parent);
    tool_result(
        &format_thread_list(&threads),
        json!({ "action": LIST_THREADS_ACTION, "threads": threads }),
    )
}

/// `readThreadToolResult`.
async fn read_thread_tool_result(
    kernel: &Kernel,
    parent: &SessionRef,
    thread_id: &str,
) -> CoreResult<Value> {
    let Some((target, child)) = resolve_thread_target(&kernel.data.borrow(), parent, thread_id)
    else {
        return Ok(read_thread_error_result(
            thread_id,
            &format!("Unknown thread: {thread_id}"),
        ));
    };
    sessions::ensure_session_ready(kernel, &target).await?;
    let data = kernel.data.borrow();
    let messages = to_child_transcript(transcript_for(&data, &target), MAX_READ_THREAD_MESSAGES);
    let session = data.session(&target);
    let title = session
        .map(|session| session.title.clone())
        .or_else(|| child.as_ref().map(|child| child.title.clone()))
        .unwrap_or_else(|| target.session_id.clone());
    let status = match (&child, session) {
        (Some(child), _) => enum_name(&child.status),
        (None, Some(session)) => enum_name(&session.status),
        (None, None) => "unknown".to_owned(),
    };
    let mut details = json!({
        "action": READ_THREAD_ACTION,
        "threadId": thread_id,
        "workspaceId": target.workspace_id,
        "sessionId": target.session_id,
        "title": title,
        "status": status,
    });
    if let Some(child) = &child {
        details["childThreadId"] = json!(child.id);
        details["goal"] = json!(child.goal);
    }
    details["messages"] = json!(messages);
    let goal = child.as_ref().map(|child| child.goal.as_str());
    Ok(tool_result(
        &format_thread_read_result(thread_id, &title, &status, goal, &messages),
        details,
    ))
}

/// `sendMessageToThreadToolResult`.
async fn send_message_to_thread_tool_result(
    kernel: &Kernel,
    parent: &SessionRef,
    thread_id: &str,
    message: &str,
) -> CoreResult<Value> {
    let Some((target, child)) = resolve_thread_target(&kernel.data.borrow(), parent, thread_id)
    else {
        return Ok(send_message_error_result(
            thread_id,
            message,
            &format!("Unknown thread: {thread_id}"),
        ));
    };
    crate::app::conversation::submit::submit_composer_to_session(
        kernel,
        &target,
        message,
        Vec::new(),
        Some(SessionMessageDeliveryMode::FollowUp),
        false,
    )
    .await?;
    if let Some(child) = &child {
        update_child_supervision_loop(
            kernel,
            &child.id,
            Gate::Continue,
            "Follow-up sent; monitoring child progress.",
        );
        persist::persist_ui_state(kernel).await?;
    }
    let queued = queued_message_count(&kernel.data.borrow(), &target);
    let queued_status = if queued > 0 { "queued" } else { "sent" };
    let text = format!(
        "{} message to thread {thread_id}.{}",
        if queued > 0 { "Queued" } else { "Sent" },
        if queued > 0 {
            format!(" Pending messages: {queued}.")
        } else {
            String::new()
        }
    );
    Ok(tool_result(
        &text,
        json!({
            "action": SEND_MESSAGE_TO_THREAD_ACTION,
            "threadId": thread_id,
            "workspaceId": target.workspace_id,
            "sessionId": target.session_id,
            "status": queued_status,
            "queuedMessageCount": queued,
            "message": message,
        }),
    ))
}

fn create_child_thread_error_result(prompt: &str, error: &str) -> Value {
    tool_result(
        error,
        json!({ "action": CREATE_CHILD_THREAD_ACTION, "prompt": prompt, "error": error }),
    )
}

fn read_thread_error_result(thread_id: &str, error: &str) -> Value {
    tool_result(
        error,
        json!({ "action": READ_THREAD_ACTION, "threadId": thread_id, "error": error }),
    )
}

fn send_message_error_result(thread_id: &str, message: &str, error: &str) -> Value {
    tool_result(
        error,
        json!({
            "action": SEND_MESSAGE_TO_THREAD_ACTION,
            "threadId": thread_id,
            "message": message,
            "error": error,
        }),
    )
}

/// A status enum as its JSON name.
fn enum_name(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

// ---- Visible threads ----

/// `OrchestrationThreadListEntry`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListEntry {
    thread_id: String,
    workspace_id: String,
    session_id: String,
    title: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    supervision_gate: Option<Gate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supervision_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_supervision_run_at: Option<String>,
    relationship: Relationship,
    updated_at: String,
    preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_thread_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
enum Relationship {
    Current,
    Child,
    Workspace,
}

impl ThreadListEntry {
    fn for_child(child: &OrchestrationChildThread) -> Self {
        let current = child.supervision_loop.as_ref();
        Self {
            thread_id: child.id.clone(),
            workspace_id: child.child_workspace_id.clone(),
            session_id: child.child_session_id.clone(),
            title: child.title.clone(),
            status: enum_name(&child.status),
            supervision_gate: current.map(|current| current.gate),
            supervision_reason: current.map(|current| current.reason.clone()),
            next_supervision_run_at: current
                .and_then(|current| current.next_run_at.clone())
                .filter(|at| !at.is_empty()),
            relationship: Relationship::Child,
            updated_at: child.updated_at.clone(),
            preview: child.latest_transcript.clone(),
            child_thread_id: Some(child.id.clone()),
        }
    }
}

/// `listThreadsForContext`: the parent's own folder and its children's, current thread first,
/// then children, then the rest, newest first.
fn list_threads_for_context(data: &AppData, parent: &SessionRef) -> Vec<ThreadListEntry> {
    let parent_children: Vec<&OrchestrationChildThread> = data
        .state
        .orchestration_children
        .iter()
        .filter(|child| {
            child.parent_workspace_id == parent.workspace_id
                && child.parent_session_id == parent.session_id
        })
        .collect();
    let child_by_key: IndexMap<String, &OrchestrationChildThread> = parent_children
        .iter()
        .map(|child| (session_key(&child_session_ref(child)), *child))
        .collect();
    let mut entries: IndexMap<String, ThreadListEntry> = IndexMap::new();
    for workspace in &data.state.workspaces {
        if workspace.id != parent.workspace_id
            && !parent_children
                .iter()
                .any(|child| child.child_workspace_id == workspace.id)
        {
            continue;
        }
        for session in &workspace.sessions {
            if session
                .archived_at
                .as_deref()
                .is_some_and(|at| !at.is_empty())
            {
                continue;
            }
            let key = session_key(&session_ref(&workspace.id, &session.id));
            let entry = match child_by_key.get(&key) {
                Some(child) => ThreadListEntry::for_child(child),
                None => ThreadListEntry {
                    thread_id: session.id.clone(),
                    workspace_id: workspace.id.clone(),
                    session_id: session.id.clone(),
                    title: session.title.clone(),
                    status: enum_name(&session.status),
                    supervision_gate: None,
                    supervision_reason: None,
                    next_supervision_run_at: None,
                    relationship: if session.id == parent.session_id
                        && workspace.id == parent.workspace_id
                    {
                        Relationship::Current
                    } else {
                        Relationship::Workspace
                    },
                    updated_at: session.updated_at.clone(),
                    preview: session.preview.clone(),
                    child_thread_id: None,
                },
            };
            entries.insert(key, entry);
        }
    }
    for child in &parent_children {
        let key = session_key(&child_session_ref(child));
        if !entries.contains_key(&key) {
            entries.insert(key, ThreadListEntry::for_child(child));
        }
    }
    let mut threads: Vec<ThreadListEntry> = entries.into_values().collect();
    threads.sort_by(|left, right| {
        let rank = left.relationship.cmp(&right.relationship);
        if rank != Ordering::Equal {
            return rank;
        }
        if left.updated_at != right.updated_at {
            return crate::locale::compare(&right.updated_at, &left.updated_at);
        }
        crate::locale::compare(&left.title, &right.title)
    });
    threads
}

/// `resolveThreadTarget`: a visible thread by thread id, session id, child id or
/// `workspace:session`.
fn resolve_thread_target(
    data: &AppData,
    parent: &SessionRef,
    thread_id: &str,
) -> Option<(SessionRef, Option<OrchestrationChildThread>)> {
    let normalized = crate::js::trim(thread_id);
    if normalized.is_empty() {
        return None;
    }
    let visible = list_threads_for_context(data, parent)
        .into_iter()
        .find(|thread| {
            thread.thread_id == normalized
                || thread.session_id == normalized
                || thread.child_thread_id.as_deref() == Some(normalized)
                || format!("{}:{}", thread.workspace_id, thread.session_id) == normalized
        })?;
    let child = visible.child_thread_id.as_ref().and_then(|id| {
        data.state
            .orchestration_children
            .iter()
            .find(|child| &child.id == id)
            .cloned()
    });
    Some((
        session_ref(&visible.workspace_id, &visible.session_id),
        child,
    ))
}

fn format_thread_list(threads: &[ThreadListEntry]) -> String {
    if threads.is_empty() {
        return "No visible threads.".to_owned();
    }
    let mut lines = vec!["Visible threads:".to_owned()];
    for thread in threads {
        let mut line = format!(
            "- {} ({}, {}): {}",
            thread.thread_id,
            enum_name(&thread.relationship),
            thread.status,
            thread.title
        );
        if let Some(gate) = &thread.supervision_gate {
            line.push_str(&format!(
                " [gate={}: {}]",
                enum_name(gate),
                thread.supervision_reason.as_deref().unwrap_or("monitoring")
            ));
        }
        if !thread.preview.is_empty() {
            line.push_str(&format!(" - {}", thread.preview));
        }
        lines.push(line);
    }
    lines.join("\n")
}

fn format_thread_read_result(
    thread_id: &str,
    title: &str,
    status: &str,
    goal: Option<&str>,
    messages: &[OrchestrationChildTranscriptMessage],
) -> String {
    let mut lines = vec![
        format!("Thread {thread_id}: {title}"),
        format!("Status: {status}"),
    ];
    if let Some(goal) = goal.filter(|goal| !goal.is_empty()) {
        lines.push(format!("Goal: {goal}"));
    }
    lines.push("Transcript:".to_owned());
    if messages.is_empty() {
        lines.push("- No transcript messages loaded.".to_owned());
    } else {
        for message in messages {
            lines.push(format!("- {}: {}", enum_name(&message.role), message.text));
        }
    }
    lines.join("\n")
}

// ---- Finished tool rows ----

/// What a finished thread tool's timeline row shows.
struct Projection {
    detail: String,
    text: String,
    details: Value,
    error: bool,
}

/// `projectionFromToolResult`.
fn projection_from_tool_result(result: &Value) -> Projection {
    let details = result["details"].clone();
    Projection {
        detail: detail_from_thread_tool_details(&details),
        text: text_from_tool_output(result),
        error: details["error"].is_string(),
        details,
    }
}

/// `finalThreadToolProjectionFromOutput`: the output already carries the tool's answer.
fn final_projection_from_output(output: Option<&Value>) -> Option<Projection> {
    let output = output.filter(|output| output.is_object())?;
    let details = output
        .get("details")
        .filter(|details| details.is_object())?;
    if !is_final_thread_tool_details(details) {
        return None;
    }
    Some(Projection {
        detail: detail_from_thread_tool_details(details),
        text: text_from_tool_output(output),
        error: details["error"].is_string(),
        details: details.clone(),
    })
}

fn is_final_thread_tool_details(details: &Value) -> bool {
    if details["error"].is_string() {
        return true;
    }
    match details["action"].as_str() {
        Some(LIST_THREADS_ACTION) => details["threads"].is_array(),
        Some(CREATE_CHILD_THREAD_ACTION) => details["childThreadId"].is_string(),
        Some(READ_THREAD_ACTION) => details["messages"].is_array(),
        Some(SEND_MESSAGE_TO_THREAD_ACTION) => {
            details["status"] == "queued" || details["status"] == "sent"
        }
        _ => false,
    }
}

fn detail_from_thread_tool_details(details: &Value) -> String {
    if let Some(error) = details["error"].as_str() {
        return error.to_owned();
    }
    match details["action"].as_str() {
        Some(LIST_THREADS_ACTION) => {
            let count = details["threads"].as_array().map_or(0, Vec::len);
            format!("Listed {count} thread{}", if count == 1 { "" } else { "s" })
        }
        Some(CREATE_CHILD_THREAD_ACTION) => format!(
            "Created child thread: {}",
            details["title"]
                .as_str()
                .or_else(|| details["prompt"].as_str())
                .unwrap_or("unknown")
        ),
        Some(READ_THREAD_ACTION) => format!(
            "Read thread: {}",
            details["title"]
                .as_str()
                .or_else(|| details["threadId"].as_str())
                .unwrap_or("unknown")
        ),
        Some(SEND_MESSAGE_TO_THREAD_ACTION) => format!(
            "{} message to thread: {}",
            if details["status"] == "queued" {
                "Queued"
            } else {
                "Sent"
            },
            details["threadId"].as_str().unwrap_or("unknown")
        ),
        _ => "Thread tool result".to_owned(),
    }
}

/// `updateThreadToolOutput`: rewrites the tool's row in the thread's transcript.
fn update_thread_tool_output(
    kernel: &Kernel,
    session_ref: &SessionRef,
    call_id: &str,
    projection: Projection,
) {
    let mut data = kernel.data.borrow_mut();
    let Some(transcript) = data
        .sessions
        .transcript_cache
        .get_mut(&session_key(session_ref))
    else {
        return;
    };
    let Some(TranscriptMessage::Tool(tool)) = transcript
        .iter_mut()
        .find(|item| matches!(item, TranscriptMessage::Tool(tool) if tool.call_id == call_id))
    else {
        return;
    };
    if projection.error {
        tool.status = TimelineToolStatus::Error;
    }
    tool.detail = Some(projection.detail);
    tool.output = Some(json!({
        "content": [{ "type": "text", "text": projection.text }],
        "details": projection.details,
    }));
}

/// `refreshParentOrchestrationEvidence`.
fn refresh_parent_orchestration_evidence(kernel: &Kernel, parent: &SessionRef) {
    let mut data = kernel.data.borrow_mut();
    if !data.state.orchestration_children.iter().any(|child| {
        child.parent_workspace_id == parent.workspace_id
            && child.parent_session_id == parent.session_id
    }) {
        return;
    }
    let children = project_children(&data, kernel.env(), &data.state.orchestration_children);
    data.state.orchestration_children = children;
}

/// `stringParam`: a trimmed, non-empty string field.
fn string_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params[key]
        .as_str()
        .map(crate::js::trim)
        .filter(|value| !value.is_empty())
}

/// `threadIdFromParams`.
fn thread_id_from_params(params: &Value) -> Option<&str> {
    string_param(params, "thread_id")
        .or_else(|| string_param(params, "threadId"))
        .or_else(|| string_param(params, "id"))
}

fn output_details(output: Option<&Value>) -> Option<&Value> {
    output
        .filter(|output| output.is_object())?
        .get("details")
        .filter(|details| details.is_object())
}

/// `handleOrchestrationThreadToolResult`: once a thread tool finishes in a thread, its row
/// shows the tool's answer, working it out here when the output only holds the request.
pub async fn handle_orchestration_thread_tool_result(
    kernel: &Kernel,
    event: &SessionDriverEvent,
) -> CoreResult<bool> {
    let SessionEventKind::ToolFinished {
        call_id,
        success: true,
        output,
    } = &event.kind
    else {
        return Ok(false);
    };
    let session_ref = &event.session_ref;
    let tool_name = {
        let data = kernel.data.borrow();
        transcript_for(&data, session_ref)
            .iter()
            .find_map(|item| match item {
                TranscriptMessage::Tool(tool) if &tool.call_id == call_id => {
                    Some(tool.tool_name.clone())
                }
                _ => None,
            })
    };
    let Some(tool_name) = tool_name else {
        return Ok(false);
    };
    let output = output.as_ref();
    match tool_name.as_str() {
        CREATE_CHILD_THREAD_TOOL => {
            handle_create_child_thread_tool_result(kernel, session_ref, call_id, output).await
        }
        LIST_THREADS_TOOL
            if output_details(output)
                .is_some_and(|details| details["action"] == LIST_THREADS_ACTION) =>
        {
            let projection = final_projection_from_output(output).unwrap_or_else(|| {
                projection_from_tool_result(&list_threads_tool_result(kernel, session_ref))
            });
            update_thread_tool_output(kernel, session_ref, call_id, projection);
            refresh_parent_orchestration_evidence(kernel, session_ref);
            Ok(true)
        }
        READ_THREAD_TOOL => {
            let projection = match final_projection_from_output(output) {
                Some(projection) => projection,
                None => {
                    let thread_id = output_details(output)
                        .filter(|details| details["action"] == READ_THREAD_ACTION)
                        .and_then(thread_id_from_params)
                        .map(str::to_owned);
                    match thread_id {
                        Some(thread_id) => projection_from_tool_result(
                            &read_thread_tool_result(kernel, session_ref, &thread_id).await?,
                        ),
                        None => projection_from_tool_result(&read_thread_error_result(
                            "",
                            "read_thread requires a thread_id.",
                        )),
                    }
                }
            };
            update_thread_tool_output(kernel, session_ref, call_id, projection);
            refresh_parent_orchestration_evidence(kernel, session_ref);
            Ok(true)
        }
        SEND_MESSAGE_TO_THREAD_TOOL => {
            let projection = match final_projection_from_output(output) {
                Some(projection) => projection,
                None => {
                    let request = output_details(output)
                        .filter(|details| details["action"] == SEND_MESSAGE_TO_THREAD_ACTION)
                        .and_then(|details| {
                            let thread_id = thread_id_from_params(details)?;
                            let message = string_param(details, "message")
                                .or_else(|| string_param(details, "text"))?;
                            Some((thread_id.to_owned(), message.to_owned()))
                        });
                    match request {
                        Some((thread_id, message)) => projection_from_tool_result(
                            &send_message_to_thread_tool_result(
                                kernel,
                                session_ref,
                                &thread_id,
                                &message,
                            )
                            .await?,
                        ),
                        None => projection_from_tool_result(&send_message_error_result(
                            "",
                            "",
                            "send_message_to_thread requires thread_id and message.",
                        )),
                    }
                }
            };
            update_thread_tool_output(kernel, session_ref, call_id, projection);
            refresh_parent_orchestration_evidence(kernel, session_ref);
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// `handleCreateChildThreadToolResult`: an output holding only the request starts the child
/// here.
async fn handle_create_child_thread_tool_result(
    kernel: &Kernel,
    parent: &SessionRef,
    call_id: &str,
    output: Option<&Value>,
) -> CoreResult<bool> {
    if let Some(projection) = final_projection_from_output(output) {
        update_thread_tool_output(kernel, parent, call_id, projection);
        return Ok(true);
    }
    let Some(prompt) = output_details(output)
        .filter(|details| details["action"] == CREATE_CHILD_THREAD_ACTION)
        .and_then(|details| string_param(details, "prompt"))
        .map(str::to_owned)
    else {
        return Ok(false);
    };
    let created = create_child_thread_record(
        kernel,
        SpawnChildThreadInput {
            parent: parent.clone(),
            prompt: prompt.clone(),
            source_tool_call_id: Some(call_id.to_owned()),
        },
    )
    .await;
    let delivery = match created {
        Ok((_, delivery)) => delivery,
        Err(error) => {
            let message = error.message.clone();
            sessions::with_core_error(kernel, error).await?;
            update_thread_tool_output(
                kernel,
                parent,
                call_id,
                projection_from_tool_result(&create_child_thread_error_result(&prompt, &message)),
            );
            return Ok(true);
        }
    };
    let Some(child) = child_for_tool_call(kernel, parent, call_id) else {
        return Ok(false);
    };
    let text = format!("Created child thread: {}", child.title);
    update_thread_tool_output(
        kernel,
        parent,
        call_id,
        Projection {
            detail: text.clone(),
            text,
            details: create_child_thread_details(&prompt, &child, delivery),
            error: false,
        },
    );
    Ok(true)
}
