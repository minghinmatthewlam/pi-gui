//! `refreshState`: rebuilds the sidebar from pi's catalog, one refresh at a time, and the
//! selection epoch that tells a background thread hydration it has been overtaken.

use super::{
    conversation, orchestration, persist, publish, sessions, settings, ui, workspace, Kernel,
};
use crate::error::CoreResult;
use crate::js::JsNumber;
use crate::persistence::catalog::{SessionEntry, WorkspaceEntry};
use crate::state::app_store_utils::{
    build_workspace_records, build_worktree_records, SessionRecordSources,
};
use crate::state::desktop_state::{AppView, ComposerDraftSyncSource, DesktopAppState};
use crate::state::driver::{session_key, session_ref, SessionStatus};
use crate::state::extension_command_compatibility::{
    prune_compatibility_for_runtime_snapshot, serialize_compatibility_by_workspace,
};
use crate::state::session_state_map::serialize_extension_ui_state;
use std::cell::Cell;
use std::collections::HashSet;

/// `RefreshStateOptions`.
#[derive(Debug, Clone, Default)]
pub struct RefreshOptions {
    pub selected_workspace_id: Option<String>,
    pub selected_session_id: Option<String>,
    pub composer_draft: Option<String>,
    pub composer_draft_sync_source: Option<ComposerDraftSyncSource>,
    pub clear_last_error: bool,
    pub refresh_worktrees: bool,
    pub active_view: Option<AppView>,
    pub mark_selected_session_viewed: Option<bool>,
    pub hydrate_selected_session: Option<bool>,
    pub emit_state: Option<bool>,
    pub persist_state: Option<bool>,
    pub publish_selected_transcript: Option<bool>,
}

/// Refreshes run one at a time, in the order they were asked for (`refreshStateQueue`).
#[derive(Default)]
pub struct RefreshQueue {
    lock: tokio::sync::Mutex<()>,
    /// `refreshStateDepth`: how many refreshes are running now.
    depth: Cell<u32>,
    /// `selectionEpoch`: bumped by each thread switch.
    selection_epoch: Cell<u64>,
}

impl RefreshQueue {
    pub fn depth(&self) -> u32 {
        self.depth.get()
    }

    /// Starts a new selection; hydrations under older epochs stop publishing.
    pub fn next_selection_epoch(&self) -> u64 {
        let next = self.selection_epoch.get() + 1;
        self.selection_epoch.set(next);
        next
    }

    pub fn selection_epoch(&self) -> u64 {
        self.selection_epoch.get()
    }
}

/// Keeps `depth` right however the refresh ends, including when its future is dropped.
struct DepthGuard<'a>(&'a Cell<u32>);

impl<'a> DepthGuard<'a> {
    fn enter(depth: &'a Cell<u32>) -> Self {
        depth.set(depth.get() + 1);
        Self(depth)
    }
}

impl Drop for DepthGuard<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get().saturating_sub(1));
    }
}

/// `refreshState`: waits for earlier refreshes, whether they failed or not.
pub async fn refresh_state(
    kernel: &Kernel,
    options: RefreshOptions,
) -> CoreResult<DesktopAppState> {
    let _turn = kernel.refresh.lock.lock().await;
    Box::pin(refresh_state_now(kernel, options)).await
}

/// `resolveSelectedWorkspaceIdFromCatalog`.
fn resolve_selected_workspace_id(preferred: &str, workspaces: &[WorkspaceEntry]) -> String {
    if !preferred.is_empty()
        && workspaces
            .iter()
            .any(|entry| entry.workspace_id == preferred)
    {
        return preferred.to_owned();
    }
    workspaces
        .first()
        .map(|entry| entry.workspace_id.clone())
        .unwrap_or_default()
}

/// `resolveSelectedSessionIdFromCatalog`.
fn resolve_selected_session_id(
    workspace_id: &str,
    preferred: &str,
    sessions: &[SessionEntry],
) -> String {
    let mut in_workspace = sessions
        .iter()
        .filter(|session| session.workspace_id == workspace_id)
        .peekable();
    let Some(first) = in_workspace
        .peek()
        .map(|session| session.session_ref.session_id.clone())
    else {
        return String::new();
    };
    if !preferred.is_empty()
        && in_workspace.any(|session| session.session_ref.session_id == preferred)
    {
        return preferred.to_owned();
    }
    first
}

/// `refreshStateNow`.
async fn refresh_state_now(
    kernel: &Kernel,
    options: RefreshOptions,
) -> CoreResult<DesktopAppState> {
    let _depth = DepthGuard::enter(&kernel.refresh.depth);
    let (previous_selected_key, selection_at_start) = {
        let data = kernel.data.borrow();
        (
            data.selected_session_key(),
            (
                data.state.selected_workspace_id.clone(),
                data.state.selected_session_id.clone(),
            ),
        )
    };
    let (workspaces_snapshot, sessions_snapshot) = tokio::join!(
        sessions::list_workspaces(kernel),
        sessions::list_sessions(kernel)
    );
    let catalog_workspaces = workspaces_snapshot?;
    let catalog_sessions = sessions_snapshot?;
    let worktree_entries = if options.refresh_worktrees {
        workspace::sync_and_list_worktrees(kernel, &catalog_workspaces).await?
    } else {
        workspace::list_worktrees(kernel).await?
    };

    prune_stale_session_subscriptions(kernel, &catalog_sessions).await?;
    ensure_subscriptions_for_sessions(kernel, &catalog_sessions).await?;

    let (selected_workspace_id, selected_session_id) = {
        let data = kernel.data.borrow();
        let workspace_id = resolve_selected_workspace_id(
            options
                .selected_workspace_id
                .as_deref()
                .unwrap_or(&data.state.selected_workspace_id),
            &catalog_workspaces,
        );
        let session_id = resolve_selected_session_id(
            &workspace_id,
            options
                .selected_session_id
                .as_deref()
                .unwrap_or(&data.state.selected_session_id),
            &catalog_sessions,
        );
        (workspace_id, session_id)
    };

    if !selected_workspace_id.is_empty()
        && !selected_session_id.is_empty()
        && options.hydrate_selected_session != Some(false)
    {
        let target = session_ref(&selected_workspace_id, &selected_session_id);
        Box::pin(sessions::ensure_session_ready(kernel, &target)).await?;
        conversation::ensure_composer_attachments_loaded(kernel, &target).await?;
    }

    let (workspaces, worktrees_by_workspace, live_workspace_ids) = {
        let mut data = kernel.data.borrow_mut();
        let sessions = &data.sessions;
        let workspaces = build_workspace_records(
            &catalog_workspaces,
            &worktree_entries,
            &catalog_sessions,
            &SessionRecordSources {
                transcript_cache: &sessions.transcript_cache,
                running_since_by_session: &sessions.running_since_by_session,
                session_config_by_session: &sessions.session_config_by_session,
                last_viewed_at_by_session: &sessions.last_viewed_at_by_session,
                last_interacted_at_by_session: &sessions.last_interacted_at_by_session,
                pinned_at_by_session: &sessions.pinned_at_by_session,
            },
        );
        let worktrees_by_workspace = build_worktree_records(&catalog_workspaces, &worktree_entries);
        let live: HashSet<String> = workspaces.iter().map(|record| record.id.clone()).collect();
        data.runtime_by_workspace.retain(|id, _| live.contains(id));
        data.compatibility_by_workspace
            .retain(|id, _| live.contains(id));
        data.extension_flags_by_workspace
            .retain(|id, _| live.contains(id));
        (workspaces, worktrees_by_workspace, live)
    };

    let selected_runtime_missing = !selected_workspace_id.is_empty()
        && !kernel
            .data
            .borrow()
            .runtime_by_workspace
            .contains_key(&selected_workspace_id);
    if selected_runtime_missing {
        sessions::ensure_runtime_loaded(kernel, &selected_workspace_id, Some(&catalog_workspaces))
            .await?;
    }
    let secondary: Vec<&WorkspaceEntry> = {
        let data = kernel.data.borrow();
        catalog_workspaces
            .iter()
            .filter(|entry| entry.workspace_id != selected_workspace_id)
            .filter(|entry| !data.runtime_by_workspace.contains_key(&entry.workspace_id))
            .collect()
    };
    let loads = super::futures_join_all(secondary.iter().map(|entry| {
        sessions::ensure_runtime_loaded(kernel, &entry.workspace_id, Some(&catalog_workspaces))
    }))
    .await;
    for (entry, result) in secondary.iter().zip(loads) {
        if let Err(error) = result {
            eprintln!(
                "[pi-gui] Failed to preload runtime for {}: {}",
                entry.path, error.message
            );
        }
    }
    {
        let mut data = kernel.data.borrow_mut();
        let data = &mut *data;
        for runtime in data.runtime_by_workspace.values() {
            prune_compatibility_for_runtime_snapshot(
                &mut data.compatibility_by_workspace,
                Some(runtime),
            );
        }
    }

    let preferred_settings_workspace = if selected_workspace_id.is_empty() {
        catalog_workspaces
            .first()
            .map(|entry| entry.workspace_id.clone())
    } else {
        Some(selected_workspace_id.clone())
    };
    let live_global = settings::load_live_global_model_settings(
        kernel,
        &catalog_workspaces,
        preferred_settings_workspace.as_deref(),
    )
    .await?;
    let (per_repo, stored_global) = {
        let data = kernel.data.borrow();
        (
            data.state.model_settings_scope_mode
                == crate::state::desktop_state::ModelSettingsScopeMode::PerRepo,
            data.state.global_model_settings.clone(),
        )
    };
    let global_model_settings = if per_repo && settings::has_stored_model_settings(&stored_global) {
        stored_global
    } else {
        live_global.clone()
    };
    if per_repo
        && settings::has_stored_model_settings(&global_model_settings)
        && global_model_settings != live_global
    {
        settings::restore_global_model_settings(
            kernel,
            &global_model_settings,
            &catalog_workspaces,
            &selected_workspace_id,
        )
        .await?;
    }
    let scoped = if per_repo {
        Some(
            settings::load_scoped_model_settings_by_workspace(
                kernel,
                &workspaces,
                &catalog_workspaces,
                &global_model_settings,
            )
            .await?,
        )
    } else {
        None
    };

    {
        let mut data = kernel.data.borrow_mut();
        let runtime_by_workspace =
            settings::serialize_effective_runtime_state(&data, &workspaces, scoped.as_ref());
        let pinned_session_order = ui::reconcile_pinned_session_order(
            &data.sessions.pinned_at_by_session,
            &data.sessions.pinned_session_order,
        );
        data.sessions.pinned_session_order = pinned_session_order.clone();

        // Refreshes run outside the window action queue (a send refreshes when its turn
        // ends), so a thread switch can land while this one awaits. That switch is newer than
        // the selection resolved above: keep it, its view and its draft. The switch hydrates
        // its own thread.
        let selection_moved = data.state.selected_workspace_id != selection_at_start.0
            || data.state.selected_session_id != selection_at_start.1;
        let (workspace_id, session_id) = if selection_moved {
            (
                data.state.selected_workspace_id.clone(),
                data.state.selected_session_id.clone(),
            )
        } else {
            (selected_workspace_id.clone(), selected_session_id.clone())
        };
        let (draft, draft_source) = if selection_moved {
            (None, None)
        } else {
            (
                options.composer_draft.clone(),
                options.composer_draft_sync_source,
            )
        };
        let active_view = if selection_moved {
            data.state.active_view
        } else {
            options.active_view.unwrap_or(data.state.active_view)
        };
        let (sync_source, sync_nonce) = sessions::resolve_composer_draft_sync(
            &mut data,
            &workspace_id,
            &session_id,
            draft_source,
        );
        let composer_draft = sessions::resolve_composer_draft(
            &mut data,
            &workspace_id,
            &session_id,
            draft.as_deref(),
        );
        let composer_attachments =
            sessions::resolve_composer_attachments(&data, &workspace_id, &session_id);
        let queued = sessions::resolve_queued_composer_messages(&data, &workspace_id, &session_id);
        let editing =
            sessions::resolve_editing_queued_message_id(&data, &workspace_id, &session_id);
        let last_error = sessions::resolve_selected_session_error(
            &mut data,
            &workspace_id,
            &session_id,
            options.clear_last_error,
        );
        let session_commands = data.sessions.session_commands_by_session.clone();
        let session_usage = data.sessions.session_usage_by_session.clone();
        let extension_ui = data
            .sessions
            .extension_ui_by_session
            .iter()
            .map(|(key, value)| (key.clone(), serialize_extension_ui_state(value)))
            .collect();
        let compatibility = serialize_compatibility_by_workspace(&data.compatibility_by_workspace);
        let flags_by_workspace = data.extension_flags_by_workspace.clone();
        let flags_by_session = data.sessions.extension_flags_by_session.clone();
        let last_viewed = data.sessions.last_viewed_at_by_session.clone();
        let last_interacted = data.sessions.last_interacted_at_by_session.clone();
        let pinned_at = data.sessions.pinned_at_by_session.clone();
        let state = &mut data.state;
        state.workspaces = workspaces;
        state.worktrees_by_workspace = worktrees_by_workspace;
        state.selected_workspace_id = workspace_id;
        state.selected_session_id = session_id;
        state.active_view = active_view;
        state.runtime_by_workspace = runtime_by_workspace;
        state.session_commands_by_session = session_commands;
        state.session_usage_by_session = session_usage;
        state.session_extension_ui_by_session = extension_ui;
        state.extension_command_compatibility_by_workspace = compatibility;
        state.extension_flags_by_workspace = flags_by_workspace;
        state.extension_flags_by_session = flags_by_session;
        state.last_viewed_at_by_session = last_viewed;
        state.last_interacted_at_by_session = last_interacted;
        state.pinned_at_by_session = pinned_at;
        state.pinned_session_order = pinned_session_order;
        state
            .collapsed_workspace_ids
            .retain(|id| live_workspace_ids.contains(id));
        state.global_model_settings = global_model_settings;
        state.composer_draft = composer_draft;
        state.composer_draft_sync_source = sync_source;
        state.composer_draft_sync_nonce = JsNumber(sync_nonce);
        state.composer_attachments = composer_attachments;
        state.queued_composer_messages = queued;
        state.editing_queued_message_id = editing;
        state.last_error = last_error;
        state.revision = JsNumber(state.revision.0 + 1.0);
    }
    orchestration::hydrate_orchestration_children(kernel).await?;
    let children = orchestration::project_orchestration_children(kernel);
    kernel.data.borrow_mut().state.orchestration_children = children;
    orchestration::schedule_supervision(kernel);

    if options.mark_selected_session_viewed.unwrap_or(true) {
        sessions::mark_selected_session_viewed_if_visible(kernel);
    }
    if options.persist_state.unwrap_or(true) {
        persist::persist_ui_state(kernel).await?;
    }
    let snapshot = if options.emit_state == Some(false) {
        sessions::snapshot(kernel)
    } else {
        publish::emit(kernel)
    };
    if options.publish_selected_transcript.unwrap_or(true)
        && kernel.data.borrow().selected_session_key() != previous_selected_key
    {
        publish::publish_selected_transcript(kernel);
    }
    Ok(snapshot)
}

/// `pruneStaleSessionSubscriptions`: forgets threads pi no longer lists.
async fn prune_stale_session_subscriptions(
    kernel: &Kernel,
    entries: &[SessionEntry],
) -> CoreResult<()> {
    let active: HashSet<String> = entries
        .iter()
        .map(|entry| session_key(&entry.session_ref))
        .collect();
    let changed = {
        let mut data = kernel.data.borrow_mut();
        let persisted_changed = data.sessions.prune(&active);
        data.session_schema_info
            .retain(|key, _| active.contains(key));
        // `pruneOrphanedUiState`.
        let mut changed = data.sessions.prune_persisted_ui_state(&active) || persisted_changed;
        let before = data.task_workbench_templates_by_session.len();
        data.task_workbench_templates_by_session
            .retain(|key, _| active.contains(key));
        changed |= data.task_workbench_templates_by_session.len() != before;
        changed
    };
    if changed {
        persist::schedule_persist_ui_state(kernel);
    }
    conversation::prune_orphaned_attachment_files(kernel, &active).await
}

/// `ensureSubscriptionsForSessions`: running threads stay subscribed so their events land.
async fn ensure_subscriptions_for_sessions(
    kernel: &Kernel,
    entries: &[SessionEntry],
) -> CoreResult<()> {
    for entry in entries {
        if entry.status != SessionStatus::Running {
            continue;
        }
        Box::pin(sessions::ensure_session_subscription(
            kernel,
            &entry.session_ref,
        ))
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_selection_gets_a_newer_epoch() {
        let queue = RefreshQueue::default();
        assert_eq!(queue.selection_epoch(), 0);
        let first = queue.next_selection_epoch();
        let second = queue.next_selection_epoch();
        assert!(second > first);
        assert_eq!(queue.selection_epoch(), second);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn depth_counts_running_refreshes_and_unwinds_on_drop() {
        let queue = RefreshQueue::default();
        {
            let _outer = DepthGuard::enter(&queue.depth);
            let _inner = DepthGuard::enter(&queue.depth);
            assert_eq!(queue.depth(), 2);
        }
        assert_eq!(queue.depth(), 0);
    }

    #[test]
    fn catalog_selection_falls_back_to_the_first_entry() {
        let workspace = |id: &str| -> WorkspaceEntry {
            serde_json::from_value(serde_json::json!({
                "workspaceId": id, "path": format!("/{id}"), "displayName": id,
                "lastOpenedAt": "", "sortOrder": 0
            }))
            .unwrap()
        };
        let session = |workspace: &str, id: &str| -> SessionEntry {
            serde_json::from_value(serde_json::json!({
                "sessionRef": { "workspaceId": workspace, "sessionId": id },
                "workspaceId": workspace, "title": id, "updatedAt": "", "status": "idle"
            }))
            .unwrap()
        };
        let workspaces = [workspace("a"), workspace("b")];
        assert_eq!(resolve_selected_workspace_id("b", &workspaces), "b");
        assert_eq!(resolve_selected_workspace_id("gone", &workspaces), "a");
        assert_eq!(resolve_selected_workspace_id("", &[]), "");
        let sessions = [session("a", "1"), session("b", "2"), session("b", "3")];
        assert_eq!(resolve_selected_session_id("b", "3", &sessions), "3");
        assert_eq!(resolve_selected_session_id("b", "1", &sessions), "2");
        assert_eq!(resolve_selected_session_id("c", "1", &sessions), "");
    }
}
