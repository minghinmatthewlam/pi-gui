//! The kernel's view of the windowing shell: where pushes go, which windows exist and how they
//! look, and the native dialogs, links and notifications. Tauri and the test host implement it;
//! the kernel never touches a window directly.

use super::WindowId;
use crate::error::{CoreError, CoreResult};
use crate::rpc::LocalFuture;
use crate::state::driver::SessionRef;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::rc::Rc;

/// A message to one window. JSON is serialized once and sent as is.
#[derive(Debug, Clone)]
pub enum Push {
    /// `desktopIpc.stateChanged`.
    State(Rc<str>),
    /// `desktopIpc.selectedTranscriptChanged`.
    Transcript(Rc<str>),
    /// Any other push, by its `desktopIpc` channel.
    Json {
        channel: &'static str,
        json: Rc<str>,
    },
}

impl Push {
    pub fn channel(&self) -> &'static str {
        match self {
            Self::State(_) => "pi-gui:state-changed",
            Self::Transcript(_) => "pi-gui:selected-transcript-changed",
            Self::Json { channel, .. } => channel,
        }
    }

    pub fn json(&self) -> &str {
        match self {
            Self::State(json) | Self::Transcript(json) | Self::Json { json, .. } => json,
        }
    }
}

/// How a window looks right now, as `BrowserWindow` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowPresence {
    pub visible: bool,
    pub minimized: bool,
    pub focused: bool,
}

/// `dialog.showOpenDialog`.
#[derive(Debug, Clone, Default)]
pub struct PickPaths {
    pub title: Option<String>,
    pub directories: bool,
    pub multiple: bool,
}

/// The prompt window main opens for sign-in codes and names.
#[derive(Debug, Clone, Default)]
pub struct PromptText {
    pub message: String,
    pub placeholder: String,
    pub allow_empty: bool,
}

/// What the shell tells the kernel.
#[derive(Debug, Clone)]
pub enum ShellEvent {
    WindowOpened {
        window: WindowId,
        source: Option<WindowId>,
    },
    WindowClosed(WindowId),
    /// Focus, show or restore.
    WindowFocused(WindowId),
    /// The renderer reloaded and needs its state again.
    RendererReset(WindowId),
}

pub trait Shell {
    fn send(&self, window: WindowId, push: Push);
    /// Open windows, oldest first.
    fn windows(&self) -> Vec<WindowId>;
    /// None once the window is gone.
    fn presence(&self, window: WindowId) -> Option<WindowPresence>;
    fn focused_window(&self) -> Option<WindowId>;
    fn pick_paths(
        &self,
        parent: Option<WindowId>,
        request: PickPaths,
    ) -> LocalFuture<CoreResult<Option<Vec<PathBuf>>>>;
    fn prompt_text(
        &self,
        parent: Option<WindowId>,
        request: PromptText,
    ) -> LocalFuture<CoreResult<Option<String>>>;
    fn open_external(&self, url: String) -> LocalFuture<CoreResult<()>>;
    /// A message the user must acknowledge (`window.alert` in the window), such as sign-in
    /// instructions.
    fn show_message(
        &self,
        parent: Option<WindowId>,
        message: String,
    ) -> LocalFuture<CoreResult<()>>;
    /// Reveals a path in the file manager, or opens it with its app when `open` is set.
    fn reveal_path(&self, path: PathBuf, open: bool) -> LocalFuture<CoreResult<()>>;
    fn toggle_maximize(&self, window: WindowId);
    fn relaunch(&self);
    /// A desktop notification: `{sessionRef, title, body}`. A click on it calls
    /// `notifications::open_session` with its `sessionRef`.
    fn notify(&self, notification: Value) -> LocalFuture<CoreResult<()>>;
    /// Takes down the thread's notification, if it is still up.
    fn close_notification(&self, session_ref: &SessionRef);
    /// Restores, shows and focuses a window.
    fn show_window(&self, window: WindowId);
    /// `"status" | "request" | "openSettings"`.
    fn notification_permission(&self, operation: &str) -> LocalFuture<CoreResult<Value>>;
    fn read_clipboard_image(&self) -> Value;
    /// Theme mode, preset and transparency, for native window chrome.
    fn set_appearance(&self, appearance: Value);
    /// Where a window loads an extension view's frame. The pi host names it with the
    /// `pi-extension://<connectionId>/` scheme, which a shell serves as is unless its web view
    /// cannot load custom schemes.
    fn extension_frame_url(&self, frame_url: String) -> String {
        frame_url
    }
}

/// A window's push sink in the test host.
pub type PushSink = Box<dyn Fn(&Push)>;

/// A text prompt the test shell is showing, until a test answers it.
struct OpenPrompt {
    request: PromptText,
    reply: tokio::sync::oneshot::Sender<Option<String>>,
}

struct TestWindow {
    sink: PushSink,
    presence: WindowPresence,
}

/// A shell with no native windows, for the test host and unit tests. Windows are connections;
/// open dialogs are answered by `test.*` calls queued ahead of time, and text prompts stay open
/// until a test answers them.
pub struct TestShell {
    windows: RefCell<IndexMap<WindowId, TestWindow>>,
    focused: Cell<Option<WindowId>>,
    /// `PI_APP_TEST_MODE=background`: windows are never shown, as in the Electron lane.
    background: bool,
    open_dialog_answers: RefCell<VecDeque<Option<Vec<PathBuf>>>>,
    /// `holdNextOpenDialog`: the next open dialog waits for a release, then returns these.
    held_open_dialog: RefCell<Option<Vec<PathBuf>>>,
    /// The held open dialog that is waiting for its release.
    open_dialog_release: RefCell<Option<Rc<tokio::sync::Notify>>>,
    next_prompt: Cell<u64>,
    prompts: RefCell<IndexMap<u64, OpenPrompt>>,
    /// External links, reveals, notifications and appearance changes, in order.
    log: RefCell<Vec<Value>>,
    /// The test host's port, which also serves extension frames to Chromium.
    extension_frame_port: Cell<Option<u16>>,
    /// `testPermissionStatus`: `None` reads as granted, as a renderer's `Notification` does.
    permission_status: RefCell<Option<String>>,
}

const PERMISSION_STATUS_ENV: &str = "PI_APP_TEST_NOTIFICATION_PERMISSION_STATUS";
const PERMISSION_REQUEST_RESULT_ENV: &str = "PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT";
const PERMISSION_REQUEST_LOG_ENV: &str = "PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_LOG_PATH";
const NOTIFICATION_SETTINGS_LOG_ENV: &str = "PI_APP_TEST_NOTIFICATION_SETTINGS_LOG_PATH";
/// Where main sends people for notification settings off macOS.
const NOTIFICATION_SETTINGS_HELP_URL: &str =
    "https://support.apple.com/guide/mac-help/change-notifications-settings-mh40583/mac";

/// A permission status from the environment, when it is one.
fn permission_env(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    matches!(
        value.as_str(),
        "granted" | "denied" | "default" | "unsupported" | "unknown"
    )
    .then_some(value)
}

/// Appends the time to the log file the environment names. False when it names none.
fn append_test_log(name: &str) -> bool {
    let Some(path) = std::env::var(name)
        .ok()
        .filter(|path| !path.trim().is_empty())
    else {
        return false;
    };
    let line = format!(
        "{}\n",
        crate::js::to_iso_string(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
        )
        .unwrap_or_default()
    );
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.trim())
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
    if let Err(error) = written {
        eprintln!("[notification-permission] could not write {path}: {error}");
    }
    true
}

impl TestShell {
    pub fn new(background: bool) -> Rc<Self> {
        Rc::new(Self {
            windows: RefCell::new(IndexMap::new()),
            focused: Cell::new(None),
            background,
            open_dialog_answers: RefCell::new(VecDeque::new()),
            held_open_dialog: RefCell::new(None),
            open_dialog_release: RefCell::new(None),
            next_prompt: Cell::new(0),
            prompts: RefCell::new(IndexMap::new()),
            log: RefCell::new(Vec::new()),
            extension_frame_port: Cell::new(None),
            permission_status: RefCell::new(permission_env(PERMISSION_STATUS_ENV)),
        })
    }

    /// Chromium cannot load `pi-extension:` frames, so the test host serves them over HTTP on
    /// this port, by connection id as the host name (see `extension_frame_url`).
    pub fn set_extension_frame_port(&self, port: u16) {
        self.extension_frame_port.set(Some(port));
    }

    pub fn add_window(&self, window: WindowId, sink: PushSink) {
        let visible = !self.background;
        self.windows.borrow_mut().insert(
            window,
            TestWindow {
                sink,
                presence: WindowPresence {
                    visible,
                    minimized: false,
                    focused: visible,
                },
            },
        );
        if visible {
            self.focus(window);
        }
    }

    pub fn remove_window(&self, window: WindowId) {
        self.windows.borrow_mut().shift_remove(&window);
        if self.focused.get() == Some(window) {
            self.focused.set(None);
        }
    }

    /// Focuses a window, as the user clicking it would.
    pub fn focus(&self, window: WindowId) {
        let mut windows = self.windows.borrow_mut();
        if !windows.contains_key(&window) {
            return;
        }
        for (id, entry) in windows.iter_mut() {
            entry.presence.focused = *id == window && entry.presence.visible;
        }
        if windows[&window].presence.visible {
            self.focused.set(Some(window));
        }
    }

    pub fn set_presence(&self, window: WindowId, presence: WindowPresence) {
        if let Some(entry) = self.windows.borrow_mut().get_mut(&window) {
            entry.presence = presence;
        }
        if presence.focused {
            self.focused.set(Some(window));
        } else if self.focused.get() == Some(window) {
            self.focused.set(None);
        }
    }

    /// The next open dialog returns these paths; `None` cancels it.
    pub fn queue_open_dialog(&self, paths: Option<Vec<PathBuf>>) {
        self.open_dialog_answers.borrow_mut().push_back(paths);
    }

    /// The next open dialog stays open until `release_held_open_dialog`, then returns `paths`.
    pub fn hold_open_dialog(&self, paths: Vec<PathBuf>) {
        *self.held_open_dialog.borrow_mut() = Some(paths);
    }

    /// Answers the held open dialog.
    pub fn release_held_open_dialog(&self) -> CoreResult<()> {
        let release = self
            .open_dialog_release
            .borrow_mut()
            .take()
            .ok_or_else(|| CoreError::new("Delayed open dialog was not pending."))?;
        release.notify_one();
        Ok(())
    }

    /// Minimizes a window, which also takes its focus.
    pub fn minimize(&self, window: WindowId) {
        if let Some(presence) = self.presence(window) {
            self.set_presence(
                window,
                WindowPresence {
                    minimized: true,
                    focused: false,
                    ..presence
                },
            );
        }
    }

    /// Shows a window, as `BrowserWindow.show` does.
    pub fn show(&self, window: WindowId) {
        if let Some(presence) = self.presence(window) {
            self.set_presence(
                window,
                WindowPresence {
                    visible: true,
                    ..presence
                },
            );
            self.focus(window);
        }
    }

    /// Text prompts still open, oldest first, with their message and placeholder.
    pub fn open_prompts(&self) -> Vec<(u64, PromptText)> {
        self.prompts
            .borrow()
            .iter()
            .map(|(id, prompt)| (*id, prompt.request.clone()))
            .collect()
    }

    /// Answers an open prompt as its OK button does; `None` is its Cancel button.
    pub fn answer_prompt(&self, id: u64, answer: Option<String>) -> CoreResult<()> {
        let prompt = self
            .prompts
            .borrow_mut()
            .shift_remove(&id)
            .ok_or_else(|| CoreError::new(format!("No open text prompt {id}")))?;
        let _ = prompt.reply.send(answer);
        Ok(())
    }

    pub fn take_log(&self) -> Vec<Value> {
        std::mem::take(&mut self.log.borrow_mut())
    }

    fn record(&self, entry: Value) {
        self.log.borrow_mut().push(entry);
    }
}

impl Shell for TestShell {
    fn send(&self, window: WindowId, push: Push) {
        if let Some(entry) = self.windows.borrow().get(&window) {
            (entry.sink)(&push);
        }
    }

    fn windows(&self) -> Vec<WindowId> {
        self.windows.borrow().keys().copied().collect()
    }

    fn presence(&self, window: WindowId) -> Option<WindowPresence> {
        self.windows
            .borrow()
            .get(&window)
            .map(|entry| entry.presence)
    }

    fn focused_window(&self) -> Option<WindowId> {
        self.focused.get()
    }

    fn pick_paths(
        &self,
        _parent: Option<WindowId>,
        request: PickPaths,
    ) -> LocalFuture<CoreResult<Option<Vec<PathBuf>>>> {
        self.record(json!({ "kind": "openDialog", "title": request.title }));
        if let Some(paths) = self.held_open_dialog.borrow_mut().take() {
            let release = Rc::new(tokio::sync::Notify::new());
            *self.open_dialog_release.borrow_mut() = Some(release.clone());
            return Box::pin(async move {
                release.notified().await;
                Ok(Some(paths))
            });
        }
        let answer = self.open_dialog_answers.borrow_mut().pop_front();
        Box::pin(std::future::ready(Ok(answer.flatten())))
    }

    fn prompt_text(
        &self,
        _parent: Option<WindowId>,
        request: PromptText,
    ) -> LocalFuture<CoreResult<Option<String>>> {
        let id = self.next_prompt.get() + 1;
        self.next_prompt.set(id);
        self.record(json!({ "kind": "prompt", "id": id, "message": request.message }));
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.prompts
            .borrow_mut()
            .insert(id, OpenPrompt { request, reply });
        // A prompt dropped unanswered (the shell going away) counts as cancelled.
        Box::pin(async move { Ok(answer.await.unwrap_or(None)) })
    }

    /// `http://<connectionId>:<port>/`: the same host name and path the frame has under the
    /// `pi-extension:` scheme, still an opaque origin inside its sandboxed iframe.
    fn extension_frame_url(&self, frame_url: String) -> String {
        match (
            self.extension_frame_port.get(),
            frame_url.strip_prefix("pi-extension://"),
        ) {
            (Some(port), Some(rest)) => {
                let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
                format!("http://{host}:{port}/{path}")
            }
            _ => frame_url,
        }
    }

    fn open_external(&self, url: String) -> LocalFuture<CoreResult<()>> {
        self.record(json!({ "kind": "openExternal", "url": url }));
        Box::pin(std::future::ready(Ok(())))
    }

    fn show_message(
        &self,
        _parent: Option<WindowId>,
        message: String,
    ) -> LocalFuture<CoreResult<()>> {
        self.record(json!({ "kind": "message", "message": message }));
        Box::pin(std::future::ready(Ok(())))
    }

    fn reveal_path(&self, path: PathBuf, open: bool) -> LocalFuture<CoreResult<()>> {
        self.record(json!({ "kind": if open { "openPath" } else { "revealPath" }, "path": path }));
        Box::pin(std::future::ready(Ok(())))
    }

    fn toggle_maximize(&self, window: WindowId) {
        self.record(json!({ "kind": "toggleMaximize", "window": window }));
    }

    fn relaunch(&self) {
        self.record(json!({ "kind": "relaunch" }));
    }

    fn notify(&self, notification: Value) -> LocalFuture<CoreResult<()>> {
        self.record(json!({ "kind": "notification", "notification": notification }));
        Box::pin(std::future::ready(Ok(())))
    }

    fn close_notification(&self, session_ref: &SessionRef) {
        self.record(json!({ "kind": "closeNotification", "sessionRef": session_ref }));
    }

    fn show_window(&self, window: WindowId) {
        let Some(presence) = self.presence(window) else {
            return;
        };
        self.set_presence(
            window,
            WindowPresence {
                visible: true,
                minimized: false,
                ..presence
            },
        );
        self.focus(window);
    }

    /// Main's permission service in test mode: `PI_APP_TEST_NOTIFICATION_PERMISSION_*` set the
    /// status and what asking returns, and requests and settings visits are logged to files.
    fn notification_permission(&self, operation: &str) -> LocalFuture<CoreResult<Value>> {
        let current = || {
            self.permission_status
                .borrow()
                .clone()
                .unwrap_or_else(|| "granted".to_owned())
        };
        let result = match operation {
            "status" => Ok(json!(current())),
            "request" => {
                append_test_log(PERMISSION_REQUEST_LOG_ENV);
                if let Some(answer) = permission_env(PERMISSION_REQUEST_RESULT_ENV) {
                    *self.permission_status.borrow_mut() = Some(answer);
                }
                Ok(json!(current()))
            }
            "openSettings" => {
                if !append_test_log(NOTIFICATION_SETTINGS_LOG_ENV) {
                    self.record(
                        json!({ "kind": "openExternal", "url": NOTIFICATION_SETTINGS_HELP_URL }),
                    );
                }
                Ok(Value::Null)
            }
            other => Err(CoreError::new(format!(
                "Unknown notification permission call: {other}"
            ))),
        };
        Box::pin(std::future::ready(result))
    }

    fn read_clipboard_image(&self) -> Value {
        json!({ "ok": false })
    }

    fn set_appearance(&self, appearance: Value) {
        self.record(json!({ "kind": "appearance", "appearance": appearance }));
    }
}
