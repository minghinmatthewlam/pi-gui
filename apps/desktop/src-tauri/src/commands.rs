//! The renderer's only commands. `window.piApp` (`src/platform/tauri-pi-app.ts`) is built on
//! them with the test host's contract: calls by API name answered with raw JSON, and one
//! channel per window for pushes.

use crate::kernel::{KernelHandle, KernelMsg};
use crate::shell::window_id;
use crate::windows::DroppedPaths;
use pi_gui_core::app::WindowId;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{State, Webview};
use tokio::sync::oneshot;

fn sender(webview: &Webview) -> Result<WindowId, String> {
    window_id(webview.label()).ok_or_else(|| format!("Not an app window: {}", webview.label()))
}

/// Node's `process.platform` name for this OS.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// `args` with `undefined` restored where the renderer passed it.
fn decode_args(args: Vec<Value>, undefined_at: &[usize]) -> Vec<Option<Value>> {
    let mut args: Vec<Option<Value>> = args.into_iter().map(Some).collect();
    for &index in undefined_at {
        if args.len() <= index {
            args.resize(index + 1, None);
        }
        args[index] = None;
    }
    args
}

/// What the preload knows before the page runs: the platform and versions.
#[tauri::command]
pub fn pi_bootstrap(webview: Webview) -> Result<Value, String> {
    let window = sender(&webview)?;
    Ok(json!({
        "window": window,
        "platform": node_platform(),
        "versions": { "tauri": tauri::VERSION, "pi-gui": env!("CARGO_PKG_VERSION") },
    }))
}

/// The page's push channel; a reloaded page sends a new one.
#[tauri::command]
pub fn pi_connect(
    webview: Webview,
    handle: State<'_, KernelHandle>,
    channel: Channel,
) -> Result<(), String> {
    handle.connect(sender(&webview)?, channel);
    Ok(())
}

/// One renderer call. The answer is `{"result":…}`, `{}` for `undefined`, or
/// `{"channel":…,"error":…}`; a `send` answers at once and drops the kernel's answer.
#[tauri::command]
pub async fn pi_invoke(
    webview: Webview,
    handle: State<'_, KernelHandle>,
    method: String,
    args: Vec<Value>,
    undefined_at: Option<Vec<usize>>,
    send: Option<bool>,
) -> Result<Response, String> {
    let window = sender(&webview)?;
    let args = decode_args(args, undefined_at.as_deref().unwrap_or_default());
    if send == Some(true) {
        handle.send(KernelMsg::Invoke {
            window,
            method,
            args,
            reply: None,
        });
        return Ok(Response::new(InvokeResponseBody::Json("{}".into())));
    }
    let (reply, answer) = oneshot::channel();
    handle.send(KernelMsg::Invoke {
        window,
        method,
        args,
        reply: Some(reply),
    });
    let answer = answer
        .await
        .map_err(|_| "The app is shutting down".to_owned())?;
    Ok(Response::new(InvokeResponseBody::Json(answer)))
}

/// What Electron main does for its own shortcuts: `newWindow` and `openFolder`.
#[tauri::command]
pub fn pi_window_command(
    webview: Webview,
    handle: State<'_, KernelHandle>,
    command: String,
) -> Result<(), String> {
    let window = sender(&webview)?;
    match command.as_str() {
        "newWindow" => handle.send(KernelMsg::NewWindow {
            source: Some(window),
        }),
        "openFolder" => handle.send(KernelMsg::OpenFolder(window)),
        other => return Err(format!("Unknown window command: {other}")),
    }
    Ok(())
}

/// A file this window was just given by a drop: its size, or its bytes with `contents`.
/// Nothing else on disk can be read this way.
#[tauri::command]
pub fn pi_dropped_file(
    webview: Webview,
    dropped: State<'_, DroppedPaths>,
    path: String,
    contents: bool,
) -> Result<Response, String> {
    let window = sender(&webview)?;
    let path = PathBuf::from(path);
    if !dropped.contains(window, &path) {
        return Err(format!("Not a dropped file: {}", path.display()));
    }
    if contents {
        let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
        return Ok(Response::new(InvokeResponseBody::Raw(bytes)));
    }
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    Ok(Response::new(InvokeResponseBody::Json(
        json!({ "size": metadata.len(), "isFile": metadata.is_file() }).to_string(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_arguments_come_back_as_none() {
        let args = vec![json!("a"), Value::Null, Value::Null];
        assert_eq!(
            decode_args(args, &[1, 3]),
            vec![Some(json!("a")), None, Some(Value::Null), None]
        );
    }
}
