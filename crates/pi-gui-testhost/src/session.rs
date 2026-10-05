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
use pi_gui_core::app::shell::{Push, Shell};
use pi_gui_core::app::test_hooks::ControlMode;
use pi_gui_core::app::{events, publish, ui, WindowId};
use pi_gui_core::error::{CoreError, CoreResult};
use pi_gui_core::state::driver::{session_key, SessionDriverEvent};
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
    app.kernel.windows.add(&app.kernel, window, None);
    if app.shell.focused_window() == Some(window) {
        focus(app, window);
    }
    window
}

fn detach_window(app: &Rc<App>, window: WindowId) {
    app.windows.senders.borrow_mut().remove(&window);
    let weak = Rc::downgrade(app);
    let timer = tokio::task::spawn_local(async move {
        tokio::time::sleep(RELOAD_GRACE).await;
        let Some(app) = weak.upgrade() else {
            return;
        };
        app.windows.detached.borrow_mut().remove(&window);
        app.shell.remove_window(window);
        app.kernel.windows.remove(&app.kernel, window);
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
            ControlMode::parse(&text_param(&params, "mode")?)?,
            params["sentinel"].as_str().map(str::to_owned),
            params.get("replacement").cloned(),
        )?,
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
        "queuePrompt" => app
            .shell
            .queue_prompt(params["answer"].as_str().map(str::to_owned)),
        // A page left the app for this URL: web links open in the browser and anything else is
        // dropped, as Electron's navigation handlers do.
        "navigateAway" => {
            let url = text_param(&params, "url")?;
            if ui::is_external_web_url(&url) {
                app.shell.open_external(url).await?;
            }
        }
        "shellLog" => return Ok(Reply::Value(Value::Array(app.shell.take_log()))),
        "windows" => return Ok(dispatch::value(app.kernel.windows.ids())),
        "focusWindow" => {
            let window = params["window"]
                .as_u64()
                .and_then(|window| WindowId::try_from(window).ok())
                .ok_or_else(|| CoreError::new("test call needs window"))?;
            focus(app, window);
        }
        "piHostPid" => return Ok(dispatch::value(app.driver.pid())),
        "quit" => app.quit.notify_one(),
        _ => return Err(CoreError::new(format!("Unknown test call: test.{name}"))),
    }
    Ok(Reply::Undefined)
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
