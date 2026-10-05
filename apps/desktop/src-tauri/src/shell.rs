//! `TauriShell`: the kernel's `Shell` over native Tauri windows, dialogs, the clipboard,
//! notifications and the system opener. It lives on the kernel thread; what the main thread
//! also needs (each window's push channel) sits in `SharedWindows`.

use crate::kernel::{KernelHandle, KernelMsg};
use crate::theme;
use base64::Engine;
use indexmap::IndexMap;
use pi_gui_core::app::shell::{PickPaths, PromptText, Push, Shell, WindowPresence};
use pi_gui_core::app::validation::{
    composer_image_bytes_limit_message, composer_image_pixels_limit_message,
    COMPOSER_IMAGE_MAX_BYTES, COMPOSER_IMAGE_MAX_DIMENSION,
};
use pi_gui_core::app::WindowId;
use pi_gui_core::error::{CoreError, CoreResult};
use pi_gui_core::rpc::LocalFuture;
use pi_gui_core::state::driver::{session_key, SessionRef};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Theme};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

pub fn label(window: WindowId) -> String {
    format!("w{window}")
}

pub fn window_id(label: &str) -> Option<WindowId> {
    label.strip_prefix('w')?.parse().ok()
}

/// Each window's push channel, set when its page connects. Shared with the main thread, which
/// sends menu commands and needs no kernel round trip for them.
#[derive(Default)]
pub struct SharedWindows {
    channels: Mutex<HashMap<WindowId, Channel>>,
}

impl SharedWindows {
    /// Returns whether the window already had a page: a reload replaces its channel.
    pub fn connect(&self, window: WindowId, channel: Channel) -> bool {
        self.channels
            .lock()
            .unwrap()
            .insert(window, channel)
            .is_some()
    }

    pub fn disconnect(&self, window: WindowId) {
        self.channels.lock().unwrap().remove(&window);
    }

    /// `webContents.send(channel, payload)`, with the payload already JSON.
    pub fn send(&self, window: WindowId, channel: &str, json: &str) {
        let Some(sink) = self.channels.lock().unwrap().get(&window).cloned() else {
            return;
        };
        let message = format!(
            "{{\"channel\":{},\"payload\":{json}}}",
            Value::String(channel.to_owned())
        );
        // A page that is going away cannot take it; its next connect asks for state again.
        let _ = sink.send(InvokeResponseBody::Json(message));
    }
}

/// The channel the page's text prompt listens on (`src/platform/tauri-dialogs.ts`).
pub const TEXT_PROMPT_CHANNEL: &str = "pi-gui:text-prompt";

/// A text prompt a window's page is showing, until its OK or Cancel answers it.
struct OpenPrompt {
    window: WindowId,
    reply: oneshot::Sender<Option<String>>,
}

/// Desktop notifications still up, by thread and with the number they were shown under, so a
/// newer one or opening the thread takes them down. Shared with the threads that wait for
/// their clicks.
type ActiveNotifications = Arc<Mutex<HashMap<String, (u64, ShownNotification)>>>;

/// What it takes to close a notification: on Linux its handle on the notification server.
#[cfg(all(unix, not(target_os = "macos")))]
type ShownNotification = notify_rust::NotificationHandle;
#[cfg(not(all(unix, not(target_os = "macos"))))]
type ShownNotification = ();

pub struct TauriShell {
    app: AppHandle,
    handle: KernelHandle,
    shared: Arc<SharedWindows>,
    /// `PI_APP_TEST_MODE`: notifications are logged by the kernel but never shown.
    test_mode: bool,
    /// Open windows, oldest first, as their events last reported them.
    windows: RefCell<IndexMap<WindowId, WindowPresence>>,
    focused: Cell<Option<WindowId>>,
    next_prompt: Cell<u64>,
    prompts: RefCell<IndexMap<u64, OpenPrompt>>,
    notifications: ActiveNotifications,
    next_notification: Cell<u64>,
    /// The last theme mode, preset and transparency the kernel set.
    appearance: RefCell<Value>,
    /// The OS appearance, read from a window while the app leaves its theme to the system.
    system_dark: Cell<bool>,
}

impl TauriShell {
    pub fn new(app: AppHandle, handle: KernelHandle, test_mode: bool) -> Self {
        let shared = handle.shared.clone();
        Self {
            app,
            handle,
            shared,
            test_mode,
            windows: RefCell::new(IndexMap::new()),
            focused: Cell::new(None),
            next_prompt: Cell::new(0),
            prompts: RefCell::new(IndexMap::new()),
            notifications: Arc::default(),
            next_notification: Cell::new(0),
            appearance: RefCell::new(Value::Null),
            system_dark: Cell::new(false),
        }
    }

    /// The theme windows are held to, or `None` to follow the system.
    fn forced_theme(&self) -> Option<Theme> {
        match self.appearance.borrow()["themeMode"].as_str() {
            Some("dark") => Some(Theme::Dark),
            Some("light") => Some(Theme::Light),
            _ => None,
        }
    }

    /// The native colour behind the page, `currentWindowBackground` in Electron main.
    pub fn window_background(&self) -> tauri::window::Color {
        let dark = self
            .forced_theme()
            .map_or(self.system_dark.get(), |theme| theme == Theme::Dark);
        let appearance = self.appearance.borrow();
        let preset = appearance["themePresetId"].as_str().unwrap_or("default");
        theme::window_background(preset, dark)
    }

    /// Gives a window the current theme and background colour.
    pub fn apply_appearance(&self, window: WindowId) {
        let Some(native) = self.webview_window(window) else {
            return;
        };
        let forced = self.forced_theme();
        let _ = native.set_theme(forced);
        if forced.is_none() {
            // With no theme of its own the window reports the OS appearance.
            if let Ok(theme) = native.theme() {
                self.system_dark.set(theme == Theme::Dark);
            }
        }
        let _ = native.set_background_color(Some(self.window_background()));
    }

    /// A window saw its theme change. Returns whether the "system" theme now resolves
    /// differently. While the app holds windows to a theme they report that theme, so the OS
    /// appearance is read again once the app follows the system.
    pub fn system_theme_changed(&self, window: WindowId) -> bool {
        if self.forced_theme().is_some() {
            return false;
        }
        let Some(theme) = self
            .webview_window(window)
            .and_then(|native| native.theme().ok())
        else {
            return false;
        };
        let dark = theme == Theme::Dark;
        if dark == self.system_dark.get() {
            return false;
        }
        self.system_dark.set(dark);
        let background = self.window_background();
        for window in self.windows() {
            if let Some(native) = self.webview_window(window) {
                let _ = native.set_background_color(Some(background));
            }
        }
        true
    }

    /// Answers a window's text prompt as its OK button does; `None` is its Cancel button.
    pub fn answer_prompt(&self, window: WindowId, id: u64, answer: Option<String>) {
        let mut prompts = self.prompts.borrow_mut();
        if prompts
            .get(&id)
            .is_some_and(|prompt| prompt.window == window)
        {
            if let Some(prompt) = prompts.shift_remove(&id) {
                let _ = prompt.reply.send(answer);
            }
        }
    }

    /// The window's page went away, and its prompts with it: they count as cancelled.
    pub fn cancel_prompts(&self, window: WindowId) {
        self.prompts
            .borrow_mut()
            .retain(|_, prompt| prompt.window != window);
    }

    pub fn add_window(&self, window: WindowId, visible: bool) {
        self.windows.borrow_mut().insert(
            window,
            WindowPresence {
                visible,
                minimized: false,
                focused: false,
            },
        );
    }

    pub fn remove_window(&self, window: WindowId) {
        self.windows.borrow_mut().shift_remove(&window);
        self.shared.disconnect(window);
        self.cancel_prompts(window);
        if self.focused.get() == Some(window) {
            self.focused.set(None);
        }
    }

    /// What the window's events say now. Returns whether it just gained focus.
    pub fn set_presence(&self, window: WindowId, presence: WindowPresence) -> bool {
        let mut windows = self.windows.borrow_mut();
        let Some(entry) = windows.get_mut(&window) else {
            return false;
        };
        let gained = presence.focused && !entry.focused;
        *entry = presence;
        if presence.focused {
            for (id, other) in windows.iter_mut() {
                if *id != window {
                    other.focused = false;
                }
            }
            self.focused.set(Some(window));
        } else if self.focused.get() == Some(window) {
            self.focused.set(None);
        }
        gained
    }

    fn webview_window(&self, window: WindowId) -> Option<tauri::WebviewWindow> {
        self.app.get_webview_window(&label(window))
    }
}

/// The base64 PNG attachment `readClipboardImageAttachment` builds, with the same limits.
fn clipboard_image_attachment(width: u32, height: u32, rgba: &[u8]) -> Value {
    if width == 0 || height == 0 {
        return json!({ "ok": false });
    }
    if width > COMPOSER_IMAGE_MAX_DIMENSION || height > COMPOSER_IMAGE_MAX_DIMENSION {
        return json!({ "ok": false, "message": composer_image_pixels_limit_message() });
    }
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let written = encoder
            .write_header()
            .and_then(|mut writer| writer.write_image_data(rgba));
        if written.is_err() {
            return json!({ "ok": false });
        }
    }
    if png_bytes.len() as u64 > COMPOSER_IMAGE_MAX_BYTES {
        return json!({ "ok": false, "message": composer_image_bytes_limit_message() });
    }
    json!({
        "ok": true,
        "attachment": {
            "id": uuid::Uuid::new_v4().to_string(),
            "kind": "image",
            "name": "pasted-image.png",
            "mimeType": "image/png",
            "data": base64::engine::general_purpose::STANDARD.encode(&png_bytes),
        },
    })
}

impl Shell for TauriShell {
    fn send(&self, window: WindowId, push: Push) {
        self.shared.send(window, push.channel(), push.json());
    }

    fn windows(&self) -> Vec<WindowId> {
        self.windows.borrow().keys().copied().collect()
    }

    fn presence(&self, window: WindowId) -> Option<WindowPresence> {
        self.windows.borrow().get(&window).copied()
    }

    fn focused_window(&self) -> Option<WindowId> {
        self.focused.get()
    }

    fn pick_paths(
        &self,
        parent: Option<WindowId>,
        request: PickPaths,
    ) -> LocalFuture<CoreResult<Option<Vec<PathBuf>>>> {
        let mut dialog = self.app.dialog().file();
        if let Some(title) = request.title {
            dialog = dialog.set_title(title);
        }
        if let Some(parent) = parent.and_then(|parent| self.webview_window(parent)) {
            dialog = dialog.set_parent(&parent);
        }
        let (done, picked) = oneshot::channel();
        let paths = |paths: Option<Vec<tauri_plugin_dialog::FilePath>>| {
            paths.map(|paths| {
                paths
                    .into_iter()
                    .filter_map(|path| path.into_path().ok())
                    .collect::<Vec<_>>()
            })
        };
        match (request.directories, request.multiple) {
            (true, false) => dialog.pick_folder(move |path| {
                let _ = done.send(paths(path.map(|path| vec![path])));
            }),
            (true, true) => dialog.pick_folders(move |picked| {
                let _ = done.send(paths(picked));
            }),
            (false, false) => dialog.pick_file(move |path| {
                let _ = done.send(paths(path.map(|path| vec![path])));
            }),
            (false, true) => dialog.pick_files(move |picked| {
                let _ = done.send(paths(picked));
            }),
        }
        Box::pin(async move {
            Ok(picked
                .await
                .ok()
                .flatten()
                .filter(|paths| !paths.is_empty()))
        })
    }

    /// Electron opens a modal prompt window; here the parent window's page shows the same
    /// prompt as a dialog of its own and answers through `pi_prompt_answer`.
    fn prompt_text(
        &self,
        parent: Option<WindowId>,
        request: PromptText,
    ) -> LocalFuture<CoreResult<Option<String>>> {
        let windows = self.windows();
        let Some(window) = parent
            .filter(|window| windows.contains(window))
            .or(self.focused.get())
            .or_else(|| windows.first().copied())
        else {
            return Box::pin(std::future::ready(Err(CoreError::new(
                "Main window is not available for login.",
            ))));
        };
        self.show_window(window);
        let id = self.next_prompt.get() + 1;
        self.next_prompt.set(id);
        let (reply, answer) = oneshot::channel();
        self.prompts
            .borrow_mut()
            .insert(id, OpenPrompt { window, reply });
        let prompt = json!({
            "id": id,
            "message": request.message,
            "placeholder": request.placeholder,
        });
        self.shared
            .send(window, TEXT_PROMPT_CHANNEL, &prompt.to_string());
        // A prompt dropped unanswered (its window closing or reloading) counts as cancelled.
        Box::pin(async move { Ok(answer.await.unwrap_or(None)) })
    }

    /// `dialog.showMessageBox(window, { message })`.
    fn show_message(
        &self,
        parent: Option<WindowId>,
        message: String,
    ) -> LocalFuture<CoreResult<()>> {
        let mut dialog = self
            .app
            .dialog()
            .message(message)
            .title("pi")
            .kind(MessageDialogKind::Info);
        if let Some(parent) = parent.and_then(|parent| self.webview_window(parent)) {
            dialog = dialog.parent(&parent);
        }
        let (done, closed) = oneshot::channel();
        dialog.show(move |_| {
            let _ = done.send(());
        });
        Box::pin(async move {
            let _ = closed.await;
            Ok(())
        })
    }

    fn open_external(&self, url: String) -> LocalFuture<CoreResult<()>> {
        let result = self
            .app
            .opener()
            .open_url(url.clone(), None::<&str>)
            .map_err(|error| CoreError::new(format!("Failed to open {url}: {error}")));
        Box::pin(std::future::ready(result))
    }

    fn reveal_path(&self, path: PathBuf, open: bool) -> LocalFuture<CoreResult<()>> {
        let opener = self.app.opener();
        let result = if open {
            opener.open_path(path.to_string_lossy(), None::<&str>)
        } else {
            opener.reveal_item_in_dir(&path)
        };
        let result = result.map_err(|error| CoreError::new(error.to_string()));
        Box::pin(std::future::ready(result))
    }

    fn toggle_maximize(&self, window: WindowId) {
        let Some(window) = self.webview_window(window) else {
            return;
        };
        let _ = if window.is_maximized().unwrap_or(false) {
            window.unmaximize()
        } else {
            window.maximize()
        };
    }

    fn relaunch(&self) {
        // Goes through the same exit request as quitting, so drafts and state are saved first.
        self.app.request_restart();
    }

    /// Electron's `Notification`: shown from a thread of its own, which waits for a click on
    /// it and hands the click to the kernel. Test runs only log it, as Electron's do.
    fn notify(&self, notification: Value) -> LocalFuture<CoreResult<()>> {
        if self.test_mode {
            return Box::pin(std::future::ready(Ok(())));
        }
        let session_ref =
            match serde_json::from_value::<SessionRef>(notification["sessionRef"].clone()) {
                Ok(session_ref) => session_ref,
                Err(error) => {
                    return Box::pin(std::future::ready(Err(CoreError::new(format!(
                        "Invalid notification sessionRef: {error}"
                    )))))
                }
            };
        let text = |name: &str| notification[name].as_str().unwrap_or_default().to_owned();
        let mut native = notify_rust::Notification::new();
        native
            .summary(&text("title"))
            .body(&text("body"))
            .action("default", "Open");
        let generation = self.next_notification.get() + 1;
        self.next_notification.set(generation);
        let shown = ShownBy {
            key: session_key(&session_ref),
            generation,
            active: self.notifications.clone(),
        };
        let handle = self.handle.clone();
        let spawned = std::thread::Builder::new()
            .name("pi-gui-notification".into())
            .spawn(move || {
                if shown.show_and_wait(&native) {
                    handle.send(KernelMsg::NotificationClicked(session_ref));
                }
            });
        if let Err(error) = spawned {
            eprintln!("[notification-manager] could not show a notification: {error}");
        }
        Box::pin(std::future::ready(Ok(())))
    }

    fn close_notification(&self, session_ref: &SessionRef) {
        let entry = self
            .notifications
            .lock()
            .unwrap()
            .remove(&session_key(session_ref));
        #[cfg(all(unix, not(target_os = "macos")))]
        if let Some((_, shown)) = entry {
            // Closing talks to the notification server, so not on the kernel thread.
            let _ = std::thread::Builder::new()
                .name("pi-gui-notification".into())
                .spawn(move || shown.close());
        }
        // macOS and Windows take a clicked notification down themselves; an unclicked one
        // stays in their notification centre, and its click is ignored once it is stale.
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        let _ = entry;
    }

    /// Restores, shows and focuses the window, as a notification click does.
    fn show_window(&self, window: WindowId) {
        crate::windows::bring_to_front(&self.app, window);
    }

    fn notification_permission(&self, operation: &str) -> LocalFuture<CoreResult<Value>> {
        let state = |state: tauri_plugin_notification::Result<PermissionState>| {
            state
                .map(|state| {
                    json!(match state {
                        PermissionState::Granted => "granted",
                        PermissionState::Denied => "denied",
                        _ => "default",
                    })
                })
                .map_err(|error| CoreError::new(error.to_string()))
        };
        let result = match operation {
            "status" => state(self.app.notification().permission_state()),
            "request" => state(self.app.notification().request_permission()),
            "openSettings" => Ok(Value::Null),
            other => Err(CoreError::new(format!(
                "Unknown notification permission call: {other}"
            ))),
        };
        Box::pin(std::future::ready(result))
    }

    fn read_clipboard_image(&self) -> Value {
        match self.app.clipboard().read_image() {
            Ok(image) => clipboard_image_attachment(image.width(), image.height(), image.rgba()),
            Err(_) => json!({ "ok": false }),
        }
    }

    /// The native chrome follows the theme mode, and the colour behind the page follows the
    /// preset and the resolved theme.
    fn set_appearance(&self, appearance: Value) {
        *self.appearance.borrow_mut() = appearance;
        for window in self.windows() {
            self.apply_appearance(window);
        }
    }

    fn system_theme_dark(&self) -> bool {
        self.system_dark.get()
    }

    /// WebView2 cannot load custom schemes in frames, so on Windows the scheme is served as
    /// `http://pi-extension.localhost/<connectionId>/`, which is where Tauri puts it.
    #[cfg(windows)]
    fn extension_frame_url(&self, frame_url: String) -> String {
        crate::windows::webview_frame_url(&frame_url).unwrap_or(frame_url)
    }
}

/// One shown notification's place in `ActiveNotifications`.
struct ShownBy {
    key: String,
    generation: u64,
    active: ActiveNotifications,
}

impl ShownBy {
    /// Shows the notification and waits for it to be clicked or closed. True for a click on
    /// the thread's latest notification.
    fn show_and_wait(self, native: &notify_rust::Notification) -> bool {
        let shown = match native.show() {
            Ok(shown) => shown,
            Err(error) => {
                eprintln!("[notification-manager] could not show a notification: {error}");
                return false;
            }
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let clicked = self.wait(shown);
        // macOS and Windows have no handle to close by, only the wait.
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        let clicked = {
            self.active
                .lock()
                .unwrap()
                .insert(self.key.clone(), (self.generation, ()));
            let mut clicked = false;
            shown.wait_for_action(|action| clicked = action != "__closed");
            clicked
        };
        let mut active = self.active.lock().unwrap();
        // Taken down meanwhile, or replaced by a newer one: the click is stale.
        let current = active
            .get(&self.key)
            .is_some_and(|(generation, _)| *generation == self.generation);
        if current {
            active.remove(&self.key);
        }
        clicked && current
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn wait(&self, shown: notify_rust::NotificationHandle) -> bool {
        let id = shown.id();
        self.active
            .lock()
            .unwrap()
            .insert(self.key.clone(), (self.generation, shown));
        let mut clicked = false;
        let _ = notify_rust::handle_action(id, |response| {
            clicked = matches!(response, notify_rust::ActionResponse::Custom(_));
        });
        clicked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip() {
        assert_eq!(label(7), "w7");
        assert_eq!(window_id("w7"), Some(7));
        assert_eq!(window_id("main"), None);
    }

    #[test]
    fn clipboard_images_become_png_attachments() {
        let empty = clipboard_image_attachment(0, 0, &[]);
        assert_eq!(empty, json!({ "ok": false }));
        let pixel = clipboard_image_attachment(1, 1, &[255, 0, 0, 255]);
        assert_eq!(pixel["ok"], true);
        assert_eq!(pixel["attachment"]["mimeType"], "image/png");
        let too_wide = clipboard_image_attachment(COMPOSER_IMAGE_MAX_DIMENSION + 1, 1, &[]);
        assert_eq!(too_wide["ok"], false);
    }
}
