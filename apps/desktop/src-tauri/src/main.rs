//! `pi-gui`: the Tauri app. The Rust app-state kernel runs in process on its own thread, pi
//! runs in the Node pi host, and the React renderer runs in the system webview with
//! `window.piApp` over Tauri commands.
//!
//! Environment, matching what Electron main reads: `PI_APP_USER_DATA_DIR`,
//! `PI_APP_INITIAL_WORKSPACES` and `PI_APP_TEST_MODE`; plus `PI_GUI_NODE` (default `node`) and
//! `PI_GUI_PI_HOST` (default: the built `out/main/pi-host.js` next to this crate).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod kernel;
mod menu;
mod shell;
mod windows;

use kernel::{KernelHandle, KernelMsg, Launch};
use std::path::PathBuf;
use tauri::{Manager, RunEvent};

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The desktop app folder, as the repository lays it out.
fn desktop_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn launch(app: &tauri::AppHandle) -> Result<Launch, String> {
    // The packaged Electron app's folder (`productName: pi-gui`), so saved threads carry over.
    let user_data_dir = match env_path("PI_APP_USER_DATA_DIR") {
        Some(path) => path,
        None => app
            .path()
            .config_dir()
            .map_err(|error| error.to_string())?
            .join("pi-gui"),
    };
    let test_mode = std::env::var("PI_APP_TEST_MODE").unwrap_or_default();
    let separator = if cfg!(windows) { ';' } else { ':' };
    let initial_workspace_paths = std::env::var("PI_APP_INITIAL_WORKSPACES")
        .unwrap_or_default()
        .split(separator)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(Launch {
        user_data_dir,
        initial_workspace_paths,
        test_mode: matches!(test_mode.as_str(), "foreground" | "background"),
        background: test_mode == "background",
        node: env_path("PI_GUI_NODE").unwrap_or_else(|| PathBuf::from("node")),
        host_script: env_path("PI_GUI_PI_HOST")
            .unwrap_or_else(|| desktop_dir().join("out/main/pi-host.js")),
    })
}

fn main() {
    let app = tauri::Builder::default()
        // First, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app.state::<KernelHandle>().send(KernelMsg::SecondInstance);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(windows::DroppedPaths::default())
        .invoke_handler(tauri::generate_handler![
            commands::pi_bootstrap,
            commands::pi_connect,
            commands::pi_invoke,
            commands::pi_window_command,
            commands::pi_dropped_file,
        ])
        .register_asynchronous_uri_scheme_protocol(
            windows::EXTENSION_SCHEME,
            |context, request, responder| {
                let url = request.uri().to_string();
                context
                    .app_handle()
                    .state::<KernelHandle>()
                    .send(KernelMsg::ViewAsset { url, responder });
            },
        )
        .on_window_event(windows::on_window_event)
        .setup(|app| {
            let launch = launch(app.handle())?;
            let handle = kernel::spawn(app.handle().clone(), launch);
            app.manage(handle);
            menu::install(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app builds");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { code, api, .. } => {
            let handle = app.state::<KernelHandle>();
            if handle.quit.is_done() {
                return;
            }
            // macOS keeps the app running with no windows, except in test runs.
            if cfg!(target_os = "macos")
                && code.is_none()
                && std::env::var_os("PI_APP_TEST_MODE").is_none()
            {
                api.prevent_exit();
                return;
            }
            api.prevent_exit();
            if handle.quit.begin() {
                handle.send(KernelMsg::Quit);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            app.state::<KernelHandle>()
                .send(KernelMsg::NewWindow { source: None });
        }
        RunEvent::MenuEvent(event) => menu::on_menu_event(app, &event),
        _ => {}
    });
}
