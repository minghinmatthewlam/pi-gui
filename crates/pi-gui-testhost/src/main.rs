//! `pi-gui-testhost`: the Rust app-state kernel with no native windows, for Playwright. One
//! port serves the built renderer over HTTP and a WebSocket. Each page that loads with
//! `?testhost=ws://…` connects as a window; specs connect as a control client for the `test.*`
//! calls. pi runs in the real pi host and saved data in the real core, as under Electron.
//!
//! Environment, matching what Electron main reads:
//! - `PI_APP_USER_DATA_DIR` (required), `PI_APP_INITIAL_WORKSPACES`, `PI_APP_TEST_MODE`.
//! - `PI_GUI_TESTHOST_PORT` (default 0: any free port), `PI_GUI_TESTHOST_RENDERER_DIR`,
//!   `PI_GUI_TESTHOST_PI_HOST` (the built `pi-host.js`) and `PI_GUI_TESTHOST_NODE`.
//!
//! The first line on stdout is `pi-gui-testhost listening on http://127.0.0.1:<port>`.

mod http;
mod session;

use pi_gui_core::app::pi::{HostLaunch, HostPiDriver};
use pi_gui_core::app::shell::TestShell;
use pi_gui_core::app::{Kernel, KernelDeps};
use pi_gui_core::error::CoreError;
use pi_gui_core::rpc::{Peer, Service};
use pi_gui_core::state::env::SystemEnv;
use pi_gui_core::Core;
use serde_json::json;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

/// What every connection shares.
pub struct App {
    pub kernel: Rc<Kernel>,
    pub shell: Rc<TestShell>,
    pub driver: Rc<HostPiDriver>,
    pub core: Rc<Core>,
    pub renderer_dir: PathBuf,
    pub test_mode: bool,
    pub windows: session::Windows,
    /// Set by `test.quit`; the accept loop stops once it fires.
    pub quit: tokio::sync::Notify,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The desktop app folder: next to the crates, as the repository lays them out.
fn desktop_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop")
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let local = tokio::task::LocalSet::new();
    if let Err(error) = local.block_on(&runtime, run()) {
        eprintln!("[pi-gui-testhost] stopped: {}", error.message);
        std::process::exit(1);
    }
}

async fn run() -> Result<(), CoreError> {
    let user_data_dir = env_path("PI_APP_USER_DATA_DIR")
        .ok_or_else(|| CoreError::new("PI_APP_USER_DATA_DIR is required"))?;
    let test_mode_value = std::env::var("PI_APP_TEST_MODE").unwrap_or_default();
    let test_mode = !test_mode_value.is_empty();
    let separator = if cfg!(windows) { ';' } else { ':' };
    let initial_workspace_paths = std::env::var("PI_APP_INITIAL_WORKSPACES")
        .unwrap_or_default()
        .split(separator)
        .filter(|path| !path.trim().is_empty())
        .map(str::to_owned)
        .collect();
    let renderer_dir = env_path("PI_GUI_TESTHOST_RENDERER_DIR")
        .unwrap_or_else(|| desktop_dir().join("out/renderer"));
    let host_script = env_path("PI_GUI_TESTHOST_PI_HOST")
        .unwrap_or_else(|| desktop_dir().join("out/main/pi-host.js"));
    let node = env_path("PI_GUI_TESTHOST_NODE").unwrap_or_else(|| PathBuf::from("node"));
    let port: u16 = std::env::var("PI_GUI_TESTHOST_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(0);

    // The core, in process. Its notifications are for the terminal, which is not ported.
    let (peer, mut core_lines) = Peer::new();
    tokio::task::spawn_local(async move { while core_lines.recv().await.is_some() {} });
    let core = Core::new(peer);
    core.clone()
        .call(
            pi_gui_core::methods::INITIALIZE.to_owned(),
            json!({ "userDataDir": user_data_dir }),
        )
        .await?;

    let driver = HostPiDriver::start(HostLaunch {
        node,
        script: host_script,
        env: std::env::vars().collect(),
    })
    .await?;
    let shell = TestShell::new(test_mode_value == "background");
    let kernel = Kernel::new(KernelDeps {
        core: core.clone(),
        driver: driver.clone(),
        shell: shell.clone(),
        env: Rc::new(SystemEnv::new()),
        user_data_dir,
        initial_workspace_paths,
        test_mode,
    });
    driver.set_host_calls(kernel.host_calls());
    kernel.start().await;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| CoreError::new(format!("Could not listen: {error}")))?;
    let address = listener
        .local_addr()
        .map_err(|error| CoreError::new(error.to_string()))?;
    println!("pi-gui-testhost listening on http://{address}");

    let app = Rc::new(App {
        kernel,
        shell,
        driver,
        core,
        renderer_dir,
        test_mode,
        windows: Default::default(),
        quit: tokio::sync::Notify::new(),
    });
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| CoreError::new(error.to_string()))?;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let app = app.clone();
                tokio::task::spawn_local(async move { http::serve(app, stream).await });
            }
            _ = app.quit.notified() => break,
            _ = terminate.recv() => break,
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    shutdown(&app).await;
    Ok(())
}

/// What Electron's `before-quit` does: windows flush their drafts, state is saved, then pi and
/// the core stop.
pub async fn shutdown(app: &App) {
    app.kernel.prepare_quit().await;
    app.driver.stop(Duration::from_secs(5)).await;
    let _ = app
        .core
        .clone()
        .call(pi_gui_core::methods::SHUTDOWN.to_owned(), json!({}))
        .await;
}
