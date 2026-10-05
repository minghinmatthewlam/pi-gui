//! The macOS application menu, as Electron main's `installApplicationMenu`. Windows and Linux
//! have none there either: their window shortcuts come from the renderer
//! (`pi_window_command`), and the renderer handles the rest itself.

use crate::kernel::{KernelHandle, KernelMsg};
use crate::shell::window_id;
use pi_gui_core::app::methods::push;
use tauri::menu::MenuEvent;
use tauri::{AppHandle, Manager};

const NEW_THREAD: &str = "new-thread";
const NEW_WINDOW: &str = "new-window";
const OPEN_FOLDER: &str = "open-folder";
const RELOAD: &str = "reload";
const QUIT: &str = "quit";

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "pi")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        // Our own item, so quitting goes through the same save-then-exit path as any exit.
        .item(
            &MenuItemBuilder::with_id(QUIT, "Quit pi")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id(NEW_THREAD, "New Thread")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(NEW_WINDOW, "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(OPEN_FOLDER, "Open Folder…")
                .accelerator("Cmd+O")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    // Cmd+R toggles Review and Shift+Cmd+R renames the thread, so reload has no shortcut.
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id(RELOAD, "Reload").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

/// The focused app window, else any.
fn focused_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| windows.values().next())
        .cloned()
}

pub fn on_menu_event(app: &AppHandle, event: &MenuEvent) {
    let handle = app.state::<KernelHandle>();
    let focused = focused_window(app);
    let focused_id = focused
        .as_ref()
        .and_then(|window| window_id(window.label()));
    match event.id().as_ref() {
        NEW_THREAD => {
            if let Some(window) = focused_id {
                let command = serde_json::to_string("open-new-thread").unwrap_or_default();
                handle.shared.send(window, push::APP_COMMAND, &command);
            }
        }
        NEW_WINDOW => handle.send(KernelMsg::NewWindow { source: focused_id }),
        OPEN_FOLDER => {
            if let Some(window) = focused_id {
                handle.send(KernelMsg::OpenFolder(window));
            }
        }
        RELOAD => {
            if let Some(window) = focused {
                let _ = window.reload();
            }
        }
        QUIT => app.exit(0),
        _ => {}
    }
}
