//! The kernel's view of the windowing shell: where pushes go, which windows exist and how they
//! look, and the native dialogs, links and notifications. Tauri and the test host implement it;
//! the kernel never touches a window directly.

use super::WindowId;
use crate::error::{CoreError, CoreResult};
use crate::rpc::LocalFuture;
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
    /// Reveals a path in the file manager, or opens it with its app when `open` is set.
    fn reveal_path(&self, path: PathBuf, open: bool) -> LocalFuture<CoreResult<()>>;
    fn toggle_maximize(&self, window: WindowId);
    fn relaunch(&self);
    /// A desktop notification; the payload is the notification manager's.
    fn notify(&self, notification: Value) -> LocalFuture<CoreResult<()>>;
    /// `"status" | "request" | "openSettings"`.
    fn notification_permission(&self, operation: &str) -> LocalFuture<CoreResult<Value>>;
    fn read_clipboard_image(&self) -> Value;
    /// Theme mode, preset and transparency, for native window chrome.
    fn set_appearance(&self, appearance: Value);
}

/// A window's push sink in the test host.
pub type PushSink = Box<dyn Fn(&Push)>;

struct TestWindow {
    sink: PushSink,
    presence: WindowPresence,
}

/// A shell with no native windows, for the test host and unit tests. Windows are connections;
/// dialogs and prompts are answered by `test.*` calls queued ahead of time.
pub struct TestShell {
    windows: RefCell<IndexMap<WindowId, TestWindow>>,
    focused: Cell<Option<WindowId>>,
    /// `PI_APP_TEST_MODE=background`: windows are never shown, as in the Electron lane.
    background: bool,
    open_dialog_answers: RefCell<VecDeque<Option<Vec<PathBuf>>>>,
    prompt_answers: RefCell<VecDeque<Option<String>>>,
    /// External links, reveals, notifications and appearance changes, in order.
    log: RefCell<Vec<Value>>,
}

impl TestShell {
    pub fn new(background: bool) -> Rc<Self> {
        Rc::new(Self {
            windows: RefCell::new(IndexMap::new()),
            focused: Cell::new(None),
            background,
            open_dialog_answers: RefCell::new(VecDeque::new()),
            prompt_answers: RefCell::new(VecDeque::new()),
            log: RefCell::new(Vec::new()),
        })
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

    /// The next text prompt returns this; `None` cancels it.
    pub fn queue_prompt(&self, answer: Option<String>) {
        self.prompt_answers.borrow_mut().push_back(answer);
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
        let answer = self.open_dialog_answers.borrow_mut().pop_front();
        self.record(json!({ "kind": "openDialog", "title": request.title }));
        Box::pin(std::future::ready(Ok(answer.flatten())))
    }

    fn prompt_text(
        &self,
        _parent: Option<WindowId>,
        request: PromptText,
    ) -> LocalFuture<CoreResult<Option<String>>> {
        let answer = self.prompt_answers.borrow_mut().pop_front();
        self.record(json!({ "kind": "prompt", "message": request.message }));
        Box::pin(std::future::ready(Ok(answer.flatten())))
    }

    fn open_external(&self, url: String) -> LocalFuture<CoreResult<()>> {
        self.record(json!({ "kind": "openExternal", "url": url }));
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

    fn notification_permission(&self, operation: &str) -> LocalFuture<CoreResult<Value>> {
        let result = match operation {
            "status" | "request" => Ok(json!("granted")),
            "openSettings" => Ok(Value::Null),
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
