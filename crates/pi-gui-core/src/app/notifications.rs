//! Desktop notifications (`platform/notification-manager.ts` and the app side of
//! `notification-permission.ts`): which run completions, failures and requests for input
//! notify, asking for permission once work has moved to the background, and opening a thread
//! when its notification is clicked. The shell shows notifications and answers the
//! permission calls; the kernel decides and publishes permission changes to every window.

use super::dispatch::{self, MethodTable, Reply};
use super::methods::push;
use super::{publish, workspace, Kernel, WindowId};
use crate::error::CoreResult;
use crate::state::desktop_state::{AppView, DesktopAppState, SessionRecord};
use crate::state::driver::{
    session_key, HostUiRequest, NoticeLevel, SessionDriverEvent, SessionEventKind, SessionRef,
    SessionStatus,
};
use indexmap::IndexSet;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::task::AbortHandle;

const MAX_COMPLETED_RUN_KEYS: usize = 500;
/// An extension that throws on a frequent event repeats the same error notice; notify once per
/// window.
const REPEATED_NOTICE_WINDOW_MS: f64 = 30_000.0;
const RECONCILIATION_POLL_INTERVAL: Duration = Duration::from_millis(500);
const RECONCILIATION_MAX_POLLS: u32 = 20;
/// `PI_APP_NOTIFICATION_LOG_PATH`: each notification is also written here, as JSON lines.
const NOTIFICATION_LOG_PATH_ENV: &str = "PI_APP_NOTIFICATION_LOG_PATH";

/// What the notification part keeps.
pub struct NotificationsState {
    completed_run_keys: IndexSet<String>,
    /// Threads with a notification on screen, by session key.
    shown: HashSet<String>,
    last_notice_by_session: HashMap<String, (String, f64)>,
    /// The window whose visibility decides what counts as watched (main's `mainWindow`).
    tracked_window: Option<WindowId>,
    last_actively_viewed: Option<SessionRef>,
    background_candidates: Vec<SessionRef>,
    permission_request_pending: bool,
    last_published_status: String,
    reconciliation_baseline: Option<String>,
    reconciliation_poll: Option<AbortHandle>,
}

impl Default for NotificationsState {
    fn default() -> Self {
        Self {
            completed_run_keys: IndexSet::new(),
            shown: HashSet::new(),
            last_notice_by_session: HashMap::new(),
            tracked_window: None,
            last_actively_viewed: None,
            background_candidates: Vec::new(),
            permission_request_pending: false,
            last_published_status: "unknown".to_owned(),
            reconciliation_baseline: None,
            reconciliation_poll: None,
        }
    }
}

pub fn register(table: &mut MethodTable) {
    table.on("getNotificationPermissionStatus", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(Reply::Value(json!(get_current_status(&kernel).await?)))
        })
    });
    table.on("requestNotificationPermission", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(Reply::Value(json!(request_permission(&kernel).await?)))
        })
    });
    table.on("openSystemNotificationSettings", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            open_system_settings(&kernel).await?;
            Ok(Reply::Undefined)
        })
    });
}

// ---- Permission ----

/// `getCurrentStatus`: asks the shell, and tells every window when the answer changed.
pub async fn get_current_status(kernel: &Kernel) -> CoreResult<String> {
    let status = status_text(kernel.shell().notification_permission("status").await?);
    publish_status(kernel, &status);
    Ok(status)
}

/// `requestPermission`.
pub async fn request_permission(kernel: &Kernel) -> CoreResult<String> {
    let status = status_text(kernel.shell().notification_permission("request").await?);
    publish_status(kernel, &status);
    Ok(status)
}

/// `ensurePermission`: asks only while the system has not decided.
async fn ensure_permission(kernel: &Kernel) -> CoreResult<String> {
    let current = get_current_status(kernel).await?;
    if current != "default" {
        return Ok(current);
    }
    request_permission(kernel).await
}

/// `openSystemSettings`: remembers the status, so coming back to the app can notice a change.
async fn open_system_settings(kernel: &Kernel) -> CoreResult<()> {
    let baseline = get_current_status(kernel).await?;
    {
        let mut data = kernel.data.borrow_mut();
        data.notifications.reconciliation_baseline = Some(baseline);
    }
    clear_reconciliation_poll(kernel);
    kernel
        .shell()
        .notification_permission("openSettings")
        .await?;
    Ok(())
}

fn status_text(value: Value) -> String {
    match value.as_str() {
        Some(status @ ("granted" | "denied" | "default" | "unsupported" | "unknown")) => {
            status.to_owned()
        }
        _ => "unknown".to_owned(),
    }
}

fn publish_status(kernel: &Kernel, status: &str) {
    {
        let mut data = kernel.data.borrow_mut();
        if data.notifications.last_published_status == status {
            return;
        }
        data.notifications.last_published_status = status.to_owned();
    }
    publish::broadcast(
        kernel,
        push::NOTIFICATION_PERMISSION_STATUS_CHANGED,
        &status,
    );
}

/// `reconcileOnActivation`: after the user went to the system settings, coming back reads the
/// status again, and keeps reading for a while if it has not changed yet.
async fn reconcile_on_activation(kernel: &Kernel) -> CoreResult<()> {
    let status = get_current_status(kernel).await?;
    let Some(baseline) = kernel
        .data
        .borrow()
        .notifications
        .reconciliation_baseline
        .clone()
    else {
        return Ok(());
    };
    if status != baseline {
        kernel
            .data
            .borrow_mut()
            .notifications
            .reconciliation_baseline = None;
        clear_reconciliation_poll(kernel);
        return Ok(());
    }
    start_reconciliation_poll(kernel);
    Ok(())
}

fn start_reconciliation_poll(kernel: &Kernel) {
    if kernel
        .data
        .borrow()
        .notifications
        .reconciliation_poll
        .is_some()
    {
        return;
    }
    let weak = kernel.this_weak();
    let poll = tokio::task::spawn_local(async move {
        for count in 1..=RECONCILIATION_MAX_POLLS {
            tokio::time::sleep(RECONCILIATION_POLL_INTERVAL).await;
            let Some(kernel) = weak.upgrade() else {
                return;
            };
            let Some(baseline) = kernel
                .data
                .borrow()
                .notifications
                .reconciliation_baseline
                .clone()
            else {
                break;
            };
            let status = match get_current_status(&kernel).await {
                Ok(status) => status,
                Err(error) => {
                    eprintln!("[notification-permission] tick failed: {}", error.message);
                    return;
                }
            };
            if status != baseline || count >= RECONCILIATION_MAX_POLLS {
                kernel
                    .data
                    .borrow_mut()
                    .notifications
                    .reconciliation_baseline = None;
                break;
            }
        }
        if let Some(kernel) = weak.upgrade() {
            kernel.data.borrow_mut().notifications.reconciliation_poll = None;
        }
    });
    kernel.data.borrow_mut().notifications.reconciliation_poll = Some(poll.abort_handle());
}

fn clear_reconciliation_poll(kernel: &Kernel) {
    if let Some(poll) = kernel
        .data
        .borrow_mut()
        .notifications
        .reconciliation_poll
        .take()
    {
        poll.abort();
    }
}

// ---- What counts as watched ----

fn selected_in_threads(state: &DesktopAppState, session_ref: &SessionRef) -> bool {
    state.active_view == AppView::Threads
        && state.selected_workspace_id == session_ref.workspace_id
        && state.selected_session_id == session_ref.session_id
}

/// `isSessionActivelyViewed` against `state` and the active window.
fn actively_viewed(kernel: &Kernel, state: &DesktopAppState, session_ref: &SessionRef) -> bool {
    if !selected_in_threads(state, session_ref) {
        return false;
    }
    if let Some(active) = kernel.test.session_visibility() {
        return active;
    }
    kernel
        .windows
        .active(kernel)
        .and_then(|window| kernel.shell().presence(window))
        .is_some_and(|presence| presence.visible && !presence.minimized && presence.focused)
}

fn session_in<'a>(
    state: &'a DesktopAppState,
    session_ref: &SessionRef,
) -> Option<&'a SessionRecord> {
    state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == session_ref.workspace_id)?
        .sessions
        .iter()
        .find(|session| session.id == session_ref.session_id)
}

fn selected_session_ref(state: &DesktopAppState) -> Option<SessionRef> {
    let session_ref =
        crate::state::driver::session_ref(&state.selected_workspace_id, &state.selected_session_id);
    session_in(state, &session_ref).map(|_| session_ref)
}

fn preferences_enabled(state: &DesktopAppState) -> bool {
    let preferences = &state.notification_preferences;
    preferences.background_completion
        || preferences.background_failure
        || preferences.attention_needed
}

// ---- Listeners ----

/// The state listener: a thread the user is watching loses its notification, and leaving a
/// running thread may ask for permission.
pub fn after_emit(kernel: &Kernel, state: &DesktopAppState) {
    if let Some(selected) = selected_session_ref(state) {
        if actively_viewed(kernel, state, &selected) {
            dismiss_for_session(kernel, &selected);
        }
    }
    reevaluate_onboarding_state(kernel, state);
}

/// A window was focused, shown or restored.
pub fn on_window_activated(kernel: &Kernel) {
    let state = kernel.data.borrow().state.clone();
    reevaluate_onboarding_state(kernel, &state);
    let target = kernel.rc();
    tokio::task::spawn_local(async move {
        if let Err(error) = reconcile_on_activation(&target).await {
            eprintln!(
                "[notification-permission] reconcileOnActivation failed: {}",
                error.message
            );
        }
    });
}

/// The first window opened: the windows learn the permission status (main's startup read).
pub fn on_first_window(kernel: &Kernel) {
    let target = kernel.rc();
    tokio::task::spawn_local(async move {
        if let Err(error) = get_current_status(&target).await {
            eprintln!("[main] getCurrentStatus failed: {}", error.message);
        }
    });
}

/// The notification manager's session-event listener.
pub async fn on_session_event(
    kernel: &Kernel,
    event: &SessionDriverEvent,
    snapshot: &DesktopAppState,
) -> CoreResult<()> {
    reevaluate_onboarding_state(kernel, snapshot);
    if let Err(error) = handle_event(kernel, event, snapshot).await {
        eprintln!(
            "[notification-manager] handleEvent failed: {}",
            error.message
        );
    }
    Ok(())
}

/// `reevaluateOnboardingState`: a thread the user left while it ran is the moment to ask for
/// permission, once.
fn reevaluate_onboarding_state(kernel: &Kernel, state: &DesktopAppState) {
    let window = kernel.windows.active(kernel);
    let next_viewed =
        selected_session_ref(state).filter(|selected| actively_viewed(kernel, state, selected));
    let mut candidates = {
        let mut data = kernel.data.borrow_mut();
        let notifications = &mut data.notifications;
        // `syncWindowTracking`: losing the main window forgets what was watched.
        if notifications.tracked_window != window {
            notifications.tracked_window = window;
            if window.is_none() {
                notifications.last_actively_viewed = None;
                notifications.background_candidates.clear();
            }
        }
        let previous =
            std::mem::replace(&mut notifications.last_actively_viewed, next_viewed.clone());
        if let Some(previous) = previous.filter(|previous| Some(previous) != next_viewed.as_ref()) {
            if !notifications.background_candidates.contains(&previous) {
                notifications.background_candidates.push(previous);
            }
        }
        if let Some(next) = &next_viewed {
            notifications
                .background_candidates
                .retain(|candidate| candidate != next);
        }
        notifications.background_candidates.clone()
    };

    // `maybeRequestNotificationPermission`.
    if !preferences_enabled(state) {
        return;
    }
    candidates.retain(|candidate| {
        !actively_viewed(kernel, state, candidate) && session_in(state, candidate).is_some()
    });
    let runnable = candidates.iter().any(|candidate| {
        session_in(state, candidate).is_some_and(|session| session.status == SessionStatus::Running)
    });
    {
        let mut data = kernel.data.borrow_mut();
        let notifications = &mut data.notifications;
        notifications.background_candidates = candidates;
        if !runnable || notifications.permission_request_pending {
            return;
        }
        notifications.permission_request_pending = true;
    }
    let target = kernel.rc();
    tokio::task::spawn_local(async move {
        if let Err(error) = ensure_permission(&target).await {
            eprintln!(
                "[notification-manager] reevaluateOnboardingState failed: {}",
                error.message
            );
        }
        let mut data = target.data.borrow_mut();
        data.notifications.background_candidates.clear();
        data.notifications.permission_request_pending = false;
    });
}

// ---- Showing ----

/// `requiresAttention`: info notices stay in the app so chatty extensions don't spam the OS.
fn requires_attention(request: &HostUiRequest) -> bool {
    match request {
        HostUiRequest::Confirm { .. }
        | HostUiRequest::Input { .. }
        | HostUiRequest::Select { .. } => true,
        HostUiRequest::Notify { level, .. } => {
            matches!(level, Some(NoticeLevel::Warning | NoticeLevel::Error))
        }
        _ => false,
    }
}

/// `hostUiBody`.
fn host_ui_body(request: &HostUiRequest) -> String {
    match request {
        HostUiRequest::Notify { level, message, .. } => {
            let label = if *level == Some(NoticeLevel::Error) {
                "Error"
            } else {
                "Warning"
            };
            format!("{label}: {message}")
        }
        HostUiRequest::Confirm { title, .. }
        | HostUiRequest::Input { title, .. }
        | HostUiRequest::Select { title, .. } => title.clone(),
        _ => "Needs your input".to_owned(),
    }
}

/// `shouldNotify`: the user's preferences, and not for a thread they are watching.
fn should_notify(kernel: &Kernel, event: &SessionDriverEvent, state: &DesktopAppState) -> bool {
    let preferences = &state.notification_preferences;
    let wanted = match &event.kind {
        SessionEventKind::RunCompleted { .. } => preferences.background_completion,
        SessionEventKind::RunFailed { .. } => preferences.background_failure,
        SessionEventKind::HostUiRequest { .. } => preferences.attention_needed,
        _ => false,
    };
    if !wanted {
        return false;
    }
    if kernel.windows.active(kernel).is_none() {
        return true;
    }
    !actively_viewed(kernel, state, &event.session_ref)
}

/// `claimNoticeNotification`: a notice never replaces a waiting dialog's notification, and a
/// repeated notice notifies once.
fn claim_notice(kernel: &Kernel, event: &SessionDriverEvent, state: &DesktopAppState) -> bool {
    let SessionEventKind::HostUiRequest {
        request: HostUiRequest::Notify { level, message, .. },
    } = &event.kind
    else {
        return true;
    };
    let key = session_key(&event.session_ref);
    if state
        .session_extension_ui_by_session
        .get(&key)
        .is_some_and(|ui| !ui.pending_dialogs.is_empty())
    {
        return false;
    }
    let now = kernel.env().now_ms();
    let level = match level {
        Some(NoticeLevel::Warning) => "warning",
        Some(NoticeLevel::Error) => "error",
        _ => "info",
    };
    let notice = format!("{level}:{message}");
    let mut data = kernel.data.borrow_mut();
    let last = &mut data.notifications.last_notice_by_session;
    if last
        .get(&key)
        .is_some_and(|(previous, at)| *previous == notice && now - at < REPEATED_NOTICE_WINDOW_MS)
    {
        return false;
    }
    last.insert(key, (notice, now));
    true
}

fn title_for_session(state: &DesktopAppState, session_ref: &SessionRef) -> String {
    session_in(state, session_ref)
        .map(|session| session.title.clone())
        .unwrap_or_else(|| "pi session".to_owned())
}

/// `handleEvent`.
async fn handle_event(
    kernel: &Kernel,
    event: &SessionDriverEvent,
    state: &DesktopAppState,
) -> CoreResult<()> {
    if matches!(event.kind, SessionEventKind::SessionClosed { .. }) {
        kernel
            .data
            .borrow_mut()
            .notifications
            .last_notice_by_session
            .remove(&session_key(&event.session_ref));
    }
    if !should_notify(kernel, event, state) {
        return Ok(());
    }
    let session_ref = &event.session_ref;
    match &event.kind {
        SessionEventKind::RunCompleted { snapshot } => {
            let dedupe_key = format!(
                "{}:{}",
                session_key(session_ref),
                event.run_id.as_deref().unwrap_or("completed")
            );
            {
                let mut data = kernel.data.borrow_mut();
                let keys = &mut data.notifications.completed_run_keys;
                if !keys.insert(dedupe_key) {
                    return Ok(());
                }
                // Bounded so a long-lived app does not grow it forever; the oldest go first.
                while keys.len() > MAX_COMPLETED_RUN_KEYS {
                    keys.shift_remove_index(0);
                }
            }
            show_notification(
                kernel,
                session_ref,
                &snapshot.title,
                "Agent finished responding",
            )
            .await
        }
        SessionEventKind::RunFailed { error } => {
            let title = title_for_session(state, session_ref);
            show_notification(kernel, session_ref, &title, &error.message).await
        }
        SessionEventKind::HostUiRequest { request } if requires_attention(request) => {
            if !claim_notice(kernel, event, state) {
                return Ok(());
            }
            let title = title_for_session(state, session_ref);
            show_notification(kernel, session_ref, &title, &host_ui_body(request)).await
        }
        _ => Ok(()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoggedNotification<'a> {
    session_ref: &'a SessionRef,
    title: &'a str,
    body: &'a str,
    timestamp: String,
}

/// `showNotification`: replaces the thread's earlier notification.
async fn show_notification(
    kernel: &Kernel,
    session_ref: &SessionRef,
    title: &str,
    body: &str,
) -> CoreResult<()> {
    dismiss_for_session(kernel, session_ref);
    log_notification(kernel, session_ref, title, body).await?;
    kernel
        .data
        .borrow_mut()
        .notifications
        .shown
        .insert(session_key(session_ref));
    kernel
        .shell()
        .notify(json!({ "sessionRef": session_ref, "title": title, "body": body }))
        .await
}

/// `logNotification`.
async fn log_notification(
    kernel: &Kernel,
    session_ref: &SessionRef,
    title: &str,
    body: &str,
) -> CoreResult<()> {
    let Some(path) = std::env::var(NOTIFICATION_LOG_PATH_ENV)
        .ok()
        .map(|path| crate::js::trim(&path).to_owned())
        .filter(|path| !path.is_empty())
    else {
        return Ok(());
    };
    let path = std::path::PathBuf::from(path);
    let line = serde_json::to_string(&LoggedNotification {
        session_ref,
        title,
        body,
        timestamp: kernel.env().now_iso(),
    })
    .unwrap_or_default();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| crate::error::CoreError::io(&error, parent))?;
    }
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|error| crate::error::CoreError::io(&error, &path))?;
    file.write_all(format!("{line}\n").as_bytes())
        .await
        .map_err(|error| crate::error::CoreError::io(&error, &path))
}

/// `dismissForSession`.
fn dismiss_for_session(kernel: &Kernel, session_ref: &SessionRef) {
    let key = session_key(session_ref);
    let shown = kernel.data.borrow_mut().notifications.shown.remove(&key);
    if shown {
        kernel.shell().close_notification(session_ref);
    }
}

/// `openSession`: a click on a thread's notification shows that thread in the window in
/// front, and brings the window up.
pub async fn open_session(kernel: &Kernel, session_ref: &SessionRef) -> CoreResult<()> {
    let window = kernel.windows.foreground(kernel);
    kernel
        .windows
        .run_state_action(kernel, window, true, || {
            workspace::select_session(kernel, session_ref)
        })
        .await?;
    if let Some(window) = kernel.windows.active(kernel) {
        kernel.shell().show_window(window);
    }
    dismiss_for_session(kernel, session_ref);
    Ok(())
}
