//! Session operations every part shares: selecting and hydrating a thread, subscriptions,
//! transcripts, composer draft resolution, viewed/interacted marks, and the store's error
//! helpers (`withError` and friends). Names follow `app-store.ts`.

use super::pi::{args, driver_call, runtime_call, Unsubscribe};
use super::publish::{self, ViewState};
use super::{
    conversation, extensions, persist, settings, AppData, Kernel, SessionsSnapshot,
    WorkspacesSnapshot,
};
use crate::error::{CoreError, CoreResult};
use crate::js::JsNumber;
use crate::persistence::catalog::{SessionEntry, WorkspaceEntry};
use crate::state::app_store_utils::{
    latest_session_activity_at, merge_queued_composer_messages, preview_from_transcript,
};
use crate::state::desktop_state::{
    AppView, ComposerAttachment, ComposerDraftSyncSource, DesktopAppState, QueuedComposerMessage,
};
use crate::state::driver::{
    session_key, session_ref, RuntimeCommandRecord, RuntimeSnapshot, SessionConfig,
    SessionMessageDeliveryMode, SessionQueuedMessage, SessionRef, SessionSchemaInfo,
    SessionSnapshot, SessionTranscriptItem, SessionUsageSnapshot, WorkspaceRef,
};
use crate::state::session_state::{update_session_record, SessionRecordUpdate, SnapshotFields};
use crate::state::session_state_map::PendingAutoTitle;
use crate::state::timeline::timeline_from_driver_transcript;
use crate::state::tool_labels::extension_tool_labels;
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::future::Future;
use std::rc::Rc;

// ---- Catalog reads through pi ----

pub async fn list_workspaces(kernel: &Kernel) -> CoreResult<Vec<WorkspaceEntry>> {
    let snapshot: WorkspacesSnapshot =
        driver_call(kernel.driver(), "listWorkspaces", vec![]).await?;
    Ok(snapshot.workspaces)
}

pub async fn list_sessions(kernel: &Kernel) -> CoreResult<Vec<SessionEntry>> {
    let snapshot: SessionsSnapshot = driver_call(kernel.driver(), "listSessions", vec![]).await?;
    Ok(snapshot.sessions)
}

/// What `syncWorkspace` returns.
#[derive(Deserialize)]
pub struct SyncedWorkspace {
    pub workspace: WorkspaceRef,
    pub sessions: Vec<SessionEntry>,
}

/// `driver.syncWorkspace(path, displayName)`.
pub async fn sync_workspace(
    kernel: &Kernel,
    path: &str,
    display_name: Option<&str>,
) -> CoreResult<SyncedWorkspace> {
    let mut call_args = args([json!(path)]);
    if let Some(name) = display_name {
        call_args.push(Some(json!(name)));
    }
    driver_call(kernel.driver(), "syncWorkspace", call_args).await
}

/// The `WorkspaceRef` pi takes for a catalog row.
pub fn workspace_ref_of(entry: &WorkspaceEntry) -> WorkspaceRef {
    WorkspaceRef {
        workspace_id: entry.workspace_id.clone(),
        path: entry.path.clone(),
        display_name: Some(entry.display_name.clone()),
    }
}

/// `piHostConfig`: switched-off tools and per-session flags.
pub fn pi_host_config(data: &AppData) -> super::pi::PiHostConfig {
    super::pi::PiHostConfig {
        disabled_builtin_extensions: data.disabled_builtin_extensions.iter().cloned().collect(),
        extension_flags: data
            .sessions
            .extension_flags_by_session
            .iter()
            .map(|(key, flags)| (key.clone(), serde_json::to_value(flags).unwrap_or_default()))
            .collect(),
    }
}

// ---- Errors ----

/// `describeStoreError`: a held session lease reads as who holds it and what to do.
pub fn describe_store_error(error: &CoreError) -> String {
    let data = error.data.as_ref();
    if data
        .and_then(|data| data.get("code"))
        .and_then(Value::as_str)
        == Some("SESSION_LEASED")
    {
        if let Some(holder) = data.and_then(|data| data.get("holder")) {
            let surface = holder.get("surface").and_then(Value::as_str);
            let pid = holder.get("pid").cloned().unwrap_or(Value::Null);
            let host = holder
                .get("hostname")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let place = if surface == Some("pi-cli") {
                "the pi CLI"
            } else {
                "another pi instance"
            };
            let next = if host == local_hostname() {
                "Close it there"
            } else {
                "Close it there or wait a few minutes"
            };
            return format!(
                "This session is currently open in {place} (pid {pid} on host {host}). {next} to continue here."
            );
        }
    }
    error.message.clone()
}

fn local_hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer outlives the call and its length is passed with it.
        let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        if result == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            return String::from_utf8_lossy(&buffer[..end]).into_owned();
        }
    }
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// `withError`: shows `message` on the selected thread and in `lastError`.
pub async fn with_error(kernel: &Kernel, message: String) -> CoreResult<DesktopAppState> {
    {
        let mut data = kernel.data.borrow_mut();
        if let Some(selected) = data.selected_session_ref() {
            data.sessions
                .session_errors_by_session
                .insert(session_key(&selected), message.clone());
        }
        data.state.last_error = Some(message);
        data.bump();
    }
    persist::persist_and_emit(kernel).await
}

/// `withError` for a thrown error.
pub async fn with_core_error(kernel: &Kernel, error: CoreError) -> CoreResult<DesktopAppState> {
    with_error(kernel, describe_store_error(&error)).await
}

/// `withSessionError`.
pub async fn with_session_error(
    kernel: &Kernel,
    session_ref: &SessionRef,
    message: String,
) -> CoreResult<DesktopAppState> {
    {
        let mut data = kernel.data.borrow_mut();
        data.sessions
            .session_errors_by_session
            .insert(session_key(session_ref), message.clone());
        if data.is_selected(session_ref) {
            data.state.last_error = Some(message);
        }
        data.bump();
    }
    persist::persist_and_emit(kernel).await
}

/// `withErrorHandling`.
pub async fn with_error_handling<Fut>(kernel: &Kernel, action: Fut) -> CoreResult<DesktopAppState>
where
    Fut: Future<Output = CoreResult<DesktopAppState>>,
{
    match action.await {
        Ok(state) => Ok(state),
        Err(error) => with_core_error(kernel, error).await,
    }
}

/// `structuredClone(this.state)`.
pub fn snapshot(kernel: &Kernel) -> DesktopAppState {
    kernel.data.borrow().state.clone()
}

// ---- Composer draft and per-thread projections ----

/// `resolveComposerDraft`.
pub fn resolve_composer_draft(
    data: &mut AppData,
    workspace_id: &str,
    session_id: &str,
    explicit: Option<&str>,
) -> String {
    if let Some(explicit) = explicit {
        if !workspace_id.is_empty() && !session_id.is_empty() {
            let key = session_key(&session_ref(workspace_id, session_id));
            if explicit.is_empty() {
                data.sessions.composer_drafts_by_session.shift_remove(&key);
            } else {
                data.sessions
                    .composer_drafts_by_session
                    .insert(key, explicit.to_owned());
            }
        }
        return explicit.to_owned();
    }
    if workspace_id.is_empty() || session_id.is_empty() {
        return String::new();
    }
    data.sessions
        .composer_drafts_by_session
        .get(&session_key(&session_ref(workspace_id, session_id)))
        .cloned()
        .unwrap_or_default()
}

/// `allocateComposerDraftSyncNonce`.
pub fn allocate_composer_draft_sync_nonce(data: &mut AppData, base: f64) -> f64 {
    data.composer_draft_projection_nonce = data.composer_draft_projection_nonce.max(base) + 1.0;
    data.composer_draft_projection_nonce
}

/// `resolveComposerDraftSync`.
pub fn resolve_composer_draft_sync(
    data: &mut AppData,
    workspace_id: &str,
    session_id: &str,
    source: Option<ComposerDraftSyncSource>,
) -> (ComposerDraftSyncSource, f64) {
    let base = data.state.composer_draft_sync_nonce.0;
    if let Some(source) = source {
        return (source, allocate_composer_draft_sync_nonce(data, base));
    }
    if workspace_id != data.state.selected_workspace_id
        || session_id != data.state.selected_session_id
    {
        return (
            ComposerDraftSyncSource::Selection,
            allocate_composer_draft_sync_nonce(data, base),
        );
    }
    (data.state.composer_draft_sync_source, base)
}

/// `setComposerDraftForSession`.
pub fn set_composer_draft_for_session(
    data: &mut AppData,
    session_ref: &SessionRef,
    draft: &str,
    source: ComposerDraftSyncSource,
) {
    let key = session_key(session_ref);
    if draft.is_empty() {
        data.sessions.composer_drafts_by_session.shift_remove(&key);
    } else {
        data.sessions
            .composer_drafts_by_session
            .insert(key, draft.to_owned());
    }
    data.composer_draft_sync_target = Some(session_ref.clone());
    if data.is_selected(session_ref) {
        data.state.composer_draft = draft.to_owned();
    }
    data.state.composer_draft_sync_source = source;
    let base = data.state.composer_draft_sync_nonce.0;
    data.state.composer_draft_sync_nonce = JsNumber(allocate_composer_draft_sync_nonce(data, base));
}

fn selected_key(workspace_id: &str, session_id: &str) -> Option<String> {
    (!workspace_id.is_empty() && !session_id.is_empty())
        .then(|| session_key(&session_ref(workspace_id, session_id)))
}

/// `resolveComposerAttachments`.
pub fn resolve_composer_attachments(
    data: &AppData,
    workspace_id: &str,
    session_id: &str,
) -> Vec<ComposerAttachment> {
    selected_key(workspace_id, session_id)
        .and_then(|key| {
            data.sessions
                .composer_attachments_by_session
                .get(&key)
                .cloned()
        })
        .unwrap_or_default()
}

/// `resolveQueuedComposerMessages`: follow-ups only.
pub fn resolve_queued_composer_messages(
    data: &AppData,
    workspace_id: &str,
    session_id: &str,
) -> Vec<QueuedComposerMessage> {
    selected_key(workspace_id, session_id)
        .and_then(|key| data.sessions.queued_composer_messages_by_session.get(&key))
        .map(|messages| {
            messages
                .iter()
                .filter(|message| message.mode == SessionMessageDeliveryMode::FollowUp)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// `resolveEditingQueuedMessageId`.
pub fn resolve_editing_queued_message_id(
    data: &AppData,
    workspace_id: &str,
    session_id: &str,
) -> Option<String> {
    selected_key(workspace_id, session_id)
        .and_then(|key| data.sessions.queued_composer_edits_by_session.get(&key))
        .map(|edit| edit.message_id.clone())
}

/// `resolveSelectedSessionError`.
pub fn resolve_selected_session_error(
    data: &mut AppData,
    workspace_id: &str,
    session_id: &str,
    clear: bool,
) -> Option<String> {
    let key = selected_key(workspace_id, session_id)?;
    if clear {
        data.sessions.session_errors_by_session.shift_remove(&key);
        return None;
    }
    data.sessions.session_errors_by_session.get(&key).cloned()
}

/// `updateSessionConfig`.
pub fn update_session_config(
    data: &mut AppData,
    session_ref: &SessionRef,
    config: Option<&SessionConfig>,
) {
    let key = session_key(session_ref);
    let non_empty = config.filter(|config| {
        config.provider.is_some() || config.model_id.is_some() || config.thinking_level.is_some()
    });
    match non_empty {
        Some(config) => {
            data.sessions
                .session_config_by_session
                .insert(key, config.clone());
        }
        None => {
            data.sessions.session_config_by_session.shift_remove(&key);
        }
    }
}

/// `updateSessionUsage`.
pub fn update_session_usage(
    data: &mut AppData,
    session_ref: &SessionRef,
    usage: Option<&SessionUsageSnapshot>,
) {
    let key = session_key(session_ref);
    match usage {
        Some(usage) => {
            data.sessions
                .session_usage_by_session
                .insert(key, usage.clone());
        }
        None => {
            data.sessions.session_usage_by_session.shift_remove(&key);
        }
    }
}

/// `updateQueuedComposerMessages`.
pub fn update_queued_composer_messages(
    kernel: &Kernel,
    data: &mut AppData,
    session_ref: &SessionRef,
    queued: Option<&[SessionQueuedMessage]>,
) {
    let key = session_key(session_ref);
    let next = merge_queued_composer_messages(
        kernel.env(),
        data.sessions
            .queued_composer_messages_by_session
            .get(&key)
            .map(Vec::as_slice),
        queued,
    );
    let edit_gone = data
        .sessions
        .queued_composer_edits_by_session
        .get(&key)
        .is_some_and(|edit| !next.iter().any(|message| message.id == edit.message_id));
    if next.is_empty() {
        data.sessions
            .queued_composer_messages_by_session
            .shift_remove(&key);
    } else {
        data.sessions
            .queued_composer_messages_by_session
            .insert(key.clone(), next);
    }
    if edit_gone {
        data.sessions
            .queued_composer_edits_by_session
            .shift_remove(&key);
    }
}

/// Puts `value` at `key`, or removes it (`updateRecordValue`).
fn update_record<V: Clone>(record: &mut IndexMap<String, V>, key: &str, value: Option<&V>) {
    match value {
        Some(value) => {
            record.insert(key.to_owned(), value.clone());
        }
        None => {
            record.shift_remove(key);
        }
    }
}

/// `syncDerivedSessionState`: the thread's commands, usage, extension UI and marks, and the
/// selected thread's queue and error.
pub fn sync_derived_session_state(data: &mut AppData, session_ref: &SessionRef) {
    let key = session_key(session_ref);
    let extension_ui = data
        .sessions
        .extension_ui_by_session
        .get(&key)
        .map(crate::state::session_state_map::serialize_extension_ui_state);
    let compatibility =
        crate::state::extension_command_compatibility::serialize_compatibility_by_workspace(
            &data.compatibility_by_workspace,
        );
    let (workspace_id, session_id) = (
        data.state.selected_workspace_id.clone(),
        data.state.selected_session_id.clone(),
    );
    let queued = resolve_queued_composer_messages(data, &workspace_id, &session_id);
    let editing = resolve_editing_queued_message_id(data, &workspace_id, &session_id);
    let last_error = resolve_selected_session_error(data, &workspace_id, &session_id, false);
    let sessions = &data.sessions;
    let state = &mut data.state;
    update_record(
        &mut state.session_commands_by_session,
        &key,
        sessions.session_commands_by_session.get(&key),
    );
    update_record(
        &mut state.session_usage_by_session,
        &key,
        sessions.session_usage_by_session.get(&key),
    );
    update_record(
        &mut state.session_extension_ui_by_session,
        &key,
        extension_ui.as_ref(),
    );
    state.extension_command_compatibility_by_workspace = compatibility;
    update_record(
        &mut state.last_viewed_at_by_session,
        &key,
        sessions.last_viewed_at_by_session.get(&key),
    );
    update_record(
        &mut state.last_interacted_at_by_session,
        &key,
        sessions.last_interacted_at_by_session.get(&key),
    );
    state.queued_composer_messages = queued;
    state.editing_queued_message_id = editing;
    state.last_error = last_error;
}

/// `syncSelectedSessionHydrationState`.
pub fn sync_selected_session_hydration_state(
    data: &mut AppData,
    session_ref: &SessionRef,
    snapshot: Option<&SessionSnapshot>,
    runtime_by_workspace: Option<IndexMap<String, RuntimeSnapshot>>,
) {
    let key = session_key(session_ref);
    if let Some(runtime) = runtime_by_workspace {
        data.state.runtime_by_workspace = runtime;
    }
    let config = data.sessions.session_config_by_session.get(&key).cloned();
    let snapshot_fields = (snapshot.is_some() || config.is_some()).then(|| {
        let mut fields = snapshot.map(SnapshotFields::from).unwrap_or_default();
        fields.config = config.or_else(|| snapshot.and_then(|snapshot| snapshot.config.clone()));
        fields
    });
    {
        let sessions = &data.sessions;
        let transcript = sessions
            .transcript_cache
            .get(&key)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let preview = preview_from_transcript(transcript);
        let running_since = sessions.running_since_by_session.get(&key).cloned();
        let last_viewed_at = sessions.last_viewed_at_by_session.get(&key).cloned();
        for workspace in &mut data.state.workspaces {
            if workspace.id != session_ref.workspace_id {
                continue;
            }
            for session in &mut workspace.sessions {
                if session.id != session_ref.session_id {
                    continue;
                }
                *session = update_session_record(
                    session,
                    SessionRecordUpdate {
                        snapshot: snapshot_fields.clone(),
                        status: None,
                        transcript,
                        preview: preview.clone(),
                        running_since: running_since.clone(),
                        last_viewed_at: last_viewed_at.clone(),
                    },
                );
            }
        }
    }
    let (workspace_id, session_id) = (
        data.state.selected_workspace_id.clone(),
        data.state.selected_session_id.clone(),
    );
    data.state.composer_attachments =
        resolve_composer_attachments(data, &workspace_id, &session_id);
    data.state.last_error = None;
    data.bump();
    sync_derived_session_state(data, session_ref);
}

// ---- Viewed and interacted marks ----

/// `resolveViewedAt`.
fn resolve_viewed_at(data: &AppData, session_ref: &SessionRef, fallback: &str) -> String {
    let Some(session) = data.session(session_ref) else {
        return fallback.to_owned();
    };
    let transcript = data
        .sessions
        .transcript_cache
        .get(&session_key(session_ref))
        .map(Vec::as_slice)
        .unwrap_or_default();
    let activity = latest_session_activity_at(&session.updated_at, transcript);
    if activity > fallback {
        activity.to_owned()
    } else {
        fallback.to_owned()
    }
}

/// `markSessionViewed`.
pub fn mark_session_viewed(kernel: &Kernel, data: &mut AppData, session_ref: &SessionRef) -> bool {
    let key = session_key(session_ref);
    let viewed_at = resolve_viewed_at(data, session_ref, &kernel.env().now_iso());
    if data
        .sessions
        .last_viewed_at_by_session
        .get(&key)
        .is_some_and(|current| !current.is_empty() && *current >= viewed_at)
    {
        return false;
    }
    data.sessions
        .last_viewed_at_by_session
        .insert(key, viewed_at.clone());
    for workspace in &mut data.state.workspaces {
        if workspace.id != session_ref.workspace_id {
            continue;
        }
        for session in &mut workspace.sessions {
            if session.id == session_ref.session_id {
                session.last_viewed_at = Some(viewed_at.clone());
                session.has_unseen_update = false;
            }
        }
    }
    data.state.last_viewed_at_by_session = data.sessions.last_viewed_at_by_session.clone();
    true
}

/// `recordUserMessageRecency`: only when the user sends a message.
pub fn record_user_message_recency(kernel: &Kernel, session_ref: &SessionRef) -> bool {
    let at = kernel.env().now_iso();
    let changed = {
        let mut data = kernel.data.borrow_mut();
        let key = session_key(session_ref);
        if data
            .sessions
            .last_interacted_at_by_session
            .get(&key)
            .is_some_and(|current| !current.is_empty() && *current >= at)
        {
            false
        } else {
            data.sessions
                .last_interacted_at_by_session
                .insert(key, at.clone());
            for workspace in &mut data.state.workspaces {
                if workspace.id != session_ref.workspace_id {
                    continue;
                }
                for session in &mut workspace.sessions {
                    if session.id == session_ref.session_id {
                        session.last_interacted_at = Some(at.clone());
                    }
                }
            }
            data.state.last_interacted_at_by_session =
                data.sessions.last_interacted_at_by_session.clone();
            true
        }
    };
    if changed {
        persist::schedule_persist_ui_state(kernel);
    }
    changed
}

/// Whether the active window shows the app at all (`isSessionVisibleInWindow`'s window half).
fn active_window_visible(kernel: &Kernel) -> bool {
    kernel
        .windows
        .active(kernel)
        .and_then(|window| kernel.shell().presence(window))
        .is_some_and(|presence| presence.visible && !presence.minimized)
}

fn selected_in_threads(state: &DesktopAppState, session_ref: &SessionRef) -> bool {
    state.active_view == AppView::Threads
        && state.selected_workspace_id == session_ref.workspace_id
        && state.selected_session_id == session_ref.session_id
}

/// `markSelectedSessionViewedIfVisible`.
pub fn mark_selected_session_viewed_if_visible(kernel: &Kernel) -> bool {
    let Some(session_ref) = ({
        let data = kernel.data.borrow();
        (data.state.active_view == AppView::Threads)
            .then(|| data.selected_session_ref())
            .flatten()
    }) else {
        return false;
    };
    if !active_window_visible(kernel) {
        return false;
    }
    let mut data = kernel.data.borrow_mut();
    if data
        .restored_selected_keys_awaiting_selection
        .contains(&session_key(&session_ref))
    {
        return false;
    }
    mark_session_viewed(kernel, &mut data, &session_ref)
}

/// `isSessionActivelyViewed`, with the test override.
pub fn is_session_actively_viewed(kernel: &Kernel, session_ref: &SessionRef) -> bool {
    if !selected_in_threads(&kernel.data.borrow().state, session_ref) {
        return false;
    }
    match kernel.test.session_visibility() {
        Some(true) => return true,
        Some(false) => return false,
        None => {}
    }
    kernel
        .windows
        .active(kernel)
        .and_then(|window| kernel.shell().presence(window))
        .is_some_and(|presence| presence.visible && !presence.minimized && presence.focused)
}

/// `markSessionViewedIfActivelyViewed`.
pub fn mark_session_viewed_if_actively_viewed(kernel: &Kernel, session_ref: &SessionRef) -> bool {
    if !is_session_actively_viewed(kernel, session_ref) {
        return false;
    }
    let mut data = kernel.data.borrow_mut();
    mark_session_viewed(kernel, &mut data, session_ref)
}

/// `handleWindowActivation`.
pub fn handle_window_activation(kernel: &Kernel) {
    let workspace_id = kernel.data.borrow().state.selected_workspace_id.clone();
    if !workspace_id.is_empty() {
        super::workspace::reconcile_on_focus(kernel, &workspace_id);
    }
    if !mark_selected_session_viewed_if_visible(kernel) {
        return;
    }
    persist::schedule_persist_ui_state(kernel);
    publish::emit(kernel);
}

// ---- Selection ----

/// `applyFastSessionSelection`.
pub fn apply_fast_session_selection(kernel: &Kernel, session_ref: &SessionRef) -> DesktopAppState {
    let key = session_key(session_ref);
    {
        let mut data = kernel.data.borrow_mut();
        data.restored_selected_keys_awaiting_selection.remove(&key);
        data.state.selected_workspace_id = session_ref.workspace_id.clone();
        data.state.selected_session_id = session_ref.session_id.clone();
        data.state.active_view = AppView::Threads;
        data.state.composer_draft = resolve_composer_draft(
            &mut data,
            &session_ref.workspace_id,
            &session_ref.session_id,
            None,
        );
        data.state.composer_draft_sync_source = ComposerDraftSyncSource::Selection;
        let base = data.state.composer_draft_sync_nonce.0;
        data.state.composer_draft_sync_nonce =
            JsNumber(allocate_composer_draft_sync_nonce(&mut data, base));
        data.state.composer_attachments =
            resolve_composer_attachments(&data, &session_ref.workspace_id, &session_ref.session_id);
        data.state.last_error = None;
        data.bump();
        mark_session_viewed(kernel, &mut data, session_ref);
    }
    persist::schedule_persist_ui_state(kernel);
    let snapshot = publish::emit(kernel);
    if kernel
        .data
        .borrow()
        .sessions
        .loaded_transcript_keys
        .contains(&key)
    {
        publish::publish_selected_transcript(kernel);
    }
    snapshot
}

/// `isCurrentSelectionEpoch`.
fn is_current_selection_epoch(kernel: &Kernel, session_ref: &SessionRef, epoch: u64) -> bool {
    epoch == kernel.refresh.selection_epoch() && kernel.data.borrow().is_selected(session_ref)
}

/// `hydrateSelectedSessionAfterSelection`.
pub async fn hydrate_selected_session_after_selection(
    kernel: &Kernel,
    session_ref: &SessionRef,
    epoch: u64,
    mark_viewed: bool,
) -> CoreResult<()> {
    let runtime_missing = !kernel
        .data
        .borrow()
        .runtime_by_workspace
        .contains_key(&session_ref.workspace_id);
    let (snapshot, attachments, runtime) = tokio::join!(
        ensure_session_ready(kernel, session_ref),
        conversation::ensure_composer_attachments_loaded(kernel, session_ref),
        async {
            if runtime_missing {
                ensure_runtime_loaded(kernel, &session_ref.workspace_id, None).await
            } else {
                Ok(())
            }
        }
    );
    let snapshot = snapshot?;
    attachments?;
    runtime?;
    if !is_current_selection_epoch(kernel, session_ref, epoch) {
        return Ok(());
    }
    let runtime_by_workspace = if runtime_missing {
        Some(settings::serialize_runtime_state_for_current_workspaces(kernel).await)
    } else {
        None
    };
    if !is_current_selection_epoch(kernel, session_ref, epoch) {
        return Ok(());
    }
    {
        let mut data = kernel.data.borrow_mut();
        data.sessions
            .session_errors_by_session
            .shift_remove(&session_key(session_ref));
        sync_selected_session_hydration_state(
            &mut data,
            session_ref,
            snapshot.as_ref(),
            runtime_by_workspace,
        );
        if mark_viewed {
            mark_session_viewed(kernel, &mut data, session_ref);
        }
    }
    persist::schedule_persist_ui_state(kernel);
    publish::emit(kernel);
    publish::publish_selected_transcript_for(kernel, session_ref);
    Ok(())
}

/// `startSelectedSessionHydration`: runs in the background under a new selection epoch.
pub fn start_selected_session_hydration(
    kernel: &Kernel,
    session_ref: Option<SessionRef>,
    mark_viewed: bool,
) {
    let Some(session_ref) = session_ref else {
        return;
    };
    let epoch = kernel.refresh.next_selection_epoch();
    let kernel = kernel.rc();
    tokio::task::spawn_local(async move {
        if let Err(error) =
            hydrate_selected_session_after_selection(&kernel, &session_ref, epoch, mark_viewed)
                .await
        {
            if let Err(error) =
                handle_selected_session_hydration_error(&kernel, &session_ref, epoch, error).await
            {
                eprintln!(
                    "[app-store] handleSelectedSessionHydrationError failed: {}",
                    error.message
                );
            }
        }
    });
}

/// `handleSelectedSessionHydrationError`.
pub async fn handle_selected_session_hydration_error(
    kernel: &Kernel,
    session_ref: &SessionRef,
    epoch: u64,
    error: CoreError,
) -> CoreResult<()> {
    kernel
        .data
        .borrow_mut()
        .sessions
        .session_errors_by_session
        .insert(session_key(session_ref), error.message.clone());
    if is_current_selection_epoch(kernel, session_ref, epoch) {
        with_core_error(kernel, error).await?;
        return Ok(());
    }
    persist::schedule_persist_ui_state(kernel);
    Ok(())
}

/// `selectSessionFast`.
pub async fn select_session_fast(
    kernel: &Kernel,
    target: &SessionRef,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let known = kernel.data.borrow().session(target).is_some();
    if !known {
        return with_error_handling(
            kernel,
            super::refresh::refresh_state(
                kernel,
                super::refresh::RefreshOptions {
                    selected_workspace_id: Some(target.workspace_id.clone()),
                    selected_session_id: Some(target.session_id.clone()),
                    clear_last_error: true,
                    active_view: Some(AppView::Threads),
                    ..Default::default()
                },
            ),
        )
        .await;
    }
    with_error_handling(kernel, async {
        let epoch = kernel.refresh.next_selection_epoch();
        apply_fast_session_selection(kernel, target);
        if let Err(error) = Box::pin(hydrate_selected_session_after_selection(
            kernel, target, epoch, true,
        ))
        .await
        {
            handle_selected_session_hydration_error(kernel, target, epoch, error).await?;
        }
        Ok(snapshot(kernel))
    })
    .await
}

// ---- Subscriptions and transcripts ----

/// `ensureSessionReady`: transcript loaded, session open and subscribed, commands fresh.
pub async fn ensure_session_ready(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> CoreResult<Option<SessionSnapshot>> {
    ensure_transcript_loaded(kernel, session_ref).await?;
    let mut snapshot = None;
    let subscribed = kernel
        .data
        .borrow()
        .sessions
        .session_subscriptions
        .contains_key(&session_key(session_ref));
    if !subscribed {
        let opened: SessionSnapshot =
            driver_call(kernel.driver(), "openSession", args([json!(session_ref)])).await?;
        update_session_config(
            &mut kernel.data.borrow_mut(),
            session_ref,
            opened.config.as_ref(),
        );
        snapshot = Some(opened);
    }
    ensure_session_subscribed(kernel, session_ref).await?;
    refresh_session_commands(kernel, session_ref).await?;
    Ok(snapshot)
}

/// `ensureSessionSubscription`.
pub async fn ensure_session_subscription(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> CoreResult<()> {
    let subscribed = kernel
        .data
        .borrow()
        .sessions
        .session_subscriptions
        .contains_key(&session_key(session_ref));
    if !subscribed {
        let opened: SessionSnapshot =
            driver_call(kernel.driver(), "openSession", args([json!(session_ref)])).await?;
        let mut data = kernel.data.borrow_mut();
        update_session_config(&mut data, session_ref, opened.config.as_ref());
        update_queued_composer_messages(
            kernel,
            &mut data,
            session_ref,
            opened.queued_messages.as_deref(),
        );
    }
    ensure_session_subscribed(kernel, session_ref).await
}

/// `ensureSessionSubscribed`: claims the key before awaiting the host so a concurrent call does
/// not subscribe twice.
pub async fn ensure_session_subscribed(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> CoreResult<()> {
    let key = session_key(session_ref);
    if kernel
        .data
        .borrow()
        .sessions
        .session_subscriptions
        .contains_key(&key)
    {
        return Ok(());
    }
    let unsubscribe: Rc<RefCell<Option<Unsubscribe>>> = Rc::new(RefCell::new(None));
    let cancelled = Rc::new(Cell::new(false));
    let claim = Rc::new(Cell::new(0u8));
    let release: Box<dyn Fn()> = {
        let unsubscribe = unsubscribe.clone();
        let cancelled = cancelled.clone();
        let _claim = claim.clone();
        Box::new(move || {
            cancelled.set(true);
            if let Some(unsubscribe) = unsubscribe.borrow().as_ref() {
                unsubscribe();
            }
        })
    };
    kernel
        .data
        .borrow_mut()
        .sessions
        .session_subscriptions
        .insert(key.clone(), release);
    let listener_kernel = kernel.this_weak();
    let listener_key = key.clone();
    let listener: Rc<dyn Fn(Value)> = Rc::new(move |event| {
        if let Some(kernel) = listener_kernel.upgrade() {
            super::events::enqueue_session_event(&kernel, event, &listener_key);
        }
    });
    match kernel.driver().subscribe(session_ref, listener).await {
        Ok(stop) => {
            if cancelled.get() {
                stop();
            } else {
                *unsubscribe.borrow_mut() = Some(stop);
            }
            Ok(())
        }
        Err(error) => {
            // Only drop the claim if it is still ours.
            let mut data = kernel.data.borrow_mut();
            if !cancelled.get() && Rc::strong_count(&claim) > 1 {
                data.sessions.session_subscriptions.shift_remove(&key);
            }
            Err(error)
        }
    }
}

/// `ensureTranscriptLoaded`.
pub async fn ensure_transcript_loaded(kernel: &Kernel, session_ref: &SessionRef) -> CoreResult<()> {
    let key = session_key(session_ref);
    if kernel
        .data
        .borrow()
        .sessions
        .loaded_transcript_keys
        .contains(&key)
    {
        return Ok(());
    }
    load_transcript(kernel, session_ref).await
}

async fn load_transcript(kernel: &Kernel, session_ref: &SessionRef) -> CoreResult<()> {
    let key = session_key(session_ref);
    let items: Vec<SessionTranscriptItem> =
        driver_call(kernel.driver(), "getTranscript", args([json!(session_ref)])).await?;
    {
        let mut data = kernel.data.borrow_mut();
        let labels =
            extension_tool_labels(data.runtime_by_workspace.get(&session_ref.workspace_id));
        let transcript = timeline_from_driver_transcript(kernel.env(), items, &labels);
        data.sessions.loaded_transcript_keys.insert(key.clone());
        data.sessions.transcript_cache.insert(key, transcript);
    }
    record_selected_transcript_file_stat(kernel, session_ref).await;
    Ok(())
}

/// `reloadTranscriptFromDriver`.
pub async fn reload_transcript_from_driver(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> CoreResult<()> {
    load_transcript(kernel, session_ref).await?;
    publish::publish_selected_transcript_for(kernel, session_ref);
    Ok(())
}

/// `statSelectedTranscriptFile`.
pub async fn stat_selected_transcript_file(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> Option<(f64, u64)> {
    let path = kernel
        .driver()
        .call("getSessionFilePath", args([json!(session_ref)]))
        .await
        .ok()
        .flatten()?;
    let path = path.as_str()?.to_owned();
    if path.is_empty() {
        return None;
    }
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    let mtime_ms = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs_f64()
        * 1000.0;
    Some((mtime_ms, metadata.len()))
}

/// `recordSelectedTranscriptFileStat`.
async fn record_selected_transcript_file_stat(kernel: &Kernel, session_ref: &SessionRef) {
    let stats = stat_selected_transcript_file(kernel, session_ref).await;
    let key = session_key(session_ref);
    let mut data = kernel.data.borrow_mut();
    match stats {
        Some(stats) => {
            data.selected_transcript_file_stats.insert(key, stats);
        }
        None => {
            data.selected_transcript_file_stats.remove(&key);
        }
    }
}

/// `ensureSessionSchemaInfo`: read once per thread in the background; a file from a newer pi
/// republishes the transcript so its banner shows.
pub fn ensure_session_schema_info(kernel: &Kernel, session_ref: &SessionRef) {
    let key = session_key(session_ref);
    {
        let mut data = kernel.data.borrow_mut();
        if data.session_schema_info.contains_key(&key)
            || data.session_schema_info_in_flight.contains(&key)
        {
            return;
        }
        data.session_schema_info_in_flight.insert(key.clone());
    }
    let kernel = kernel.rc();
    let session_ref = session_ref.clone();
    tokio::task::spawn_local(async move {
        let result: CoreResult<SessionSchemaInfo> = driver_call(
            kernel.driver(),
            "getSessionSchemaInfo",
            args([json!(session_ref)]),
        )
        .await;
        match result {
            Ok(info) => {
                let newer = info.written_by_newer_runtime;
                kernel
                    .data
                    .borrow_mut()
                    .session_schema_info
                    .insert(key.clone(), info);
                if newer {
                    publish::publish_selected_transcript_for(&kernel, &session_ref);
                }
            }
            Err(error) => eprintln!(
                "[app-store] failed to read session schema info for {key}: {}",
                error.message
            ),
        }
        kernel
            .data
            .borrow_mut()
            .session_schema_info_in_flight
            .remove(&key);
    });
}

/// `getSelectedTranscriptForView`: the view's thread's transcript JSON and version.
pub async fn selected_transcript_for_view(
    kernel: &Kernel,
    view: &ViewState,
) -> CoreResult<Option<(SessionRef, u64, Rc<str>)>> {
    kernel.initialize().await;
    let Some(session_ref) = selected_session_ref_for_view(kernel, view) else {
        return Ok(None);
    };
    ensure_transcript_loaded(kernel, &session_ref).await?;
    let (version, json) = publish::selected_transcript_json(kernel, &session_ref);
    Ok(Some((session_ref, version, json)))
}

/// `selectedSessionRefForView`.
pub fn selected_session_ref_for_view(kernel: &Kernel, view: &ViewState) -> Option<SessionRef> {
    let data = kernel.data.borrow();
    let workspace_id = publish::resolve_view_workspace_id(&view.selected_workspace_id, &data.state);
    let session_id =
        publish::resolve_view_session_id(&workspace_id, &view.selected_session_id, &data.state);
    (!workspace_id.is_empty() && !session_id.is_empty())
        .then(|| session_ref(&workspace_id, &session_id))
}

// ---- Runtime and commands ----

/// `ensureRuntimeLoaded`.
pub async fn ensure_runtime_loaded(
    kernel: &Kernel,
    workspace_id: &str,
    workspaces: Option<&[WorkspaceEntry]>,
) -> CoreResult<()> {
    let workspace = {
        let data = kernel.data.borrow();
        if data.runtime_by_workspace.contains_key(workspace_id) {
            return Ok(());
        }
        data.workspace_ref(workspace_id).or_else(|| {
            workspaces?
                .iter()
                .find(|entry| entry.workspace_id == workspace_id)
                .map(workspace_ref_of)
        })
    };
    let Some(workspace) = workspace else {
        return Ok(());
    };
    let snapshot: RuntimeSnapshot = runtime_call(
        kernel.driver(),
        "getRuntimeSnapshot",
        args([json!(workspace)]),
    )
    .await?;
    kernel
        .data
        .borrow_mut()
        .runtime_by_workspace
        .insert(workspace_id.to_owned(), snapshot);
    settings::seed_settings_mtime_baseline(kernel, &workspace.path).await;
    Ok(())
}

/// `refreshSessionCommands`.
pub async fn refresh_session_commands(kernel: &Kernel, session_ref: &SessionRef) -> CoreResult<()> {
    let commands: Vec<RuntimeCommandRecord> = driver_call(
        kernel.driver(),
        "getSessionCommands",
        args([json!(session_ref)]),
    )
    .await?;
    kernel
        .data
        .borrow_mut()
        .sessions
        .session_commands_by_session
        .insert(session_key(session_ref), commands);
    Ok(())
}

/// `refreshSessionCommandsCoalesced`: at most one refresh per thread at a time, plus one
/// trailing refresh when more were asked for meanwhile. Publishes the result itself.
pub fn refresh_session_commands_coalesced(kernel: &Kernel, session_ref: &SessionRef) {
    let key = session_key(session_ref);
    {
        let mut data = kernel.data.borrow_mut();
        if let Some(dirty) = data.session_command_refreshers.get_mut(&key) {
            *dirty = true;
            return;
        }
        data.session_command_refreshers.insert(key.clone(), false);
    }
    let kernel = kernel.rc();
    let session_ref = session_ref.clone();
    tokio::task::spawn_local(async move {
        let mut refreshed = false;
        loop {
            let subscribed = {
                let mut data = kernel.data.borrow_mut();
                data.session_command_refreshers.insert(key.clone(), false);
                data.sessions.session_subscriptions.contains_key(&key)
            };
            if !subscribed {
                break;
            }
            match refresh_session_commands(&kernel, &session_ref).await {
                Ok(()) => refreshed = true,
                Err(error) => eprintln!(
                    "[app-store] coalesced session command refresh failed for {key}: {}",
                    error.message
                ),
            }
            if !kernel
                .data
                .borrow()
                .session_command_refreshers
                .get(&key)
                .copied()
                .unwrap_or(false)
            {
                break;
            }
        }
        let publish = {
            let mut data = kernel.data.borrow_mut();
            data.session_command_refreshers.remove(&key);
            if !data.sessions.session_subscriptions.contains_key(&key) {
                data.sessions.session_commands_by_session.shift_remove(&key);
                false
            } else if refreshed {
                sync_derived_session_state(&mut data, &session_ref);
                true
            } else {
                false
            }
        };
        if publish {
            publish::emit(&kernel);
        }
    });
}

// ---- Dialogs ----

/// `cancelPendingDialogsForSession`: unless another window still shows the thread.
pub async fn cancel_pending_dialogs_for_session(
    kernel: &Kernel,
    session_ref: &SessionRef,
    force: bool,
) -> CoreResult<()> {
    if !force
        && kernel
            .windows
            .is_session_visible_in_another_window(kernel, session_ref)
    {
        return Ok(());
    }
    let dialogs = {
        let mut data = kernel.data.borrow_mut();
        let key = session_key(session_ref);
        let Some(ui) = data.sessions.extension_ui_by_session.get_mut(&key) else {
            return Ok(());
        };
        if ui.pending_dialogs.is_empty() {
            return Ok(());
        }
        let dialogs = std::mem::take(&mut ui.pending_dialogs);
        for dialog in &dialogs {
            extensions::clear_dialog_timeout(&mut data, session_ref, dialog_request_id(dialog));
        }
        data.bump();
        sync_derived_session_state(&mut data, session_ref);
        dialogs
    };
    publish::emit(kernel);
    let responses = dialogs.iter().map(|dialog| {
        kernel.driver().call(
            "respondToHostUiRequest",
            args([
                json!(session_ref),
                json!({ "requestId": dialog_request_id(dialog), "cancelled": true }),
            ]),
        )
    });
    for result in super::futures_join_all(responses).await {
        result?;
    }
    Ok(())
}

/// The `requestId` every host UI request carries.
pub fn dialog_request_id(request: &crate::state::driver::HostUiRequest) -> &str {
    use crate::state::driver::HostUiRequest::*;
    match request {
        Confirm { request_id, .. }
        | Input { request_id, .. }
        | Select { request_id, .. }
        | Editor { request_id, .. }
        | Notify { request_id, .. }
        | Status { request_id, .. }
        | Widget { request_id, .. }
        | Title { request_id, .. }
        | EditorText { request_id, .. }
        | Reset { request_id }
        | Dismiss { request_id } => request_id,
    }
}

// ---- Auto titles and seeds ----

/// `setPendingAutoTitle`.
pub fn set_pending_auto_title(
    kernel: &Kernel,
    session_ref: &SessionRef,
    pending: PendingAutoTitle,
) {
    clear_pending_auto_title(kernel, session_ref);
    kernel
        .data
        .borrow_mut()
        .sessions
        .pending_auto_title_by_session
        .insert(session_key(session_ref), pending);
}

/// `clearPendingAutoTitle`: cancels a title request still in flight.
pub fn clear_pending_auto_title(kernel: &Kernel, session_ref: &SessionRef) {
    let pending = kernel
        .data
        .borrow_mut()
        .sessions
        .pending_auto_title_by_session
        .shift_remove(&session_key(session_ref));
    if let Some(pending) = pending {
        (pending.cancel)();
    }
}

/// `seedSession`: a thread the app just created starts with an empty, loaded transcript.
pub fn seed_session(data: &mut AppData, snapshot: &SessionSnapshot) {
    let key = session_key(&snapshot.session_ref);
    data.sessions
        .transcript_cache
        .insert(key.clone(), Vec::new());
    data.sessions.loaded_transcript_keys.insert(key);
    update_session_config(data, &snapshot.session_ref, snapshot.config.as_ref());
    update_session_usage(data, &snapshot.session_ref, snapshot.usage.as_ref());
}

impl Kernel {
    /// A weak handle, for listeners the driver keeps.
    pub fn this_weak(&self) -> std::rc::Weak<Kernel> {
        self.this.clone()
    }
}
