//! One WebSocket connection: a renderer window, or a spec's control client.
//!
//! The client speaks first with `{"hello":{"role":"window"|"control","window"?:n}}`. Calls are
//! `{"id"?:n,"method":"<api name>","args":[…],"undefinedAt"?:[…]}`, with no `id` for a send.
//! Answers are `{"id":n,"result"?:…}` (no `result` for `undefined`) or
//! `{"id":n,"channel":"…","error":{name,message,data}}`. Pushes are
//! `{"push":"<channel>","payload":…}`.
//!
//! A window that reloads reconnects with its old id inside a short grace period, and keeps
//! its view, as an Electron renderer reload does.

use crate::App;
use futures_util::{SinkExt, StreamExt};
use pi_gui_core::app::dispatch::{self, InvokeCall, Reply};
use pi_gui_core::app::methods::{self, push};
use pi_gui_core::app::pi::InterceptOutcome;
use pi_gui_core::app::publish::ViewState;
use pi_gui_core::app::settings::login::prompt_for_text;
use pi_gui_core::app::shell::{Push, Shell};
use pi_gui_core::app::test_hooks::{ControlMode, ControlOptions};
use pi_gui_core::app::{events, notifications, publish, scheduled, ui, WindowId};
use pi_gui_core::error::{CoreError, CoreResult};
use pi_gui_core::state::driver::{session_key, SessionDriverEvent, SessionRef};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// How long a closed window waits for its page to reconnect before it is gone.
const RELOAD_GRACE: Duration = Duration::from_millis(1_500);

type Out = mpsc::UnboundedSender<String>;

#[derive(Default)]
pub struct Windows {
    next: Cell<WindowId>,
    /// Where each window's pushes go; replaced when a reloaded page reconnects.
    senders: Rc<RefCell<HashMap<WindowId, Out>>>,
    /// Windows whose page closed, waiting out the grace period.
    detached: RefCell<HashMap<WindowId, AbortHandle>>,
    /// The view the next new window starts on, as main's `createAppWindow(sourceView)`.
    source_view: RefCell<Option<ViewState>>,
}

fn push_message(push: &Push) -> String {
    format!(
        "{{\"push\":{},\"payload\":{}}}",
        Value::String(push.channel().to_owned()),
        push.json()
    )
}

pub async fn run(app: Rc<App>, socket: WebSocketStream<TcpStream>) {
    let (mut sink, mut stream) = socket.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
    let writer = tokio::task::spawn_local(async move {
        while let Some(text) = outgoing.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let hello = loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => break serde_json::from_str::<Value>(&text).ok(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => {
                writer.abort();
                return;
            }
        }
    };
    let hello = hello
        .as_ref()
        .and_then(|value| value.get("hello"))
        .cloned()
        .unwrap_or(Value::Null);
    let window = if hello["role"] == "control" {
        None
    } else {
        Some(attach_window(&app, &out, hello["window"].as_u64()))
    };
    let _ = out.send(
        json!({
            "hello": {
                "window": window,
                "platform": std::env::consts::OS,
                "versions": { "testhost": env!("CARGO_PKG_VERSION") },
            }
        })
        .to_string(),
    );

    while let Some(message) = stream.next().await {
        let text = match message {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let Ok(request) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let app = app.clone();
        let out = out.clone();
        tokio::task::spawn_local(async move { answer(app, out, window, request).await });
    }
    if let Some(window) = window {
        detach_window(&app, window);
    }
    drop(out);
    let _ = writer.await;
}

/// A new window, or a reloaded page taking its window back.
fn attach_window(app: &Rc<App>, out: &Out, requested: Option<u64>) -> WindowId {
    let reclaimed = requested
        .and_then(|id| WindowId::try_from(id).ok())
        .filter(|id| {
            app.windows
                .detached
                .borrow_mut()
                .remove(id)
                .map(|timer| timer.abort())
                .is_some()
        });
    if let Some(window) = reclaimed {
        app.windows.senders.borrow_mut().insert(window, out.clone());
        app.kernel.windows.renderer_reset(&app.kernel, window);
        return window;
    }
    let window = app.windows.next.get() + 1;
    app.windows.next.set(window);
    app.windows.senders.borrow_mut().insert(window, out.clone());
    let senders = app.windows.senders.clone();
    app.shell.add_window(
        window,
        Box::new(move |push| {
            if let Some(out) = senders.borrow().get(&window) {
                let _ = out.send(push_message(push));
            }
        }),
    );
    let source_view = app.windows.source_view.borrow_mut().take();
    app.kernel.windows.add(&app.kernel, window, source_view);
    if app.shell.focused_window() == Some(window) {
        focus(app, window);
    }
    window
}

fn detach_window(app: &Rc<App>, window: WindowId) {
    if app.windows.senders.borrow_mut().remove(&window).is_none() {
        // Closed through `test.closeWindow`, already gone.
        return;
    }
    app.kernel.windows.renderer_gone(window);
    let weak = Rc::downgrade(app);
    let timer = tokio::task::spawn_local(async move {
        tokio::time::sleep(RELOAD_GRACE).await;
        let Some(app) = weak.upgrade() else {
            return;
        };
        app.windows.detached.borrow_mut().remove(&window);
        app.shell.remove_window(window);
        app.kernel.windows.closed(&app.kernel, window);
    });
    app.windows
        .detached
        .borrow_mut()
        .insert(window, timer.abort_handle());
}

/// What focusing a window does in Electron: the window becomes active and its page hears.
fn focus(app: &App, window: WindowId) {
    app.shell.focus(window);
    app.kernel.windows.activate(&app.kernel, window);
    publish::send_to(&app.kernel, window, push::WINDOW_FOCUSED, &Value::Null);
}

fn decode_args(request: &Value) -> Vec<Option<Value>> {
    let mut args: Vec<Option<Value>> = request["args"]
        .as_array()
        .map(|args| args.iter().cloned().map(Some).collect())
        .unwrap_or_default();
    for index in request["undefinedAt"].as_array().into_iter().flatten() {
        let Some(index) = index.as_u64().map(|index| index as usize) else {
            continue;
        };
        if args.len() <= index {
            args.resize(index + 1, None);
        }
        args[index] = None;
    }
    args
}

async fn answer(app: Rc<App>, out: Out, window: Option<WindowId>, request: Value) {
    let id = request.get("id").cloned();
    let method = request["method"].as_str().unwrap_or_default().to_owned();
    let result = if let Some(name) = method.strip_prefix("test.") {
        test_call(
            &app,
            name,
            request["args"].get(0).cloned().unwrap_or(Value::Null),
        )
        .await
    } else {
        match window {
            Some(window) => {
                let call = InvokeCall {
                    window,
                    main_frame: true,
                    args: decode_args(&request),
                };
                dispatch::invoke(&app.kernel, &method, call).await
            }
            None => Err(CoreError::new("Only a window can call renderer methods")),
        }
    };
    let Some(id) = id else {
        if let Err(error) = result {
            eprintln!("[pi-gui-testhost] {method} failed: {}", error.message);
        }
        return;
    };
    let text = match result {
        Ok(reply) => match reply.to_json() {
            Some(json) => format!("{{\"id\":{id},\"result\":{json}}}"),
            None => format!("{{\"id\":{id}}}"),
        },
        Err(error) => {
            let channel = methods::by_api(&method)
                .map(|method| method.channel)
                .unwrap_or(method.as_str());
            json!({ "id": id, "channel": channel, "error": error }).to_string()
        }
    };
    let _ = out.send(text);
}

fn text_param(params: &Value, name: &str) -> CoreResult<String> {
    params[name]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| CoreError::new(format!("test call needs {name}")))
}

fn window_param(params: &Value) -> CoreResult<WindowId> {
    params["window"]
        .as_u64()
        .and_then(|window| WindowId::try_from(window).ok())
        .ok_or_else(|| CoreError::new("test call needs window"))
}

/// A title-bar close, as Electron main handles it: the close waits for the renderer's debounced
/// draft, then the window goes, and on Linux and Windows (and in test mode on macOS) closing
/// the last window quits. While quit is flushing drafts, quit closes the window itself.
async fn close_window(app: &Rc<App>, window: WindowId) {
    if app.quitting.get() || !app.windows.senders.borrow().contains_key(&window) {
        return;
    }
    app.kernel.draft_flush.flush(&app.kernel, &[window]).await;
    if app.quitting.get() || app.windows.senders.borrow_mut().remove(&window).is_none() {
        return;
    }
    app.shell.remove_window(window);
    app.kernel.windows.remove(&app.kernel, window);
    if app.windows.senders.borrow().is_empty() && app.windows.detached.borrow().is_empty() {
        app.quit.notify_one();
    }
}

/// The hooks specs reach through `harness.electronApp.evaluate` under Electron.
async fn test_call(app: &Rc<App>, name: &str, params: Value) -> CoreResult<Reply> {
    if !app.test_mode {
        return Err(CoreError::new("Test hooks need PI_APP_TEST_MODE"));
    }
    let interceptor = || app.kernel.driver().interceptor();
    match name {
        "driver.intercept" => interceptor().intercept(&text_param(&params, "method")?),
        "driver.release" => interceptor().release(&text_param(&params, "method")?),
        "driver.pending" => return Ok(Reply::Value(interceptor().pending())),
        "driver.complete" => {
            let id = params["id"]
                .as_u64()
                .ok_or_else(|| CoreError::new("test call needs id"))?;
            let outcome =
                if params["passthrough"] == true {
                    InterceptOutcome::Passthrough
                } else if let Some(error) = params.get("error") {
                    InterceptOutcome::Error(serde_json::from_value(error.clone()).map_err(
                        |error| CoreError::new(format!("Invalid driver error: {error}")),
                    )?)
                } else {
                    InterceptOutcome::Result(params.get("result").cloned())
                };
            interceptor().complete(id, outcome)?;
        }
        "emitSessionEvent" => {
            let event: SessionDriverEvent = serde_json::from_value(params["event"].clone())
                .map_err(|error| CoreError::new(format!("Invalid session event: {error}")))?;
            app.kernel.initialize().await;
            let key = session_key(&event.session_ref);
            events::handle_session_event(&app.kernel, event, &key).await;
        }
        "invokeControl.install" => app.kernel.test.install(
            &text_param(&params, "channel")?,
            ControlOptions {
                mode: ControlMode::parse(&text_param(&params, "mode")?)?,
                sentinel: params["sentinel"].as_str().map(str::to_owned),
                replacement: params.get("replacement").cloned(),
                delay_ms: params["delayMs"].as_u64(),
                queue: params["queue"].as_str().map(str::to_owned),
            },
        )?,
        "invokeControl.release" => app.kernel.test.release(&text_param(&params, "channel")?)?,
        "invokeControl.settled" => {
            app.kernel
                .test
                .settled(&text_param(&params, "channel")?)
                .await?
        }
        "invokeTogether" => invoke_together(app, &params).await?,
        "invokeControl.set" => app.kernel.test.set(
            &text_param(&params, "channel")?,
            params["mode"]
                .as_str()
                .map(ControlMode::parse)
                .transpose()?,
            params.get("replacement").cloned(),
        )?,
        "invokeControl.read" => {
            return app
                .kernel
                .test
                .read(&text_param(&params, "channel")?)
                .map(Reply::Value)
        }
        "setSessionVisibility" => app
            .kernel
            .test
            .set_session_visibility(params["value"].as_str())?,
        "queueOpenDialog" => app
            .shell
            .queue_open_dialog(params["paths"].as_array().map(|paths| {
                paths
                    .iter()
                    .filter_map(Value::as_str)
                    .map(Into::into)
                    .collect()
            })),
        "beginTextPrompt" => return begin_text_prompt(app, &params).await,
        "textPromptOutcome" => {
            let id = params["outcome"]
                .as_u64()
                .ok_or_else(|| CoreError::new("test call needs outcome"))?;
            let outcome = app
                .text_prompts
                .borrow_mut()
                .remove(&id)
                .ok_or_else(|| CoreError::new(format!("No text prompt outcome {id}")))?;
            let outcome = outcome
                .await
                .map_err(|error| CoreError::new(error.to_string()))?;
            return Ok(Reply::Value(match outcome {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(error) => json!({ "ok": false, "error": error.message }),
            }));
        }
        "answerPrompt" => {
            let id = params["id"]
                .as_u64()
                .ok_or_else(|| CoreError::new("test call needs id"))?;
            app.shell
                .answer_prompt(id, params["value"].as_str().map(str::to_owned))?;
        }
        "windowState" => return Ok(Reply::Value(window_state(app, &params))),
        "shellLog" => return Ok(Reply::Value(Value::Array(app.shell.take_log()))),
        "windows" => return Ok(dispatch::value(app.kernel.windows.ids())),
        "focusWindow" => focus(app, window_param(&params)?),
        "decodeImage" => {
            // What Electron's nativeImage reports; the host reads PNG and JPEG headers only.
            let size = pi_gui_core::app::conversation::attachments::image_size(&text_param(
                &params, "data",
            )?);
            let (width, height) = size.unwrap_or((0, 0));
            return Ok(Reply::Value(
                json!({ "empty": size.is_none(), "width": width, "height": height }),
            ));
        }
        "closeWindow" => close_window(app, window_param(&params)?).await,
        "showWindow" => {
            let window = window_param(&params)?;
            app.shell.show(window);
            focus(app, window);
        }
        "minimizeWindow" => app.shell.minimize(window_param(&params)?),
        // Main's `second-instance`: the foreground window is restored, shown and focused.
        "secondInstance" => {
            if let Some(window) = app.kernel.windows.foreground(&app.kernel) {
                app.shell.show_window(window);
                focus(app, window);
            }
        }
        // A key main sees before the page: Shift+Mod+N opens a window on the sender's view
        // (the page the spec opens next); any other key goes on to the page.
        "keyboard" => {
            let window = window_param(&params)?;
            let modifiers: Vec<&str> = params["modifiers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let platform_modifier = if cfg!(target_os = "macos") {
                "meta"
            } else {
                "control"
            };
            let key = text_param(&params, "keyCode")?.to_lowercase();
            if modifiers.contains(&platform_modifier) && modifiers.contains(&"shift") && key == "n"
            {
                let view = app.kernel.windows.view_for_window(&app.kernel, window);
                *app.windows.source_view.borrow_mut() = Some(view);
                return Ok(Reply::Value(json!({ "route": "newWindow" })));
            }
            return Ok(Reply::Value(json!({ "route": "page" })));
        }
        "holdOpenDialog" => app.shell.hold_open_dialog(
            params["paths"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(Into::into)
                .collect(),
        ),
        "releaseOpenDialog" => app.shell.release_held_open_dialog()?,
        "fireDueScheduledTasks" => {
            app.kernel.initialize().await;
            let now = match params["nowIso"].as_str() {
                Some(iso) => app.kernel.env().date_parse(iso),
                None => app.kernel.env().now_ms(),
            };
            return scheduled::fire_due_scheduled_tasks(&app.kernel, now)
                .await
                .map(Reply::from);
        }
        // A pi-gui tool body, called as the pi host calls it from a tool running in the thread.
        "tool" => {
            app.kernel.initialize().await;
            let session_ref: SessionRef = serde_json::from_value(params["sessionRef"].clone())
                .map_err(|error| CoreError::new(format!("Invalid sessionRef: {error}")))?;
            let cwd = app
                .kernel
                .data
                .borrow()
                .workspace_ref(&session_ref.workspace_id)
                .map(|workspace| workspace.path)
                .ok_or_else(|| CoreError::new("Workspace not found"))?;
            let mut call = json!({
                "tool": text_param(&params, "tool")?,
                "caller": { "cwd": cwd, "sessionId": session_ref.session_id },
            });
            if let Some(input) = params.get("input") {
                call["input"] = input.clone();
            }
            let result = app
                .kernel
                .host_calls()
                .call("app.tool".into(), call)
                .await?;
            return Ok(Reply::Value(result));
        }
        // A click on the thread's desktop notification.
        "clickNotification" => {
            let session_ref: SessionRef = serde_json::from_value(params["sessionRef"].clone())
                .map_err(|error| CoreError::new(format!("Invalid sessionRef: {error}")))?;
            notifications::open_session(&app.kernel, &session_ref).await?;
        }
        "piHostPid" => return Ok(dispatch::value(app.driver.pid())),
        "quit" => app.quit.notify_one(),
        _ => return Err(CoreError::new(format!("Unknown test call: test.{name}"))),
    }
    Ok(Reply::Undefined)
}

/// Shows the app's text prompt (used by provider login) as a page of its own, as Electron's
/// `promptForText` test hook opens its modal. Answers the prompt to load and the outcome to
/// wait for.
async fn begin_text_prompt(app: &Rc<App>, params: &Value) -> CoreResult<Reply> {
    let message = text_param(params, "message")?;
    let placeholder = params["placeholder"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let opened_before = app.shell.open_prompts().last().map(|(id, _)| *id);
    let kernel = app.kernel.clone();
    let parent = app.shell.focused_window();
    let outcome = tokio::task::spawn_local(async move {
        prompt_for_text(&kernel, parent, message, placeholder, false).await
    });
    // The prompt opens as soon as the task first runs.
    let mut prompt = None;
    for _ in 0..100 {
        tokio::task::yield_now().await;
        prompt = app
            .shell
            .open_prompts()
            .last()
            .map(|(id, _)| *id)
            .filter(|id| Some(*id) != opened_before);
        if prompt.is_some() {
            break;
        }
    }
    let prompt = prompt.ok_or_else(|| CoreError::new("The text prompt did not open"))?;
    let id = app.next_text_prompt.get() + 1;
    app.next_text_prompt.set(id);
    app.text_prompts.borrow_mut().insert(id, outcome);
    Ok(Reply::Value(json!({ "prompt": prompt, "outcome": id })))
}

/// What `BrowserWindow` would report: presence, and the theme its background follows.
fn window_state(app: &App, params: &Value) -> Value {
    let Some(presence) = window_param(params)
        .ok()
        .and_then(|window| app.shell.presence(window))
    else {
        return Value::Null;
    };
    json!({
        "visible": presence.visible,
        "minimized": presence.minimized,
        "focused": presence.focused,
        "maximized": false,
        "themePresetId": app.kernel.data.borrow().state.theme_preset_id,
        "resolvedTheme": ui::resolved_theme(&app.kernel),
    })
}

/// `harness.ipc.invokeTogether`: the requests reach the kernel from the first window in one
/// turn, in order, and all of them are waited for.
async fn invoke_together(app: &Rc<App>, params: &Value) -> CoreResult<()> {
    let window = app
        .kernel
        .windows
        .ids()
        .into_iter()
        .next()
        .ok_or_else(|| CoreError::new("Expected a desktop window to send from"))?;
    let mut calls = params["requests"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|request| {
            let channel = request["channel"].as_str().unwrap_or_default();
            let method = methods::by_channel(channel).ok_or_else(|| {
                CoreError::new(format!("No IPC handler registered for {channel}"))
            })?;
            let call = InvokeCall {
                window,
                main_frame: true,
                args: decode_args(request),
            };
            Ok(Box::pin(dispatch::invoke(&app.kernel, method.api, call)))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    // Electron runs every handler's synchronous part in one main-process turn and queued
    // actions after it, so a command captures the view displayed before a navigation sent with
    // it runs. Holding the action queue while each call starts does the same here.
    let mut started: Vec<Option<CoreResult<Reply>>> = calls.iter().map(|_| None).collect();
    app.kernel
        .queue
        .run(std::future::poll_fn(|cx| {
            for (call, result) in calls.iter_mut().zip(started.iter_mut()) {
                if let std::task::Poll::Ready(output) = std::future::Future::poll(call.as_mut(), cx)
                {
                    *result = Some(output);
                }
            }
            std::task::Poll::Ready(())
        }))
        .await;
    let pending = calls
        .into_iter()
        .zip(started.iter())
        .filter(|(_, result)| result.is_none())
        .map(|(call, _)| call);
    for result in pi_gui_core::app::futures_join_all(pending).await {
        result?;
    }
    for result in started.into_iter().flatten() {
        result?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_arguments_come_back_as_none() {
        let request = json!({ "args": ["a", null, null], "undefinedAt": [1, 3] });
        assert_eq!(
            decode_args(&request),
            vec![Some(json!("a")), None, Some(Value::Null), None]
        );
    }
}
