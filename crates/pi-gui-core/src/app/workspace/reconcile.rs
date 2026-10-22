//! The rescan when a window gains focus (`reconcileWorkspaceOnFocus` in `app-store.ts`): there
//! is no file watcher, so returning to the app picks up threads, settings and transcript turns
//! written outside it, such as by the pi CLI. One rescan per folder runs at a time.

use super::super::refresh::{self, RefreshOptions};
use super::super::{sessions, settings, Kernel};
use crate::error::CoreResult;
use crate::state::driver::session_key;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

/// The rescans waiting or running, by folder.
#[derive(Default)]
pub struct ReconcileQueues {
    queues: HashMap<String, Rc<tokio::sync::Mutex<()>>>,
}

/// `reconcileWorkspaceOnFocus`: queued behind any rescan of the same folder still running. A
/// failure is logged so it cannot wedge the queue.
pub fn reconcile_on_focus(kernel: &Kernel, workspace_id: &str) {
    let queue = kernel
        .data
        .borrow_mut()
        .workspace
        .reconcile
        .queues
        .entry(workspace_id.to_owned())
        .or_default()
        .clone();
    let kernel = kernel.rc();
    let workspace_id = workspace_id.to_owned();
    tokio::task::spawn_local(async move {
        let turn = queue.lock().await;
        if let Err(error) = reconcile_workspace_from_disk(&kernel, &workspace_id).await {
            eprintln!(
                "[app-store] workspace reconcile failed for {workspace_id}: {}",
                error.message
            );
        }
        drop(turn);
        // The last rescan of the folder removes its queue.
        let mut data = kernel.data.borrow_mut();
        let queues = &mut data.workspace.reconcile.queues;
        if queues
            .get(&workspace_id)
            .is_some_and(|current| Rc::ptr_eq(current, &queue) && Rc::strong_count(&queue) == 2)
        {
            queues.remove(&workspace_id);
        }
    });
}

/// `reconcileWorkspaceFromDisk`.
async fn reconcile_workspace_from_disk(kernel: &Kernel, workspace_id: &str) -> CoreResult<()> {
    // Rescans pi's session folder into the catalog so a thread made elsewhere appears. Open
    // sessions are not reloaded: that would reset their extension UI, dropping pending
    // dialogs other windows still show. The selected transcript is refreshed below instead.
    kernel
        .driver()
        .call(
            "reconcileWorkspace",
            super::super::pi::args([json!(workspace_id)]),
        )
        .await?;
    // A file replaced outside the app can change its schema version; it is read again on the
    // next publish.
    let prefix = format!("{workspace_id}:");
    kernel
        .data
        .borrow_mut()
        .session_schema_info
        .retain(|key, _| !key.starts_with(&prefix));
    // Before the refresh, so its one emit carries the reloaded runtime.
    reload_settings_if_changed_on_focus(kernel, workspace_id).await?;
    refresh::refresh_state(
        kernel,
        RefreshOptions {
            persist_state: Some(false),
            ..Default::default()
        },
    )
    .await?;
    reload_selected_transcript_if_changed_on_focus(kernel, workspace_id).await
}

/// `reloadSettingsIfChangedOnFocus`: reloads the runtime only when a settings file changed
/// since the last look. The first look only records the times, and the app's own writes
/// update them, so its own edits never read as outside ones.
async fn reload_settings_if_changed_on_focus(
    kernel: &Kernel,
    workspace_id: &str,
) -> CoreResult<()> {
    let Some(workspace) = kernel.data.borrow().workspace_ref(workspace_id) else {
        return Ok(());
    };
    let files = [
        settings::global_settings_path(),
        Path::new(&workspace.path).join(".pi").join("settings.json"),
    ];
    let mut changed = false;
    for file in files {
        let Some(mtime) = settings::stat_mtime_ms(&file).await else {
            continue;
        };
        let previous = kernel
            .data
            .borrow_mut()
            .settings_file_mtimes
            .insert(file, mtime);
        if previous.is_some_and(|previous| previous != mtime) {
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    let snapshot = settings::refresh_runtime_snapshot(kernel, &workspace).await?;
    kernel
        .data
        .borrow_mut()
        .runtime_by_workspace
        .insert(workspace_id.to_owned(), snapshot);
    Ok(())
}

/// `reloadSelectedTranscriptIfChangedOnFocus`: republishes the shown transcript only when its
/// file changed (an append from the pi CLI), so an unchanged thread never restores its scroll.
/// A running thread is skipped: its events already drive the transcript.
async fn reload_selected_transcript_if_changed_on_focus(
    kernel: &Kernel,
    workspace_id: &str,
) -> CoreResult<()> {
    let (selected, previous) = {
        let data = kernel.data.borrow();
        let Some(selected) = data.selected_session_ref() else {
            return Ok(());
        };
        let key = session_key(&selected);
        if selected.workspace_id != workspace_id
            || data.sessions.running_since_by_session.contains_key(&key)
        {
            return Ok(());
        }
        let previous = data.selected_transcript_file_stats.get(&key).copied();
        (selected, previous)
    };
    let Some(current) = sessions::stat_selected_transcript_file(kernel, &selected).await else {
        return Ok(());
    };
    if previous == Some(current) {
        return Ok(());
    }
    // Reloading records the new times, so a later unchanged focus does nothing.
    sessions::reload_transcript_from_driver(kernel, &selected).await
}
