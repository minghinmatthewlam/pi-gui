//! The integrated terminal as the windows see it (`registerTerminalIpc`, main's
//! `TerminalService` and its store subscription). Shells run in the core's `terminal.*`
//! calls; each call names the window that owns the shell, and the core's output, exit and
//! error notifications go to that window only. Shells of folders no longer open are hung up
//! after an emit, and a closed window's shells with it.

use super::super::dispatch::{self, InvokeCall, MethodTable, Reply};
use super::super::methods::push;
use super::super::validation;
use super::super::{publish, Kernel, WindowId};
use super::workspace_path;
use crate::error::CoreResult;
use crate::methods;
use crate::state::desktop_state::DesktopAppState;
use serde_json::{json, Value};
use std::collections::HashSet;

/// Which windows have the terminal or a side panel focused, for the shell's key handling.
#[derive(Default)]
pub struct TerminalState {
    /// Whether a terminal call has started the terminal service; until then writes, resizes
    /// and titles do nothing, as main's optional service did.
    started: bool,
    pub terminal_focused: HashSet<WindowId>,
    pub side_panel_focused: HashSet<WindowId>,
    /// The open folders' paths the shells were last trimmed to, joined.
    retained_signature: String,
}

pub fn register(table: &mut MethodTable) {
    table.on("ensureTerminalPanel", |kernel, call| {
        Box::pin(async move { panel_call(&kernel, &call, methods::TERMINAL_ENSURE_PANEL).await })
    });
    table.on("createTerminalSession", |kernel, call| {
        Box::pin(async move { panel_call(&kernel, &call, methods::TERMINAL_CREATE_SESSION).await })
    });
    table.on("setActiveTerminalSession", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let params = json!({
                "ownerId": window,
                "workspaceId": validation::expect_non_empty_string(call.arg(0), "workspaceId")?,
                "terminalScopeId":
                    validation::expect_non_empty_string(call.arg(1), "terminalScopeId")?,
                "terminalId": validation::expect_non_empty_string(call.arg(2), "terminalId")?,
            });
            terminal_call(&kernel, methods::TERMINAL_SET_ACTIVE_SESSION, params).await
        })
    });
    table.on("writeTerminal", |kernel, call| {
        Box::pin(async move {
            if !started(&kernel) {
                return Ok(Reply::Undefined);
            }
            let window = dispatch::sender(&kernel, &call)?;
            let params = json!({
                "ownerId": window,
                "terminalId": validation::expect_non_empty_string(call.arg(0), "terminalId")?,
                "data": validation::expect_string(call.arg(1), "data")?,
            });
            terminal_call(&kernel, methods::TERMINAL_WRITE, params).await?;
            Ok(Reply::Undefined)
        })
    });
    table.on("resizeTerminal", |kernel, call| {
        Box::pin(async move {
            if !started(&kernel) {
                return Ok(Reply::Undefined);
            }
            let window = dispatch::sender(&kernel, &call)?;
            let params = json!({
                "ownerId": window,
                "terminalId": validation::expect_non_empty_string(call.arg(0), "terminalId")?,
                "size": validation::expect_terminal_size(call.arg(1), "size")?,
            });
            terminal_call(&kernel, methods::TERMINAL_RESIZE, params).await?;
            Ok(Reply::Undefined)
        })
    });
    table.on("restartTerminalSession", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let params = json!({
                "ownerId": window,
                "terminalId": validation::expect_non_empty_string(call.arg(0), "terminalId")?,
                "size": validation::expect_terminal_size(call.arg(1), "size")?,
                "shell": shell_setting(&kernel),
            });
            terminal_call(&kernel, methods::TERMINAL_RESTART, params).await
        })
    });
    table.on("closeTerminalSession", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let params = json!({
                "ownerId": window,
                "terminalId": validation::expect_non_empty_string(call.arg(0), "terminalId")?,
            });
            terminal_call(&kernel, methods::TERMINAL_CLOSE, params).await
        })
    });
    table.on("setTerminalTitle", |kernel, call| {
        Box::pin(async move {
            if !started(&kernel) {
                return Ok(Reply::Undefined);
            }
            let window = dispatch::sender(&kernel, &call)?;
            let params = json!({
                "ownerId": window,
                "terminalId": validation::expect_non_empty_string(call.arg(0), "terminalId")?,
                "title": validation::expect_string(call.arg(1), "title")?,
            });
            terminal_call(&kernel, methods::TERMINAL_SET_TITLE, params).await?;
            Ok(Reply::Undefined)
        })
    });
    table.on("setTerminalFocused", |kernel, call| {
        Box::pin(async move {
            set_focused(&kernel, &call, |state| &mut state.terminal_focused)?;
            Ok(Reply::Undefined)
        })
    });
    table.on("setSidePanelFocused", |kernel, call| {
        Box::pin(async move {
            set_focused(&kernel, &call, |state| &mut state.side_panel_focused)?;
            Ok(Reply::Undefined)
        })
    });
}

fn started(kernel: &Kernel) -> bool {
    kernel.data.borrow().workspace.terminal.started
}

/// The integrated terminal shell setting; empty uses the platform's.
fn shell_setting(kernel: &Kernel) -> String {
    kernel.data.borrow().state.integrated_terminal_shell.clone()
}

/// `ensurePanel` and `createSession`: the folder's terminal panel for one thread scope.
async fn panel_call(kernel: &Kernel, call: &InvokeCall, method: &str) -> CoreResult<Reply> {
    let window = dispatch::sender(kernel, call)?;
    let workspace_id = validation::expect_non_empty_string(call.arg(0), "workspaceId")?;
    let params = json!({
        "ownerId": window,
        "workspacePath": workspace_path(kernel, &workspace_id),
        "workspaceId": workspace_id,
        "terminalScopeId": validation::expect_non_empty_string(call.arg(1), "terminalScopeId")?,
        "size": validation::expect_terminal_size(call.arg(2), "size")?,
        "shell": shell_setting(kernel),
    });
    terminal_call(kernel, method, params).await
}

async fn terminal_call(kernel: &Kernel, method: &str, params: Value) -> CoreResult<Reply> {
    kernel.data.borrow_mut().workspace.terminal.started = true;
    Ok(Reply::Value(kernel.core_call(method, params).await?))
}

fn set_focused(
    kernel: &Kernel,
    call: &InvokeCall,
    set: fn(&mut TerminalState) -> &mut HashSet<WindowId>,
) -> CoreResult<()> {
    let window = dispatch::sender(kernel, call)?;
    let focused = validation::expect_boolean(call.arg(0), "focused")?;
    let mut data = kernel.data.borrow_mut();
    let windows = set(&mut data.workspace.terminal);
    if focused {
        windows.insert(window);
    } else {
        windows.remove(&window);
    }
    Ok(())
}

/// The core's terminal notifications, each for the window that owns the shell.
pub fn relay(kernel: &Kernel, method: &str, mut params: Value) {
    use crate::terminal::notifications;
    let channel = match method {
        notifications::DATA => push::TERMINAL_DATA,
        notifications::EXIT => push::TERMINAL_EXIT,
        notifications::ERROR => push::TERMINAL_ERROR,
        _ => {
            eprintln!("[pi-gui-core] no handler for notification {method}");
            return;
        }
    };
    let Some(owner) = params
        .as_object_mut()
        .and_then(|params| params.remove("ownerId"))
        .and_then(|owner| owner.as_u64())
        .and_then(|owner| WindowId::try_from(owner).ok())
    else {
        return;
    };
    if kernel.windows.contains(owner) {
        publish::send_to(kernel, owner, channel, &params);
    }
}

/// A closed window's shells hang up; the last window takes every shell with it.
pub fn on_window_closed(kernel: &Kernel, window: WindowId) {
    {
        let mut data = kernel.data.borrow_mut();
        let terminal = &mut data.workspace.terminal;
        terminal.terminal_focused.remove(&window);
        terminal.side_panel_focused.remove(&window);
        if !terminal.started {
            return;
        }
    }
    background(
        kernel,
        methods::TERMINAL_DISPOSE_OWNER,
        json!({ "ownerId": window }),
    );
    if kernel.windows.ids().is_empty() {
        background(kernel, methods::TERMINAL_DISPOSE_ALL, json!({}));
    }
}

/// After every emit: shells of folders that are no longer open hang up.
pub fn after_emit(kernel: &Kernel, state: &DesktopAppState) {
    let paths: Vec<&str> = state
        .workspaces
        .iter()
        .map(|workspace| workspace.path.as_str())
        .collect();
    let signature = paths.join("\0");
    {
        let mut data = kernel.data.borrow_mut();
        let terminal = &mut data.workspace.terminal;
        if terminal.retained_signature == signature {
            return;
        }
        terminal.retained_signature = signature;
        if !terminal.started {
            return;
        }
    }
    background(
        kernel,
        methods::TERMINAL_RETAIN_WORKSPACE_PATHS,
        json!({ "workspacePaths": paths }),
    );
}

/// Cleanup nobody waits for.
fn background(kernel: &Kernel, method: &'static str, params: Value) {
    let kernel = kernel.rc();
    tokio::task::spawn_local(async move {
        if let Err(error) = kernel.core_call(method, params).await {
            eprintln!("[terminal] {method} failed: {}", error.message);
        }
    });
}
