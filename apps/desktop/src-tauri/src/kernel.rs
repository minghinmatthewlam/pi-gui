//! The kernel thread: the same `Kernel` the test host runs, on its own thread with a
//! current-thread runtime and a `LocalSet`, since the kernel is single-threaded by design.
//! Tauri commands and window events reach it as `KernelMsg`s; it reaches windows through
//! `TauriShell`.

use crate::shell::{self, SharedWindows, TauriShell};
use crate::windows;
use base64::Engine;
use pi_gui_core::app::dispatch::{self, InvokeCall};
use pi_gui_core::app::methods::{self, push};
use pi_gui_core::app::pi::{HostLaunch, HostPiDriver};
use pi_gui_core::app::shell::WindowPresence;
use pi_gui_core::app::{notifications, publish, ui, Kernel, KernelDeps, WindowId};
use pi_gui_core::error::CoreResult;
use pi_gui_core::rpc::{Peer, Service};
use pi_gui_core::state::driver::SessionRef;
use pi_gui_core::state::env::SystemEnv;
use pi_gui_core::Core;
use serde_json::{json, Value};
use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, UriSchemeResponder};
use tokio::sync::{mpsc, oneshot};

/// Electron main's bounds: quit never waits longer than this for drafts, saves and pi.
const QUIT_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
const PI_HOST_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const CORE_STOP_TIMEOUT: Duration = Duration::from_secs(1);

/// What the app was started with, read from the environment as Electron main reads it.
pub struct Launch {
    pub user_data_dir: PathBuf,
    pub initial_workspace_paths: Vec<String>,
    pub test_mode: bool,
    /// `PI_APP_TEST_MODE=background`: windows are never shown.
    pub background: bool,
    pub node: PathBuf,
    pub host_script: PathBuf,
}

pub enum KernelMsg {
    /// A page connected its push channel; `reloaded` when it replaced an earlier page.
    Connected {
        window: WindowId,
        reloaded: bool,
    },
    /// A renderer call; no `reply` for a fire-and-forget send.
    Invoke {
        window: WindowId,
        method: String,
        args: Vec<Option<Value>>,
        reply: Option<oneshot::Sender<String>>,
    },
    Presence {
        window: WindowId,
        presence: WindowPresence,
    },
    /// The user closed a window; it closes once its draft is saved.
    CloseRequested(WindowId),
    Destroyed(WindowId),
    NewWindow {
        source: Option<WindowId>,
    },
    OpenFolder(WindowId),
    /// Another launch was refused by the single-instance lock.
    SecondInstance,
    ViewAsset {
        url: String,
        responder: UriSchemeResponder,
    },
    /// The app was asked to exit; it exits once everything is saved and stopped.
    Quit,
    /// A click on a thread's desktop notification.
    NotificationClicked(SessionRef),
    /// The page answered its text prompt; `None` is its Cancel.
    PromptAnswer {
        window: WindowId,
        id: u64,
        value: Option<String>,
    },
    /// Mod+W, which closes the focused side panel tool or terminal before the window.
    CloseShortcut {
        window: WindowId,
        /// From the window's menu, which closes the window when no surface has focus.
        close_window: bool,
    },
    /// The window's theme changed, which may be the OS appearance.
    ThemeChanged(WindowId),
}

/// Where quitting is: Electron main's `quitFlush`.
#[derive(Default)]
pub struct QuitState(AtomicU8);

impl QuitState {
    const RUNNING: u8 = 0;
    const FLUSHING: u8 = 1;
    const DONE: u8 = 2;

    pub fn is_flushing(&self) -> bool {
        self.0.load(Ordering::SeqCst) == Self::FLUSHING
    }

    pub fn is_done(&self) -> bool {
        self.0.load(Ordering::SeqCst) == Self::DONE
    }

    /// True for the first request only; later ones wait for the flush already running.
    pub fn begin(&self) -> bool {
        self.0
            .compare_exchange(
                Self::RUNNING,
                Self::FLUSHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    fn finish(&self) {
        self.0.store(Self::DONE, Ordering::SeqCst);
    }
}

/// What commands and window events hold to talk to the kernel thread.
#[derive(Clone)]
pub struct KernelHandle {
    sender: mpsc::UnboundedSender<KernelMsg>,
    pub shared: Arc<SharedWindows>,
    pub quit: Arc<QuitState>,
    pub windows_closing: Arc<std::sync::Mutex<std::collections::HashSet<WindowId>>>,
}

impl KernelHandle {
    pub fn send(&self, message: KernelMsg) {
        // Only fails once the kernel thread has stopped, when nothing is left to answer.
        let _ = self.sender.send(message);
    }

    pub fn connect(&self, window: WindowId, channel: Channel) {
        let reloaded = self.shared.connect(window, channel);
        self.send(KernelMsg::Connected { window, reloaded });
    }
}

/// Starts the kernel thread. Messages sent before it is ready wait in order.
pub fn spawn(app: AppHandle, launch: Launch) -> KernelHandle {
    let (sender, receiver) = mpsc::unbounded_channel();
    let handle = KernelHandle {
        sender,
        shared: Arc::default(),
        quit: Arc::default(),
        windows_closing: Arc::default(),
    };
    let thread_handle = handle.clone();
    std::thread::Builder::new()
        .name("pi-gui-kernel".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("a runtime");
            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, run(app, launch, thread_handle, receiver));
        })
        .expect("the kernel thread starts");
    handle
}

/// Everything the kernel thread owns.
struct Context {
    app: AppHandle,
    handle: KernelHandle,
    kernel: Rc<Kernel>,
    shell: Rc<TauriShell>,
    driver: Rc<HostPiDriver>,
    core: Rc<Core>,
    background: bool,
    next_window: Cell<WindowId>,
}

async fn run(
    app: AppHandle,
    launch: Launch,
    handle: KernelHandle,
    mut receiver: mpsc::UnboundedReceiver<KernelMsg>,
) {
    let context = match start(app.clone(), launch, handle).await {
        Ok(context) => Rc::new(context),
        Err(error) => {
            eprintln!("[pi-gui] Application startup failed: {}", error.message);
            app.exit(1);
            return;
        }
    };
    open_window(&context, None);
    while let Some(message) = receiver.recv().await {
        handle_message(&context, message);
    }
}

/// What Electron main does before its first window: the core, the pi host, then the store.
async fn start(app: AppHandle, launch: Launch, handle: KernelHandle) -> CoreResult<Context> {
    // The core, in process. Its notifications (terminal output) go to the kernel once it exists.
    let (peer, mut core_lines) = Peer::new();
    let core = Core::new(peer);
    core.clone()
        .call(
            pi_gui_core::methods::INITIALIZE.to_owned(),
            json!({ "userDataDir": launch.user_data_dir }),
        )
        .await?;
    let driver = HostPiDriver::start(HostLaunch {
        node: launch.node,
        script: launch.host_script,
        env: std::env::vars().collect(),
    })
    .await?;
    let shell = Rc::new(TauriShell::new(
        app.clone(),
        handle.clone(),
        launch.test_mode,
    ));
    let kernel = Kernel::new(KernelDeps {
        core: core.clone(),
        driver: driver.clone(),
        shell: shell.clone(),
        env: Rc::new(SystemEnv::new()),
        user_data_dir: launch.user_data_dir,
        initial_workspace_paths: launch.initial_workspace_paths,
        test_mode: launch.test_mode,
    });
    driver.set_host_calls(kernel.host_calls());
    let relay = Rc::downgrade(&kernel);
    tokio::task::spawn_local(async move {
        while let Some(line) = core_lines.recv().await {
            let (Some(kernel), Ok(message)) =
                (relay.upgrade(), serde_json::from_str::<Value>(&line))
            else {
                continue;
            };
            if let Some(method) = message["method"].as_str() {
                kernel.core_notification(method, message["params"].clone());
            }
        }
    });
    kernel.start().await;
    Ok(Context {
        app,
        handle,
        kernel,
        shell,
        driver,
        core,
        background: launch.background,
        next_window: Cell::new(0),
    })
}

fn handle_message(context: &Rc<Context>, message: KernelMsg) {
    let kernel = &context.kernel;
    match message {
        KernelMsg::Connected { window, reloaded } => {
            if reloaded {
                // The old page's prompt went with it.
                context.shell.cancel_prompts(window);
                kernel.windows.renderer_reset(kernel, window);
            }
        }
        KernelMsg::Invoke {
            window,
            method,
            args,
            reply,
        } => {
            let kernel = kernel.clone();
            tokio::task::spawn_local(async move {
                let call = InvokeCall {
                    window,
                    main_frame: true,
                    args,
                };
                let result = dispatch::invoke(&kernel, &method, call).await;
                match reply {
                    Some(reply) => {
                        let _ = reply.send(answer(&method, result));
                    }
                    None => {
                        if let Err(error) = result {
                            eprintln!("[pi-gui] {method} failed: {}", error.message);
                        }
                    }
                }
            });
        }
        KernelMsg::Presence { window, presence } => {
            if context.shell.set_presence(window, presence) {
                kernel.windows.activate(kernel, window);
                publish::send_to(kernel, window, push::WINDOW_FOCUSED, &Value::Null);
            }
        }
        KernelMsg::CloseRequested(window) => {
            let context = context.clone();
            tokio::task::spawn_local(async move {
                let kernel = &context.kernel;
                kernel.draft_flush.flush(kernel, &[window]).await;
                context
                    .handle
                    .windows_closing
                    .lock()
                    .unwrap()
                    .insert(window);
                if let Some(native) = context.app.get_webview_window(&shell::label(window)) {
                    let _ = native.close();
                }
            });
        }
        KernelMsg::Destroyed(window) => {
            context
                .handle
                .windows_closing
                .lock()
                .unwrap()
                .remove(&window);
            context.shell.remove_window(window);
            kernel.windows.closed(kernel, window);
        }
        KernelMsg::NewWindow { source } => open_window(context, source),
        KernelMsg::OpenFolder(window) => {
            // The same path as the renderer's own `pickWorkspace`.
            let kernel = kernel.clone();
            tokio::task::spawn_local(async move {
                let call = InvokeCall {
                    window,
                    main_frame: true,
                    args: Vec::new(),
                };
                if let Err(error) = dispatch::invoke(&kernel, "pickWorkspace", call).await {
                    eprintln!("[main] pickWorkspaceViaDialog failed: {}", error.message);
                }
            });
        }
        KernelMsg::SecondInstance => {
            if let Some(window) = kernel.windows.foreground(kernel) {
                windows::bring_to_front(&context.app, window);
            }
        }
        KernelMsg::ViewAsset { url, responder } => {
            let driver = context.driver.clone();
            tokio::task::spawn_local(async move {
                responder.respond(view_asset_response(driver.view_asset(&url).await));
            });
        }
        KernelMsg::Quit => {
            let context = context.clone();
            tokio::task::spawn_local(async move { quit(&context).await });
        }
        KernelMsg::NotificationClicked(session_ref) => {
            let kernel = kernel.clone();
            tokio::task::spawn_local(async move {
                if let Err(error) = notifications::open_session(&kernel, &session_ref).await {
                    eprintln!(
                        "[notification-manager] openSession failed {}",
                        error.message
                    );
                }
            });
        }
        KernelMsg::PromptAnswer { window, id, value } => {
            context.shell.answer_prompt(window, id, value);
        }
        KernelMsg::CloseShortcut {
            window,
            close_window,
        } => close_shortcut(context, window, close_window),
        KernelMsg::ThemeChanged(window) => {
            if context.shell.system_theme_changed(window) {
                ui::system_theme_changed(kernel);
            }
        }
    }
}

/// What Electron main's `before-input-event` does with Mod+W: while the terminal or a side
/// panel tool has focus it closes that surface, and the window stays.
fn close_shortcut(context: &Context, window: WindowId, close_window: bool) {
    let kernel = &context.kernel;
    let surface_focused = {
        let data = kernel.data.borrow();
        let terminal = &data.workspace.terminal;
        terminal.terminal_focused.contains(&window) || terminal.side_panel_focused.contains(&window)
    };
    if surface_focused {
        publish::send_to(kernel, window, push::APP_COMMAND, &"close-focused-surface");
    } else if close_window {
        if let Some(native) = context.app.get_webview_window(&shell::label(window)) {
            let _ = native.close();
        }
    }
}

/// Opens a window that starts on `source`'s view, as Electron's `createAppWindow` does.
fn open_window(context: &Context, source: Option<WindowId>) {
    let kernel = &context.kernel;
    let source_view = source
        .filter(|source| kernel.windows.contains(*source))
        .map(|source| kernel.windows.view_for_window(kernel, source));
    let window = context.next_window.get() + 1;
    context.next_window.set(window);
    context.shell.add_window(window, !context.background);
    kernel.windows.add(kernel, window, source_view);
    let created = windows::create(
        &context.app,
        window,
        !context.background,
        context.shell.window_background(),
    );
    if created.is_ok() {
        context.shell.apply_appearance(window);
    }
    if let Err(error) = created {
        eprintln!("[main] Could not open a window: {error}");
        context.shell.remove_window(window);
        kernel.windows.remove(kernel, window);
    }
}

/// The renderer call's answer, in the test host's wire shape: `{"result":…}`, `{}` for
/// `undefined`, or `{"channel":…,"error":{name,message,data}}`.
fn answer(method: &str, result: CoreResult<dispatch::Reply>) -> String {
    match result {
        Ok(reply) => match reply.to_json() {
            Some(json) => format!("{{\"result\":{json}}}"),
            None => "{}".to_owned(),
        },
        Err(error) => {
            let channel = methods::by_api(method)
                .map(|method| method.channel)
                .unwrap_or(method);
            json!({ "channel": channel, "error": error }).to_string()
        }
    }
}

fn view_asset_response(asset: CoreResult<Value>) -> tauri::http::Response<Vec<u8>> {
    let unavailable = || {
        tauri::http::Response::builder()
            .status(404)
            .body(b"Unavailable".to_vec())
            .expect("a static response")
    };
    let Ok(asset) = asset else {
        return unavailable();
    };
    let Ok(body) = base64::engine::general_purpose::STANDARD
        .decode(asset["bodyBase64"].as_str().unwrap_or_default())
    else {
        return unavailable();
    };
    let mut response =
        tauri::http::Response::builder().status(asset["status"].as_u64().unwrap_or(200) as u16);
    for (name, value) in asset["headers"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            response = response.header(name.as_str(), value);
        }
    }
    response.body(body).unwrap_or_else(|_| unavailable())
}

/// Electron's `before-quit`: windows send their drafts, state is saved, pi stops, then the
/// core; never longer than the flush bound.
async fn quit(context: &Context) {
    let work = async {
        context.kernel.prepare_quit().await;
        context.driver.stop(PI_HOST_STOP_TIMEOUT).await;
        // Last: pi may still save thread changes while it stops.
        let stop_core = context
            .core
            .clone()
            .call(pi_gui_core::methods::SHUTDOWN.to_owned(), json!({}));
        if tokio::time::timeout(CORE_STOP_TIMEOUT, stop_core)
            .await
            .is_err()
        {
            eprintln!("pi-gui: the core did not stop in time.");
        }
    };
    if tokio::time::timeout(QUIT_FLUSH_TIMEOUT, work)
        .await
        .is_err()
    {
        eprintln!("pi-gui: persistence flush timed out during quit; quitting anyway.");
    }
    context.handle.quit.finish();
    context.app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use pi_gui_core::app::dispatch::Reply;
    use pi_gui_core::error::CoreError;

    #[test]
    fn answers_use_the_test_host_wire_shape() {
        assert_eq!(
            answer("ping", Ok(Reply::Value(json!("ok")))),
            r#"{"result":"ok"}"#
        );
        assert_eq!(answer("ping", Ok(Reply::Undefined)), "{}");
        let failed: Value =
            serde_json::from_str(&answer("getState", Err(CoreError::new("boom")))).unwrap();
        assert_eq!(failed["channel"], "pi-gui:state-request");
        assert_eq!(failed["error"]["message"], "boom");
    }

    #[test]
    fn quitting_starts_once() {
        let quit = QuitState::default();
        assert!(quit.begin());
        assert!(quit.is_flushing());
        assert!(!quit.begin());
        quit.finish();
        assert!(quit.is_done());
    }
}
