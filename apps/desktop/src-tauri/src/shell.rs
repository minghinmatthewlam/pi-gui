//! `TauriShell`: the kernel's `Shell` over native Tauri windows, dialogs, the clipboard,
//! notifications and the system opener. It lives on the kernel thread; what the main thread
//! also needs (each window's push channel) sits in `SharedWindows`.

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
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Theme};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
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

pub struct TauriShell {
    app: AppHandle,
    shared: Arc<SharedWindows>,
    /// Open windows, oldest first, as their events last reported them.
    windows: RefCell<IndexMap<WindowId, WindowPresence>>,
    focused: Cell<Option<WindowId>>,
}

impl TauriShell {
    pub fn new(app: AppHandle, shared: Arc<SharedWindows>) -> Self {
        Self {
            app,
            shared,
            windows: RefCell::new(IndexMap::new()),
            focused: Cell::new(None),
        }
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

    fn prompt_text(
        &self,
        _parent: Option<WindowId>,
        request: PromptText,
    ) -> LocalFuture<CoreResult<Option<String>>> {
        // Electron opens its own prompt window; here it becomes a dialog in the renderer,
        // which is not built yet.
        Box::pin(std::future::ready(Err(CoreError::new(format!(
            "Text prompts are not available in the Tauri app yet: {}",
            request.message
        )))))
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

    fn notify(&self, notification: Value) -> LocalFuture<CoreResult<()>> {
        let text = |name: &str| notification[name].as_str().unwrap_or_default().to_owned();
        let result = self
            .app
            .notification()
            .builder()
            .title(text("title"))
            .body(text("body"))
            .show()
            .map_err(|error| CoreError::new(error.to_string()));
        Box::pin(std::future::ready(result))
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

    fn set_appearance(&self, appearance: Value) {
        let theme = match appearance["themeMode"].as_str() {
            Some("dark") => Some(Theme::Dark),
            Some("light") => Some(Theme::Light),
            _ => None,
        };
        for window in self.windows() {
            if let Some(window) = self.webview_window(window) {
                let _ = window.set_theme(theme);
            }
        }
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
