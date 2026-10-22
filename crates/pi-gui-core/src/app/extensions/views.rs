//! Extension views (`pi-host/remote-extension-views.ts` and `ipc/extension-view-requests.ts`).
//! Backends run in the pi host; the kernel keeps a copy of the open connections so a window's
//! calls are checked without asking the host, and relays the host's messages to the window that
//! opened each frame. Host actions (open a file, a link, a thread, a task draft) are app work,
//! so they run here.

use super::actions;
use crate::app::dispatch::{self, MethodTable, Reply};
use crate::app::methods::push;
use crate::app::validation::{self, Arg};
use crate::app::{conversation, publish, sessions, workspace, Kernel, WindowId};
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{AppView, DesktopAppState};
use crate::state::driver::SessionRef;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// Host actions one connection may have in flight.
const MAX_PENDING_HOST_ACTIONS: usize = 32;

/// What the kernel keeps of the open extension views.
#[derive(Default)]
pub struct ViewConnections {
    connections: HashMap<String, OpenConnection>,
    /// By client token: the window the host's messages for one frame go to, until the host says
    /// "closed", and the frame's connection id once the open has answered.
    senders: HashMap<String, FrameSender>,
    /// Host actions in flight, by connection.
    pending_actions: HashMap<String, HashSet<String>>,
}

/// The parts of the host's `ExtensionViewConnectionContext` the kernel checks.
struct OpenConnection {
    sender: WindowId,
    target: SessionRef,
    client_token: String,
}

struct FrameSender {
    window: WindowId,
    connection_id: String,
}

pub fn register(table: &mut MethodTable) {
    table.on("listExtensionViews", |kernel, call| {
        Box::pin(async move {
            dispatch::main_frame(&kernel, &call, "pi-gui:list-extension-views")?;
            let target = validation::expect_session_target(call.arg(0), "target")?;
            let views = kernel.driver().views("views.list", json!(target)).await?;
            Ok(Reply::Value(views))
        })
    });
    table.on("openExtensionView", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::main_frame(&kernel, &call, "pi-gui:open-extension-view")?;
            let input = validation::expect_record(call.arg(0), "extension view request")?;
            let target = validation::expect_session_target(input.get("target"), "target")?;
            let extension_id =
                validation::expect_non_empty_string(input.get("extensionId"), "extensionId")?;
            let view_id = validation::expect_non_empty_string(input.get("viewId"), "viewId")?;
            if kernel.windows.target_for_window(&kernel, window).as_ref() != Some(&target) {
                return Err(CoreError::new(
                    "Open extension views from their selected task",
                ));
            }
            open_connection(&kernel, window, target, extension_id, view_id).await
        })
    });
    table.on("sendExtensionViewMessage", |kernel, call| {
        Box::pin(async move {
            let window =
                dispatch::main_frame(&kernel, &call, "pi-gui:send-extension-view-message")?;
            let input = validation::expect_record(call.arg(0), "extension view request")?;
            let connection_id =
                validation::expect_non_empty_string(input.get("connectionId"), "connectionId")?;
            let message =
                validation::expect_record(input.get("message"), "extension view message")?;
            send_message(&kernel, window, connection_id, message.clone()).await?;
            Ok(Reply::Undefined)
        })
    });
    table.on("closeExtensionView", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::main_frame(&kernel, &call, "pi-gui:close-extension-view")?;
            let connection_id = validation::expect_non_empty_string(call.arg(0), "connectionId")?;
            close_connection(&kernel, window, &connection_id)?;
            Ok(Reply::Undefined)
        })
    });
}

/// `openConnection`: the host opens the backend connection; its messages reach `window`.
async fn open_connection(
    kernel: &Rc<Kernel>,
    window: WindowId,
    target: SessionRef,
    extension_id: String,
    view_id: String,
) -> CoreResult<Reply> {
    let client_token = kernel.env().random_uuid();
    kernel.data.borrow_mut().extensions.views.senders.insert(
        client_token.clone(),
        FrameSender {
            window,
            connection_id: String::new(),
        },
    );
    let opened = kernel
        .driver()
        .views(
            "views.open",
            json!({
                "target": target,
                "extensionId": extension_id,
                "viewId": view_id,
                "senderId": window,
                "clientToken": client_token,
            }),
        )
        .await;
    let mut data = kernel.data.borrow_mut();
    let views = &mut data.extensions.views;
    let opened = match opened {
        Ok(opened) => opened,
        Err(error) => {
            views.senders.remove(&client_token);
            return Err(error);
        }
    };
    // The host closed it before its reply arrived, for example because pi reloaded.
    let Some(sender) = views.senders.get_mut(&client_token) else {
        return Err(CoreError::new("Desktop extension view is unavailable"));
    };
    let context = opened["connection"].clone();
    let connection_id = context["connectionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    sender.connection_id = connection_id.clone();
    let target = serde_json::from_value(context["target"].clone()).unwrap_or(target);
    views.connections.insert(
        connection_id.clone(),
        OpenConnection {
            sender: window,
            target,
            client_token,
        },
    );
    let frame_url = opened["frameUrl"].as_str().unwrap_or_default().to_owned();
    drop(data);
    let frame_url = kernel.shell().extension_frame_url(frame_url);
    Ok(Reply::Value(
        json!({ "connectionId": connection_id, "frameUrl": frame_url }),
    ))
}

/// `getConnectionContext`: fails unless the connection is open and belongs to `window`.
fn connection_target(
    kernel: &Kernel,
    connection_id: &str,
    window: WindowId,
) -> CoreResult<SessionRef> {
    let data = kernel.data.borrow();
    let Some(connection) = data.extensions.views.connections.get(connection_id) else {
        return Err(CoreError::new("Desktop view connection is unavailable"));
    };
    if connection.sender != window {
        return Err(CoreError::new(
            "Desktop view connection belongs to another window",
        ));
    }
    Ok(connection.target.clone())
}

/// A frame's message: host actions run here, anything else goes to the host's backend.
async fn send_message(
    kernel: &Rc<Kernel>,
    window: WindowId,
    connection_id: String,
    message: Map<String, Value>,
) -> CoreResult<()> {
    if message.get("type").and_then(Value::as_str) != Some("host-action") {
        kernel
            .driver()
            .views(
                "views.receive",
                json!({ "connectionId": connection_id, "senderId": window, "message": message }),
            )
            .await?;
        return Ok(());
    }
    let request_id = validation::expect_non_empty_string(message.get("requestId"), "requestId")?;
    if crate::js::length(&request_id) > 200 {
        return Err(CoreError::new("Invalid host action request ID"));
    }
    // Checked before any result goes back to this window.
    connection_target(kernel, &connection_id, window)?;
    let refused = {
        let mut data = kernel.data.borrow_mut();
        let pending = data
            .extensions
            .views
            .pending_actions
            .entry(connection_id.clone())
            .or_default();
        let refused = pending.contains(&request_id) || pending.len() >= MAX_PENDING_HOST_ACTIONS;
        if !refused {
            pending.insert(request_id.clone());
        }
        refused
    };
    if refused {
        send_view_message(
            kernel,
            window,
            &connection_id,
            json!({
                "type": "host-action-result",
                "requestId": request_id,
                "ok": false,
                "error": "Too many pending desktop actions. Wait for the current actions to finish.",
            }),
        );
        return Ok(());
    }
    let outcome = async {
        let action = parse_desktop_host_action(message.get("action"))?;
        let target = connection_target(kernel, &connection_id, window)?;
        perform_host_action(kernel, window, &connection_id, &target, &action).await
    }
    .await;
    let result = match outcome {
        Ok(()) => json!({ "type": "host-action-result", "requestId": request_id, "ok": true }),
        Err(error) => json!({
            "type": "host-action-result",
            "requestId": request_id,
            "ok": false,
            "error": error.message,
        }),
    };
    {
        let mut data = kernel.data.borrow_mut();
        let pending_actions = &mut data.extensions.views.pending_actions;
        if let Some(pending) = pending_actions.get_mut(&connection_id) {
            pending.remove(&request_id);
            if pending.is_empty() {
                pending_actions.remove(&connection_id);
            }
        }
    }
    send_view_message(kernel, window, &connection_id, result);
    Ok(())
}

fn send_view_message(kernel: &Kernel, window: WindowId, connection_id: &str, message: Value) {
    publish::send_to(
        kernel,
        window,
        push::EXTENSION_VIEW_MESSAGE,
        &json!({ "connectionId": connection_id, "message": message }),
    );
}

/// `closeConnection`.
fn close_connection(kernel: &Kernel, window: WindowId, connection_id: &str) -> CoreResult<()> {
    if !kernel
        .data
        .borrow()
        .extensions
        .views
        .connections
        .contains_key(connection_id)
    {
        return Ok(());
    }
    connection_target(kernel, connection_id, window)?;
    kernel
        .data
        .borrow_mut()
        .extensions
        .views
        .connections
        .remove(connection_id);
    let request = kernel.driver().views(
        "views.close",
        json!({ "connectionId": connection_id, "senderId": window }),
    );
    tokio::task::spawn_local(async move {
        let _ = request.await;
    });
    Ok(())
}

/// `closeSender`: the window closed or its page went away, so its frames did too.
pub fn close_sender(kernel: &Kernel, window: WindowId) {
    kernel
        .data
        .borrow_mut()
        .extensions
        .views
        .connections
        .retain(|_, connection| connection.sender != window);
    let request = kernel
        .driver()
        .views("views.closeSender", json!({ "senderId": window }));
    tokio::task::spawn_local(async move {
        let _ = request.await;
    });
}

/// The host's `views.changed` and `views.message` notifications.
pub fn on_host_notification(kernel: &Kernel, method: &str, params: Value) {
    match method {
        "views.changed" => publish::broadcast(
            kernel,
            push::EXTENSION_VIEW_CATALOG_CHANGED,
            &json!({ "target": params["target"], "views": params["views"] }),
        ),
        "views.message" => {
            let client_token = params["clientToken"].as_str().unwrap_or_default();
            let message = params.get("message").cloned().unwrap_or(Value::Null);
            let closed = message.get("type").and_then(Value::as_str) == Some("closed");
            let destination = {
                let mut data = kernel.data.borrow_mut();
                let views = &mut data.extensions.views;
                let destination = views
                    .senders
                    .get(client_token)
                    .map(|sender| (sender.window, sender.connection_id.clone()));
                if closed {
                    views.senders.remove(client_token);
                    views
                        .connections
                        .retain(|_, connection| connection.client_token != client_token);
                }
                destination
            };
            // Until the open answers, the frame's id is not known yet, as in main.
            if let Some((window, connection_id)) = destination {
                send_view_message(kernel, window, &connection_id, message);
            }
        }
        _ => {}
    }
}

// ---- Host actions (`extension-view-actions.ts`) ----

fn host_action_error(message: &str) -> CoreError {
    validation::type_error(message)
}

fn assert_keys(value: &Map<String, Value>, required: &[&str], optional: &[&str]) -> CoreResult<()> {
    let known = |key: &str| required.contains(&key) || optional.contains(&key);
    if required.iter().any(|key| !value.contains_key(*key)) || value.keys().any(|key| !known(key)) {
        return Err(host_action_error("Unexpected desktop host action fields"));
    }
    Ok(())
}

fn assert_path(value: Option<&Value>) -> CoreResult<String> {
    match value.and_then(Value::as_str) {
        Some(path)
            if !crate::js::trim(path).is_empty()
                && crate::js::length(path) <= 4096
                && !path.contains('\0') =>
        {
            Ok(path.to_owned())
        }
        _ => Err(host_action_error("Invalid file path")),
    }
}

/// A line or column: absent, or a positive safe integer.
fn assert_line(value: Option<&Value>) -> CoreResult<Option<u64>> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value.as_f64() {
        Some(line) if line.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&line) => {
            Ok(Some(line as u64))
        }
        _ => Err(host_action_error(
            "File line and column must be positive integers",
        )),
    }
}

/// `parseDesktopHostAction` (`@pi-gui/extension-ui/browser`).
pub fn parse_desktop_host_action(value: Arg) -> CoreResult<Value> {
    let Some(value) = value.and_then(Value::as_object) else {
        return Err(host_action_error("Invalid desktop host action"));
    };
    let mut action = Map::new();
    match value.get("type").and_then(Value::as_str) {
        Some("openFile") => {
            assert_keys(value, &["type", "path"], &["line", "column"])?;
            let path = assert_path(value.get("path"))?;
            let line = assert_line(value.get("line"))?;
            let column = assert_line(value.get("column"))?;
            action.insert("type".into(), json!("openFile"));
            action.insert("path".into(), json!(path));
            if let Some(line) = line {
                action.insert("line".into(), json!(line));
            }
            if let Some(column) = column {
                action.insert("column".into(), json!(column));
            }
        }
        Some("prepareTaskDraft") => {
            assert_keys(value, &["type", "title", "prompt"], &["files"])?;
            let title = value.get("title").and_then(Value::as_str);
            let Some(title) = title.filter(|title| {
                !crate::js::trim(title).is_empty() && crate::js::length(title) <= 240
            }) else {
                return Err(host_action_error(
                    "Task draft title must contain 1 to 240 characters",
                ));
            };
            let prompt = value.get("prompt").and_then(Value::as_str);
            let Some(prompt) = prompt.filter(|prompt| {
                !crate::js::trim(prompt).is_empty() && crate::js::length(prompt) <= 100_000
            }) else {
                return Err(host_action_error(
                    "Task draft prompt must contain 1 to 100000 characters",
                ));
            };
            action.insert("type".into(), json!("prepareTaskDraft"));
            action.insert("title".into(), json!(title));
            action.insert("prompt".into(), json!(prompt));
            if let Some(files) = value.get("files") {
                let Some(files) = files.as_array().filter(|files| files.len() <= 100) else {
                    return Err(host_action_error(
                        "Task draft files must be a list of at most 100 targets",
                    ));
                };
                let files = files
                    .iter()
                    .map(|file| {
                        let Some(file) = file.as_object() else {
                            return Err(host_action_error("Invalid task draft file"));
                        };
                        assert_keys(file, &["path"], &["line"])?;
                        let path = assert_path(file.get("path"))?;
                        Ok(match assert_line(file.get("line"))? {
                            Some(line) => json!({ "path": path, "line": line }),
                            None => json!({ "path": path }),
                        })
                    })
                    .collect::<CoreResult<Vec<_>>>()?;
                action.insert("files".into(), Value::Array(files));
            }
        }
        Some("openUrl") => {
            assert_keys(value, &["type", "url"], &[])?;
            // Opened only after `parseExtensionUrl` accepts it; this checks the shape.
            let url = value.get("url").and_then(Value::as_str);
            let Some(url) = url.filter(|url| !url.is_empty() && crate::js::length(url) <= 2048)
            else {
                return Err(host_action_error("Invalid link"));
            };
            action.insert("type".into(), json!("openUrl"));
            action.insert("url".into(), json!(url));
        }
        Some("openThread") => {
            assert_keys(value, &["type", "sessionId"], &[])?;
            let session_id = value.get("sessionId").and_then(Value::as_str);
            let Some(session_id) = session_id.filter(|id| actions::is_session_id(id)) else {
                return Err(host_action_error("Invalid thread id"));
            };
            action.insert("type".into(), json!("openThread"));
            action.insert("sessionId".into(), json!(session_id));
        }
        _ => return Err(host_action_error("Unknown desktop host action")),
    }
    Ok(Value::Object(action))
}

/// `requireCurrentTask`: the connection is still open and its window still shows its task.
fn require_current_task(
    kernel: &Kernel,
    window: WindowId,
    connection_id: &str,
    target: &SessionRef,
) -> CoreResult<()> {
    connection_target(kernel, connection_id, window)?;
    let view = kernel.windows.view_for_window(kernel, window);
    if view.active_view != AppView::Threads
        || view.selected_workspace_id != target.workspace_id
        || view.selected_session_id != target.session_id
    {
        return Err(CoreError::new(
            "Return to the extension's task to use this action",
        ));
    }
    Ok(())
}

/// `performExtensionViewHostAction`.
async fn perform_host_action(
    kernel: &Rc<Kernel>,
    window: WindowId,
    connection_id: &str,
    target: &SessionRef,
    action: &Value,
) -> CoreResult<()> {
    if kernel.shell().presence(window).is_none() {
        return Err(CoreError::new("The requesting window is closed"));
    }
    require_current_task(kernel, window, connection_id, target)?;
    match action["type"].as_str().unwrap_or_default() {
        "openUrl" => {
            let action = json!({ "type": "url", "url": action["url"] });
            actions::open_link(kernel, &action).await
        }
        "openThread" => {
            // Links and threads run through the same checked operations as card buttons.
            let session_id = action["sessionId"].as_str().unwrap_or_default().to_owned();
            actions::thread_in_folder(kernel, target, &session_id)?;
            // Selecting the thread closes this view, so the view's call settles once the
            // thread is found, and the switch starts after that result has gone out.
            let kernel = kernel.clone();
            let connection_id = connection_id.to_owned();
            let target = target.clone();
            tokio::task::spawn_local(async move {
                tokio::task::yield_now().await;
                // The switch drops the composer's debounced draft, so save it first.
                kernel.draft_flush.flush(&kernel, &[window]).await;
                let switched = dispatch::run_for(&kernel, window, || async {
                    if require_current_task(&kernel, window, &connection_id, &target).is_err() {
                        // The user already left the view's task; there is nothing to switch
                        // from.
                        return Ok(sessions::snapshot(&kernel));
                    }
                    let selected = match actions::thread_in_folder(&kernel, &target, &session_id) {
                        Ok(thread) => workspace::select_session(&kernel, &thread).await,
                        Err(error) => Err(error),
                    };
                    match selected {
                        Ok(state) => Ok(state),
                        // The thread went away meanwhile: say so in the app, since the view
                        // is told ok.
                        Err(error) => sessions::with_core_error(&kernel, error).await,
                    }
                })
                .await;
                if let Err(error) = switched {
                    eprintln!("[extension-view] open thread failed {}", error.message);
                }
            });
            Ok(())
        }
        "openFile" => {
            let path = actions::existing_workspace_file(
                kernel,
                target,
                action["path"].as_str().unwrap_or_default(),
                "The task checkout is unavailable",
                |_| "The selected path is not a file".to_owned(),
            )
            .await?;
            require_current_task(kernel, window, connection_id, target)?;
            let mut open = json!({ "target": target, "path": path });
            for key in ["line", "column"] {
                if let Some(value) = action.get(key) {
                    open[key] = value.clone();
                }
            }
            publish::send_to(kernel, window, push::EXTENSION_VIEW_OPEN_FILE, &open);
            Ok(())
        }
        _ => prepare_task_draft(kernel, window, connection_id, target, action).await,
    }
}

/// A new thread in the view's folder with the extension's prompt in its composer.
async fn prepare_task_draft(
    kernel: &Rc<Kernel>,
    window: WindowId,
    connection_id: &str,
    target: &SessionRef,
    action: &Value,
) -> CoreResult<()> {
    if workspace::workspace_path(kernel, &target.workspace_id).is_none() {
        return Err(CoreError::new("The task checkout is unavailable"));
    }
    let mut files = Vec::new();
    for file in action["files"].as_array().into_iter().flatten() {
        let path = actions::existing_workspace_file(
            kernel,
            target,
            file["path"].as_str().unwrap_or_default(),
            "The task checkout is unavailable",
            |_| "The selected path is not a file".to_owned(),
        )
        .await?;
        files.push((path, file["line"].as_u64()));
    }
    require_current_task(kernel, window, connection_id, target)?;
    let title = action["title"].clone();
    let prompt = action["prompt"].as_str().unwrap_or_default();
    let context_text = if files.is_empty() {
        String::new()
    } else {
        let lines: Vec<String> = files
            .iter()
            .map(|(path, line)| match line {
                Some(line) => format!("- {path}:{line}"),
                None => format!("- {path}"),
            })
            .collect();
        format!("\n\nFiles:\n{}", lines.join("\n"))
    };
    let draft = format!("{prompt}{context_text}");
    dispatch::run_for(kernel, window, || async {
        // The window's action queue may have advanced while this action was waiting.
        require_current_task(kernel, window, connection_id, target)?;
        let state = workspace::create_session(
            kernel,
            &json!({ "workspaceId": target.workspace_id, "title": title }),
        )
        .await?;
        if let Some(error) = state.last_error {
            return Err(CoreError::new(error));
        }
        let draft_target = crate::state::driver::session_ref(
            &state.selected_workspace_id,
            &state.selected_session_id,
        );
        conversation::update_composer_draft(kernel, Some(&draft_target), &draft).await
    })
    .await?;
    Ok(())
}

/// The state a queued action answered with.
pub fn reply_state(reply: Reply) -> Option<DesktopAppState> {
    match reply {
        Reply::State(state) => Some(*state),
        _ => None,
    }
}
