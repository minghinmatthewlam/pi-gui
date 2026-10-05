//! Native app windows: creating them the way Electron's `createWindow` does, keeping
//! navigation inside the app, and turning window events into kernel messages.

use crate::kernel::{KernelHandle, KernelMsg};
use crate::shell::{label, window_id};
use pi_gui_core::app::shell::WindowPresence;
use pi_gui_core::app::WindowId;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, DragDropEvent, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

/// The custom scheme extension views load from, as under Electron.
pub const EXTENSION_SCHEME: &str = "pi-extension";

/// The app's own pages: `tauri://localhost` on Linux and macOS, `http://tauri.localhost` on
/// Windows.
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// What a webview may navigate to. WebKitGTK asks for frames too, so extension views (and
/// blank frames) are allowed; everything else stays out of the app. Web links reach the
/// browser through `openExternal` or a new-window request, never a navigation, so a frame
/// cannot open one on its own.
pub fn allows_navigation(url: &Url) -> bool {
    is_app_url(url)
        || url.scheme() == EXTENSION_SCHEME
        || matches!(url.as_str(), "about:blank" | "about:srcdoc")
}

/// `openExternalWebUrl`: http and https only.
fn open_external_web_url(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().unwrap_or("").is_empty() {
        return;
    }
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("Failed to open external URL: {url} {error}");
    }
}

/// Electron's `createWindow`: the same size limits, hidden in background test mode.
pub fn create(app: &AppHandle, window: WindowId, visible: bool) -> tauri::Result<()> {
    let links = app.clone();
    let builder =
        WebviewWindowBuilder::new(app, label(window), WebviewUrl::App("index.html".into()))
            .title("pi")
            .inner_size(1480.0, 980.0)
            .min_inner_size(560.0, 600.0)
            .visible(visible)
            .on_navigation(allows_navigation)
            .on_new_window(move |url, _features| {
                if !is_app_url(&url) {
                    open_external_web_url(&links, &url);
                }
                NewWindowResponse::Deny
            });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 18.0));
    let native = builder.build()?;
    if visible {
        let _ = native.set_focus();
    }
    Ok(())
}

/// `second-instance`: restore, show and focus.
pub fn bring_to_front(app: &AppHandle, window: WindowId) {
    let Some(native) = app.get_webview_window(&label(window)) else {
        return;
    };
    if native.is_minimized().unwrap_or(false) {
        let _ = native.unminimize();
    }
    let _ = native.show();
    let _ = native.set_focus();
}

/// Paths each window was last given by a drop: the only files its page may read back.
#[derive(Default)]
pub struct DroppedPaths(Mutex<HashMap<WindowId, HashSet<PathBuf>>>);

impl DroppedPaths {
    pub fn contains(&self, window: WindowId, path: &PathBuf) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(&window)
            .is_some_and(|paths| paths.contains(path))
    }

    fn set(&self, window: WindowId, paths: &[PathBuf]) {
        self.0
            .lock()
            .unwrap()
            .insert(window, paths.iter().cloned().collect());
    }

    fn forget(&self, window: WindowId) {
        self.0.lock().unwrap().remove(&window);
    }
}

fn presence(window: &tauri::Window) -> WindowPresence {
    WindowPresence {
        visible: window.is_visible().unwrap_or(false),
        minimized: window.is_minimized().unwrap_or(false),
        focused: window.is_focused().unwrap_or(false),
    }
}

/// Runs on the main thread for every window event.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let Some(id) = window_id(window.label()) else {
        return;
    };
    let app = window.app_handle();
    let handle = app.state::<KernelHandle>();
    match event {
        WindowEvent::Focused(_) | WindowEvent::Resized(_) => {
            handle.send(KernelMsg::Presence {
                window: id,
                presence: presence(window),
            });
        }
        WindowEvent::CloseRequested { api, .. } => {
            // Quit saves every window's draft before any window closes, then closes them all.
            if handle.quit.is_flushing() {
                api.prevent_close();
                return;
            }
            if handle.quit.is_done() || handle.windows_closing.lock().unwrap().remove(&id) {
                return;
            }
            // Otherwise hold the close until the renderer sends its debounced draft.
            api.prevent_close();
            handle.send(KernelMsg::CloseRequested(id));
        }
        WindowEvent::Destroyed => {
            app.state::<DroppedPaths>().forget(id);
            handle.send(KernelMsg::Destroyed(id));
        }
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
            app.state::<DroppedPaths>().set(id, paths);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn navigation_stays_in_the_app() {
        assert!(allows_navigation(&url("tauri://localhost/index.html")));
        assert!(allows_navigation(&url("http://tauri.localhost/index.html")));
        assert!(allows_navigation(&url("pi-extension://abc/")));
        assert!(allows_navigation(&url("about:blank")));
        assert!(!allows_navigation(&url("https://example.com/")));
        assert!(!allows_navigation(&url("file:///etc/passwd")));
        assert!(!allows_navigation(&url("tauri://elsewhere/")));
    }
}
