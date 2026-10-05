//! The app state kernel: what Electron main's `DesktopAppStore`, `WindowOwner` and IPC
//! registration do, in Rust. One `Kernel` owns the state in a `RefCell`; renderer calls come in
//! through `dispatch`, pi's session events through `events`, and state goes out through
//! `publish`. It runs on one thread with a local executor, like Node, so a call runs until
//! its first `.await`, and no `RefCell` borrow may be held across one.
//!
//! Each part of the app keeps its handlers, state and helpers in its own module
//! (`conversation`, `workspace`, `review`, `settings`, `extensions`, `orchestration`,
//! `scheduled`, `notifications`). The shared modules call into a part only through the named
//! free functions that part exposes, so parts never edit `events` or `refresh`.

#![deny(clippy::await_holding_refcell_ref)]

pub mod conversation;
pub mod dispatch;
pub mod events;
pub mod extensions;
pub mod methods;
pub mod notifications;
pub mod orchestration;
pub mod persist;
pub mod pi;
pub mod publish;
pub mod refresh;
pub mod review;
pub mod scheduled;
pub mod sessions;
pub mod settings;
pub mod shell;
pub mod test_hooks;
pub mod ui;
pub mod validation;
pub mod windows;
pub mod workspace;

use crate::error::{CoreError, CoreResult};
use crate::persistence::catalog::{SessionEntry, WorkspaceEntry, WorktreeEntry};
use crate::rpc::{LocalFuture, Service};
use crate::state::app_store_utils::SessionMap;
use crate::state::desktop_state::{
    create_empty_desktop_app_state, DesktopAppState, StartupDiagnostic, StartupDiagnosticScope,
};
use crate::state::driver::{
    session_key, ExtensionFlagValues, RuntimeSnapshot, SessionRef, SessionSchemaInfo, WorkspaceRef,
};
use crate::state::env::StateEnv;
use crate::state::extension_command_compatibility::{
    CompatibilityByWorkspace, PendingRuntimeCommandExecution,
};
use crate::state::session_state_map::SessionStateMap;
use crate::Core;
use indexmap::IndexMap;
use pi::PiDriver;
use serde::Deserialize;
use serde_json::{json, Value};
use shell::Shell;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::rc::{Rc, Weak};
use tokio::task::AbortHandle;

/// A renderer window. Ids are given out by the shell and never reused while it runs.
pub type WindowId = u32;

/// What the kernel runs against.
pub struct KernelDeps {
    pub core: Rc<Core>,
    pub driver: Rc<dyn PiDriver>,
    pub shell: Rc<dyn Shell>,
    pub env: Rc<dyn StateEnv>,
    pub user_data_dir: PathBuf,
    /// `PI_APP_INITIAL_WORKSPACES`.
    pub initial_workspace_paths: Vec<String>,
    /// `PI_APP_TEST_MODE` is set: the `test.*` calls answer.
    pub test_mode: bool,
}

/// Whether ui-state may be written (`persistenceReadiness`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Pending,
    Ready,
    /// The saved state could not be read; writing now would lose it.
    Blocked,
}

/// Everything the TypeScript store keeps besides `state`, by the same names.
pub struct AppData {
    pub state: DesktopAppState,
    pub sessions: SessionStateMap,
    pub runtime_by_workspace: IndexMap<String, RuntimeSnapshot>,
    pub extension_flags_by_workspace: IndexMap<String, ExtensionFlagValues>,
    pub disabled_builtin_extensions: BTreeSet<String>,
    /// Decoded `TaskWorkbenchTemplate`s by session key.
    pub task_workbench_templates_by_session: IndexMap<String, Value>,
    pub compatibility_by_workspace: CompatibilityByWorkspace,
    pub pending_runtime_commands: SessionMap<PendingRuntimeCommandExecution>,
    pub reported_compatibility_issues: SessionMap<HashSet<String>>,
    pub session_schema_info: SessionMap<SessionSchemaInfo>,
    pub session_schema_info_in_flight: HashSet<String>,
    /// `mtimeMs` and size of each selected transcript's file when it was last read.
    pub selected_transcript_file_stats: HashMap<String, (f64, u64)>,
    pub settings_file_mtimes: IndexMap<PathBuf, f64>,
    pub composer_draft_sync_target: Option<SessionRef>,
    pub composer_draft_projection_nonce: f64,
    pub persistence: Readiness,
    pub scheduled_tasks_writable: bool,
    pub restored_selected_keys_awaiting_selection: HashSet<String>,
    /// Dialog timeouts and notice expiries, by `<sessionKey>:<requestId>`.
    pub extension_dialog_timers: HashMap<String, AbortHandle>,
    /// Coalesced command refreshes in flight, by session key: whether another is wanted.
    pub session_command_refreshers: HashMap<String, bool>,
    pub conversation: conversation::ConversationState,
    pub workspace: workspace::WorkspaceState,
    pub settings: settings::SettingsState,
    pub extensions: extensions::ExtensionsState,
    pub orchestration: orchestration::OrchestrationState,
    pub scheduled: scheduled::ScheduledState,
    pub notifications: notifications::NotificationsState,
    pub ui: ui::UiState,
}

impl AppData {
    fn new() -> Self {
        Self {
            state: create_empty_desktop_app_state(),
            sessions: SessionStateMap::new(),
            runtime_by_workspace: IndexMap::new(),
            extension_flags_by_workspace: IndexMap::new(),
            disabled_builtin_extensions: BTreeSet::new(),
            task_workbench_templates_by_session: IndexMap::new(),
            compatibility_by_workspace: CompatibilityByWorkspace::new(),
            pending_runtime_commands: SessionMap::new(),
            reported_compatibility_issues: SessionMap::new(),
            session_schema_info: SessionMap::new(),
            session_schema_info_in_flight: HashSet::new(),
            selected_transcript_file_stats: HashMap::new(),
            settings_file_mtimes: IndexMap::new(),
            composer_draft_sync_target: None,
            composer_draft_projection_nonce: 0.0,
            persistence: Readiness::Pending,
            scheduled_tasks_writable: false,
            restored_selected_keys_awaiting_selection: HashSet::new(),
            extension_dialog_timers: HashMap::new(),
            session_command_refreshers: HashMap::new(),
            conversation: Default::default(),
            workspace: Default::default(),
            settings: Default::default(),
            extensions: Default::default(),
            orchestration: Default::default(),
            scheduled: Default::default(),
            notifications: Default::default(),
            ui: Default::default(),
        }
    }

    /// `sessionFromState`.
    pub fn session(
        &self,
        session_ref: &SessionRef,
    ) -> Option<&crate::state::desktop_state::SessionRecord> {
        self.state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == session_ref.workspace_id)?
            .sessions
            .iter()
            .find(|session| session.id == session_ref.session_id)
    }

    /// `selectedSessionRef`.
    pub fn selected_session_ref(&self) -> Option<SessionRef> {
        let state = &self.state;
        (!state.selected_workspace_id.is_empty() && !state.selected_session_id.is_empty()).then(
            || {
                crate::state::driver::session_ref(
                    &state.selected_workspace_id,
                    &state.selected_session_id,
                )
            },
        )
    }

    /// `currentSelectedSessionKey`.
    pub fn selected_session_key(&self) -> String {
        self.selected_session_ref()
            .map(|session_ref| session_key(&session_ref))
            .unwrap_or_default()
    }

    /// `isSelectedSession`.
    pub fn is_selected(&self, session_ref: &SessionRef) -> bool {
        self.state.selected_workspace_id == session_ref.workspace_id
            && self.state.selected_session_id == session_ref.session_id
            && !session_ref.workspace_id.is_empty()
            && !session_ref.session_id.is_empty()
    }

    /// `workspaceRefFromState`.
    pub fn workspace_ref(&self, workspace_id: &str) -> Option<WorkspaceRef> {
        self.state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .map(|workspace| WorkspaceRef {
                workspace_id: workspace.id.clone(),
                path: workspace.path.clone(),
                display_name: Some(workspace.name.clone()),
            })
    }

    /// Bumps `state.revision` as a mutation site does.
    pub fn bump(&mut self) {
        self.state.revision.0 += 1.0;
    }
}

/// The app state kernel. Build it with `Kernel::new`, connect windows through `windows`, and
/// answer renderer calls with `dispatch::invoke`.
pub struct Kernel {
    pub deps: KernelDeps,
    pub data: RefCell<AppData>,
    pub windows: windows::views::WindowViews,
    pub queue: windows::queue::ActionQueue,
    pub draft_flush: windows::draft_flush::DraftFlusher,
    pub publisher: publish::Publisher,
    pub refresh: refresh::RefreshQueue,
    pub events: events::SessionEventQueues,
    pub saves: persist::Saves,
    pub methods: dispatch::MethodTable,
    pub test: test_hooks::TestControls,
    pub workbench: review::WorkbenchRequests,
    init: tokio::sync::OnceCell<()>,
    stopping: Cell<bool>,
    this: Weak<Kernel>,
}

impl Kernel {
    /// Must be created inside a `LocalSet`: timers and session events run as local tasks.
    pub fn new(deps: KernelDeps) -> Rc<Self> {
        let kernel = Rc::new_cyclic(|this| Self {
            deps,
            data: RefCell::new(AppData::new()),
            windows: Default::default(),
            queue: Default::default(),
            draft_flush: Default::default(),
            publisher: Default::default(),
            refresh: Default::default(),
            events: Default::default(),
            saves: Default::default(),
            methods: dispatch::MethodTable::build(),
            test: Default::default(),
            workbench: Default::default(),
            init: tokio::sync::OnceCell::new(),
            stopping: Cell::new(false),
            this: this.clone(),
        });
        let weak = kernel.this.clone();
        kernel
            .deps
            .driver
            .set_config_source(Box::new(move || match weak.upgrade() {
                Some(kernel) => sessions::pi_host_config(&kernel.data.borrow()),
                None => pi::PiHostConfig {
                    disabled_builtin_extensions: Vec::new(),
                    extension_flags: Default::default(),
                },
            }));
        kernel
    }

    /// A strong handle, for work that outlives the current call.
    pub fn rc(&self) -> Rc<Self> {
        self.this
            .upgrade()
            .expect("the kernel is alive while it runs")
    }

    pub fn env(&self) -> &dyn StateEnv {
        self.deps.env.as_ref()
    }

    pub fn driver(&self) -> &dyn PiDriver {
        self.deps.driver.as_ref()
    }

    pub fn shell(&self) -> &dyn Shell {
        self.deps.shell.as_ref()
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.get()
    }

    /// Calls the in-process core, as Electron main's `core.request` did.
    pub async fn core_call(&self, method: &str, params: Value) -> CoreResult<Value> {
        self.deps.core.clone().call(method.to_owned(), params).await
    }

    /// `catalogStore.<path>(...args)` through the core's `catalog.call`.
    pub async fn catalog_call(&self, path: &str, args: Vec<Value>) -> CoreResult<Option<Value>> {
        let result = self
            .core_call(
                crate::methods::CATALOG_CALL,
                json!({ "path": path, "args": args }),
            )
            .await?;
        Ok(pi::decode_result(result))
    }

    /// `initialize`: runs once; every later call waits for the first.
    pub async fn initialize(&self) {
        let kernel = self.rc();
        self.init
            .get_or_init(|| async move { initialize_internal(&kernel).await })
            .await;
    }

    /// What main does once its windows exist: load the saved state, then point the theme at
    /// the saved mode.
    pub async fn start(&self) {
        self.initialize().await;
        let mode = self.data.borrow().state.theme_mode;
        ui::set_theme_manager_mode(self, mode);
    }

    /// `flushPersistence`, before quitting.
    pub async fn flush_persistence(&self) -> CoreResult<()> {
        self.publisher.clear_streaming();
        self.initialize().await;
        persist::persist_ui_state(self).await?;
        scheduled::persist_scheduled_tasks(self).await
    }

    /// Asks the windows for their drafts, saves everything, and stops timers.
    pub async fn prepare_quit(&self) {
        let windows = self.windows.ids();
        self.draft_flush.flush(self, &windows).await;
        if let Err(error) = self.flush_persistence().await {
            eprintln!("[app-store] flushPersistence failed: {}", error.message);
        }
        self.stopping.set(true);
        self.saves.cancel();
        for (_, timer) in self.data.borrow_mut().extension_dialog_timers.drain() {
            timer.abort();
        }
    }

    /// The pi host's calls to the app (`app.catalog`, `app.captureBoundary`, `app.tool`).
    pub fn host_calls(&self) -> Rc<dyn pi::HostCalls> {
        Rc::new(KernelHostCalls {
            kernel: self.this.clone(),
        })
    }
}

/// Startup diagnostics the way `initializeInternal` reports a stopped startup.
fn stop_startup(kernel: &Kernel, diagnostics: &mut Vec<StartupDiagnostic>, error: &str) {
    let mut data = kernel.data.borrow_mut();
    data.state.startup_diagnostics = std::mem::take(diagnostics);
    data.state.last_error = Some(error.to_owned());
    data.bump();
    drop(data);
    publish::emit(kernel);
}

fn application_diagnostic(message: String) -> StartupDiagnostic {
    StartupDiagnostic {
        scope: StartupDiagnosticScope::Application,
        message,
        workspace_path: None,
    }
}

/// `initializeInternal`.
async fn initialize_internal(kernel: &Kernel) {
    let mut diagnostics = Vec::new();
    let persisted = match persist::read_ui_state(kernel).await {
        Ok(persisted) => persisted,
        Err(error) => {
            eprintln!("[app-store] persisted UI state is invalid; startup stopped");
            persist::block_persistence(kernel);
            diagnostics.push(application_diagnostic(error.message.clone()));
            stop_startup(kernel, &mut diagnostics, &error.message);
            return;
        }
    };
    if let Err(error) = persist::restore_persisted_ui_state(kernel, &persisted) {
        eprintln!("[app-store] persisted UI state restoration failed; startup stopped");
        persist::block_persistence(kernel);
        diagnostics.push(application_diagnostic(format!(
            "Persisted UI state could not be fully restored: {}",
            error.message
        )));
        stop_startup(kernel, &mut diagnostics, &error.message);
        return;
    }
    match conversation::validate_persisted_attachments(kernel).await {
        Ok(0) => {}
        Ok(skipped) => diagnostics.push(application_diagnostic(
            conversation::attachments::saved_skip_message(skipped),
        )),
        Err(error) => {
            eprintln!("[app-store] saved attachment validation failed; startup stopped");
            persist::block_persistence(kernel);
            diagnostics.push(application_diagnostic(format!(
                "Saved attachments could not be validated: {}",
                error.message
            )));
            stop_startup(kernel, &mut diagnostics, &error.message);
            return;
        }
    }
    match conversation::migrate_legacy_attachments(kernel, &persisted).await {
        Ok(0) => {}
        Ok(skipped) => diagnostics.push(application_diagnostic(
            conversation::attachments::saved_skip_message(skipped),
        )),
        Err(error) => {
            eprintln!("[app-store] legacy UI state migration failed; startup stopped");
            persist::block_persistence(kernel);
            diagnostics.push(application_diagnostic(format!(
                "Legacy UI state could not be fully migrated: {}",
                error.message
            )));
            stop_startup(kernel, &mut diagnostics, &error.message);
            return;
        }
    }
    kernel.data.borrow_mut().persistence = Readiness::Ready;

    if let Some(message) = scheduled::load_scheduled_tasks(kernel).await {
        diagnostics.push(application_diagnostic(format!(
            "Scheduled tasks could not be loaded: {message}"
        )));
    }

    if let Err(error) = startup_recovery(kernel, &persisted, &mut diagnostics).await {
        eprintln!("[app-store] startup recovery failed: {}", error.message);
        diagnostics.push(application_diagnostic(error.message.clone()));
        stop_startup(kernel, &mut diagnostics, &error.message);
    }
}

async fn startup_recovery(
    kernel: &Kernel,
    persisted: &persist::PersistedUiState,
    diagnostics: &mut Vec<StartupDiagnostic>,
) -> CoreResult<()> {
    let known = sessions::list_workspaces(kernel).await?;
    let mut to_sync: IndexMap<String, Option<String>> = IndexMap::new();
    for path in &kernel.deps.initial_workspace_paths {
        let path = path.trim();
        if !path.is_empty() {
            to_sync.insert(path.to_owned(), None);
        }
    }
    for workspace in known {
        to_sync.insert(workspace.path, Some(workspace.display_name));
    }
    let synced = futures_join_all(
        to_sync
            .into_iter()
            .map(|(path, display_name)| sync_startup_workspace(kernel, path, display_name)),
    )
    .await;
    diagnostics.extend(synced.into_iter().flatten());

    refresh::refresh_state(
        kernel,
        refresh::RefreshOptions {
            selected_workspace_id: persisted.selected_workspace_id.clone(),
            selected_session_id: persisted.selected_session_id.clone(),
            composer_draft: persisted.composer_draft.clone(),
            clear_last_error: true,
            refresh_worktrees: true,
            hydrate_selected_session: Some(false),
            mark_selected_session_viewed: Some(false),
            ..Default::default()
        },
    )
    .await?;
    let reconcile = kernel.rc();
    tokio::task::spawn_local(async move {
        workspace::reconcile_worktrees(&reconcile).await;
    });
    let restored = kernel.data.borrow().selected_session_ref();
    if let Some(restored) = &restored {
        if persisted.selected_workspace_id.is_some() && persisted.selected_session_id.is_some() {
            kernel
                .data
                .borrow_mut()
                .restored_selected_keys_awaiting_selection
                .insert(session_key(restored));
        }
    }
    sessions::start_selected_session_hydration(kernel, restored, false);
    orchestration::schedule_supervision(kernel);
    scheduled::schedule_scheduled_tasks(kernel);
    if !diagnostics.is_empty() {
        let mut data = kernel.data.borrow_mut();
        data.state.startup_diagnostics = std::mem::take(diagnostics);
        data.bump();
        drop(data);
        publish::emit(kernel);
    }
    Ok(())
}

/// `syncStartupWorkspace`.
async fn sync_startup_workspace(
    kernel: &Kernel,
    path: String,
    display_name: Option<String>,
) -> Option<StartupDiagnostic> {
    let result = async {
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|error| CoreError::io(&error, std::path::Path::new(&path)))?;
        if !metadata.is_dir() {
            return Err(CoreError::new("Path is not a directory."));
        }
        sessions::sync_workspace(kernel, &path, display_name.as_deref()).await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => None,
        Err(error) => {
            eprintln!(
                "[app-store] workspace unavailable during startup: {path}: {}",
                error.message
            );
            Some(StartupDiagnostic {
                scope: StartupDiagnosticScope::Workspace,
                message: error.message,
                workspace_path: Some(path),
            })
        }
    }
}

/// `Promise.all` over local futures: started together, each polled while the others wait,
/// and the outputs in order.
pub async fn futures_join_all<F: std::future::Future>(
    futures: impl IntoIterator<Item = F>,
) -> Vec<F::Output> {
    let mut pending: Vec<_> = futures
        .into_iter()
        .map(|future| Some(Box::pin(future)))
        .collect();
    let mut results: Vec<Option<F::Output>> = pending.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut done = true;
        for (slot, result) in pending.iter_mut().zip(results.iter_mut()) {
            if let Some(future) = slot {
                match future.as_mut().poll(cx) {
                    std::task::Poll::Ready(output) => {
                        *result = Some(output);
                        *slot = None;
                    }
                    std::task::Poll::Pending => done = false,
                }
            }
        }
        if done {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    results.into_iter().flatten().collect()
}

/// The catalog rows `listWorkspaces` / `listSessions` / `listWorktrees` return.
#[derive(Deserialize)]
pub struct WorkspacesSnapshot {
    pub workspaces: Vec<WorkspaceEntry>,
}

#[derive(Deserialize)]
pub struct SessionsSnapshot {
    pub sessions: Vec<SessionEntry>,
}

#[derive(Deserialize)]
pub struct WorktreesSnapshot {
    pub worktrees: Vec<WorktreeEntry>,
}

/// Answers the pi host's own calls.
struct KernelHostCalls {
    kernel: Weak<Kernel>,
}

impl pi::HostCalls for KernelHostCalls {
    fn call(&self, method: String, params: Value) -> LocalFuture<CoreResult<Value>> {
        let Some(kernel) = self.kernel.upgrade() else {
            return Box::pin(std::future::ready(Err(CoreError::new(
                "pi-gui is shutting down",
            ))));
        };
        Box::pin(async move {
            match method.as_str() {
                // The catalog lives in the core; the host's call has the same shape.
                "app.catalog" => kernel.core_call(crate::methods::CATALOG_CALL, params).await,
                "app.captureBoundary" => {
                    let boundary = params.get("boundary").cloned().unwrap_or(Value::Null);
                    kernel
                        .core_call(
                            crate::methods::checkpoints::RECORD_BOUNDARY,
                            json!({ "boundary": boundary }),
                        )
                        .await?;
                    Ok(Value::Null)
                }
                "app.tool" if scheduled::tools::is_scheduled_tool(&params) => {
                    scheduled::tools::run_tool(&kernel, params).await
                }
                "app.tool" => orchestration::run_pi_gui_tool(&kernel, params).await,
                _ => Err(CoreError::new(format!("Unknown RPC method: {method}"))),
            }
        })
    }

    fn notification(&self, method: String, params: Value) {
        let Some(kernel) = self.kernel.upgrade() else {
            return;
        };
        match method.as_str() {
            "app.openUrl" => {
                if let Some(url) = params.get("url").and_then(Value::as_str) {
                    let open = kernel.shell().open_external(url.to_owned());
                    tokio::task::spawn_local(async move {
                        if let Err(error) = open.await {
                            eprintln!("[main] opening the sign-in page failed: {}", error.message);
                        }
                    });
                }
            }
            "host.diagnostic" => eprintln!("[pi-host] {params}"),
            "views.changed" | "views.message" => {
                extensions::on_host_view_notification(&kernel, &method, params)
            }
            _ => eprintln!("[pi-host] no handler for notification {method}"),
        }
    }
}
