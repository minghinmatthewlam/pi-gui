//! The `scheduled.*` tool bodies pi calls through the host's `app.tool` (the store's
//! `…ToolResult` methods and main's `runPiGuiTool`). The tools' parameters are parsed in the
//! pi host, which keeps the tool definitions; these get the parsed input.

use super::Kernel;
use super::{create_task, mutation_queue, schedule_scheduled_tasks, tasks, update_task};
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{ScheduledTaskStatus, ScheduledTaskTarget};
use crate::state::driver::SessionRef;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

const CREATE_ACTION: &str = "pi_gui_create_scheduled_task";
const LIST_ACTION: &str = "pi_gui_list_scheduled_tasks";
const UPDATE_ACTION: &str = "pi_gui_update_scheduled_task";

/// `ToolCaller`: the session a tool runs in, as pi knows it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCaller {
    pub cwd: String,
    pub session_id: String,
}

#[derive(Deserialize)]
struct ToolCall {
    tool: String,
    caller: ToolCaller,
    #[serde(default)]
    input: Option<Value>,
}

/// `findSessionRefByCwdAndSessionId`.
pub fn find_session_ref_by_cwd_and_session_id(
    kernel: &Kernel,
    cwd: &str,
    session_id: &str,
) -> Option<SessionRef> {
    let resolve = |path: &str| crate::paths::resolve(Path::new("/"), path);
    let cwd = resolve(cwd);
    let data = kernel.data.borrow();
    let workspace = data
        .state
        .workspaces
        .iter()
        .find(|workspace| resolve(&workspace.path) == cwd)?;
    workspace
        .sessions
        .iter()
        .any(|session| session.id == session_id)
        .then(|| crate::state::driver::session_ref(&workspace.id, session_id))
}

/// `sessionRefFromExtensionContext`.
pub fn session_ref_from_caller(kernel: &Kernel, caller: &ToolCaller) -> CoreResult<SessionRef> {
    let cwd = crate::paths::resolve(Path::new("/"), &caller.cwd);
    find_session_ref_by_cwd_and_session_id(kernel, &caller.cwd, &caller.session_id).ok_or_else(
        || {
            CoreError::new(format!(
                "Unable to resolve orchestration session for {}:{}",
                cwd.display(),
                caller.session_id
            ))
        },
    )
}

/// Whether `tool` is one of these.
pub fn is_scheduled_tool(params: &Value) -> bool {
    params["tool"]
        .as_str()
        .is_some_and(|tool| tool.starts_with("scheduled."))
}

/// `runPiGuiTool` for the `scheduled.*` tools.
pub async fn run_tool(kernel: &Kernel, params: Value) -> CoreResult<Value> {
    let call: ToolCall = crate::parse(params)?;
    kernel.initialize().await;
    let input = call.input.unwrap_or(Value::Null);
    match call.tool.as_str() {
        "scheduled.createScheduledTask" => {
            let parent = session_ref_from_caller(kernel, &call.caller)?;
            create_scheduled_task_tool_result(kernel, &parent, input).await
        }
        "scheduled.listScheduledTasks" => list_scheduled_tasks_tool_result(kernel).await,
        "scheduled.updateScheduledTask" => update_scheduled_task_tool_result(kernel, input).await,
        "scheduled.fallbackWorkspaceId" => Ok(session_ref_from_caller(kernel, &call.caller)
            .map_or(Value::Null, |session_ref| json!(session_ref.workspace_id))),
        other => Err(CoreError::new(format!("Unknown pi-gui tool: {other}"))),
    }
}

fn text_result(text: &str, details: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "details": details })
}

/// `createScheduledTaskToolResult`: the task is created for the thread the tool ran in.
async fn create_scheduled_task_tool_result(
    kernel: &Kernel,
    parent: &SessionRef,
    mut input: Value,
) -> CoreResult<Value> {
    let result = {
        let mutations = mutation_queue(kernel);
        let _turn = mutations.lock().await;
        let before: Vec<String> = tasks(kernel).into_iter().map(|task| task.id).collect();
        if let Some(object) = input.as_object_mut() {
            if object.get("originSessionId").is_none_or(Value::is_null) {
                object.insert("originSessionId".into(), json!(parent.session_id));
            }
        }
        create_task(kernel, input).await.map(|state| {
            let created = state
                .scheduled_tasks
                .iter()
                .find(|task| !before.contains(&task.id));
            match (created, &state.last_error) {
                (Some(created), None) => text_result(
                    &format!(
                        "Scheduled \"{}\" ({}). Next run {}.",
                        created.title,
                        created.id,
                        created.next_run_at.as_deref().unwrap_or("unknown")
                    ),
                    json!({
                        "action": CREATE_ACTION,
                        "taskId": created.id,
                        "title": created.title,
                        "nextRunAt": created.next_run_at,
                    }),
                ),
                (_, error) => {
                    let message = error
                        .clone()
                        .unwrap_or_else(|| "create_scheduled_task failed.".to_owned());
                    text_result(
                        &message,
                        json!({ "action": CREATE_ACTION, "error": message }),
                    )
                }
            }
        })
    };
    schedule_scheduled_tasks(kernel);
    result.map(without_nulls)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListedTask {
    id: String,
    title: String,
    status: ScheduledTaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_run_at: Option<String>,
    target: String,
}

/// `listScheduledTasksToolResult`.
async fn list_scheduled_tasks_tool_result(kernel: &Kernel) -> CoreResult<Value> {
    let mutations = mutation_queue(kernel);
    let _turn = mutations.lock().await;
    let listed: Vec<ListedTask> = tasks(kernel)
        .into_iter()
        .map(|task| ListedTask {
            target: match &task.target {
                ScheduledTaskTarget::NewThread { workspace_id } => {
                    format!("new thread in {workspace_id}")
                }
                ScheduledTaskTarget::ExistingThread { session_id, .. } => {
                    format!("thread {session_id}")
                }
            },
            id: task.id,
            title: task.title,
            status: task.status,
            next_run_at: task.next_run_at.filter(|at| !at.is_empty()),
        })
        .collect();
    let text = if listed.is_empty() {
        "No scheduled tasks.".to_owned()
    } else {
        listed
            .iter()
            .map(|task| {
                let next = task
                    .next_run_at
                    .as_deref()
                    .map(|at| format!(" · {at}"))
                    .unwrap_or_default();
                format!(
                    "{} · {} · {}{next}",
                    task.id,
                    task.title,
                    super::status_name(task.status)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(text_result(
        &text,
        json!({ "action": LIST_ACTION, "tasks": listed }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolUpdate {
    task_id: String,
    #[serde(default)]
    patch: Option<Value>,
}

/// `updateScheduledTaskToolResult`. The tool's schedule fields arrive already merged into
/// `patch` or not at all: the host cannot send the definition's `resolveSchedule` function.
async fn update_scheduled_task_tool_result(kernel: &Kernel, input: Value) -> CoreResult<Value> {
    let input: ToolUpdate = crate::parse(input)?;
    let result = {
        let mutations = mutation_queue(kernel);
        let _turn = mutations.lock().await;
        let patch = input.patch.unwrap_or_else(|| json!({}));
        update_task(kernel, &input.task_id, patch).await.map(|state| {
            let task = state
                .scheduled_tasks
                .iter()
                .find(|task| task.id == input.task_id);
            match (task, &state.last_error) {
                (Some(task), None) => text_result(
                    &format!(
                        "Updated scheduled task {} ({}).",
                        task.id,
                        super::status_name(task.status)
                    ),
                    json!({
                        "action": UPDATE_ACTION,
                        "taskId": task.id,
                        "status": task.status,
                        "nextRunAt": task.next_run_at,
                    }),
                ),
                (_, error) => {
                    let message = error
                        .clone()
                        .unwrap_or_else(|| "update_scheduled_task failed.".to_owned());
                    text_result(
                        &message,
                        json!({ "action": UPDATE_ACTION, "taskId": input.task_id, "error": message }),
                    )
                }
            }
        })
    };
    schedule_scheduled_tasks(kernel);
    result.map(without_nulls)
}

/// `undefined` fields are left out of the result, as JSON from the TypeScript leaves them.
fn without_nulls(mut value: Value) -> Value {
    if let Some(details) = value.get_mut("details").and_then(Value::as_object_mut) {
        details.retain(|_, field| !field.is_null());
    }
    value
}
