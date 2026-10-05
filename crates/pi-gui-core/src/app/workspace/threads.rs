//! A thread's own metadata: its title, archiving, read mark and pin, and the pinned order
//! (`workspace/app-store-workspace.ts` and the pin and read methods of `app-store.ts`).

use super::super::dispatch::{self, MethodTable};
use super::super::pi::args;
use super::super::refresh::{self, RefreshOptions};
use super::super::validation;
use super::super::{persist, sessions, ui, AppData, Kernel};
use crate::error::CoreResult;
use crate::state::desktop_state::{AppView, DesktopAppState, WorkspaceKind};
use crate::state::driver::{session_key, SessionRef};
use serde_json::json;
use std::cmp::Ordering;

pub fn register(table: &mut MethodTable) {
    table.on("renameSession", |kernel, call| {
        Box::pin(async move {
            let target = validation::expect_session_target(call.arg(0), "target")?;
            let title = validation::expect_string(call.arg(1), "title")?;
            dispatch::run(&kernel, &call, || rename_session(&kernel, &target, &title)).await
        })
    });
    table.on("archiveSession", |kernel, call| {
        Box::pin(async move {
            let target = validation::expect_session_target(call.arg(0), "target")?;
            dispatch::run(&kernel, &call, || archive_session(&kernel, &target)).await
        })
    });
    table.on("unarchiveSession", |kernel, call| {
        Box::pin(async move {
            let target = validation::expect_session_target(call.arg(0), "target")?;
            dispatch::run(&kernel, &call, || unarchive_session(&kernel, &target)).await
        })
    });
    table.on("markSessionRead", |kernel, call| {
        Box::pin(async move {
            let target = validation::expect_session_target(call.arg(0), "target")?;
            dispatch::run(&kernel, &call, || mark_session_read(&kernel, &target)).await
        })
    });
    table.on("setSessionPinned", |kernel, call| {
        Box::pin(async move {
            let target = validation::expect_session_target(call.arg(0), "target")?;
            let pinned = validation::expect_boolean(call.arg(1), "pinned")?;
            // Pin metadata names its thread and must not wait for a running prompt to finish.
            dispatch::immediate(&kernel, &call, set_session_pinned(&kernel, &target, pinned)).await
        })
    });
    table.on("reorderPinnedSessions", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let order = validation::expect_string_array(call.arg(0), "order")?;
                reorder_pinned_sessions(&kernel, &order).await
            })
            .await
        })
    });
}

fn unknown_session(target: &SessionRef) -> String {
    format!(
        "Unknown session: {}:{}",
        target.workspace_id, target.session_id
    )
}

/// A refresh that keeps the current selection.
fn keep_selection(data: &AppData) -> RefreshOptions {
    RefreshOptions {
        selected_workspace_id: Some(data.state.selected_workspace_id.clone()),
        selected_session_id: Some(data.state.selected_session_id.clone()),
        clear_last_error: true,
        ..Default::default()
    }
}

/// `renameSession`: a title the user chose replaces any auto-title still coming.
pub async fn rename_session(
    kernel: &Kernel,
    target: &SessionRef,
    title: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let title = crate::js::trim(title);
    if title.is_empty() {
        return sessions::with_error(kernel, "Thread title cannot be empty.".into()).await;
    }
    sessions::with_error_handling(kernel, async {
        if kernel.data.borrow().session(target).is_none() {
            return sessions::with_error(kernel, unknown_session(target)).await;
        }
        sessions::clear_pending_auto_title(kernel, target);
        kernel
            .driver()
            .call("renameSession", args([json!(target), json!(title)]))
            .await?;
        let options = keep_selection(&kernel.data.borrow());
        refresh::refresh_state(kernel, options).await
    })
    .await
}

/// `unpinSession`.
fn unpin_session(data: &mut AppData, session_ref: &SessionRef) {
    let key = session_key(session_ref);
    data.sessions.pinned_at_by_session.shift_remove(&key);
    data.sessions
        .pinned_session_order
        .retain(|entry| *entry != key);
}

/// `archiveSession`: an archived thread is never pinned. Archiving the selected thread
/// selects the next one in its repository.
pub async fn archive_session(kernel: &Kernel, target: &SessionRef) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    sessions::with_error_handling(kernel, async {
        sessions::clear_pending_auto_title(kernel, target);
        unpin_session(&mut kernel.data.borrow_mut(), target);
        kernel
            .driver()
            .call("archiveSession", args([json!(target)]))
            .await?;
        let options = selection_after_archiving(&kernel.data.borrow(), target);
        refresh::refresh_state(kernel, options).await
    })
    .await
}

/// `selectionAfterArchiving`: the newest other thread of the same repository, preferring the
/// archived thread's own folder.
fn selection_after_archiving(data: &AppData, target: &SessionRef) -> RefreshOptions {
    let state = &data.state;
    let keep = RefreshOptions {
        active_view: Some(AppView::Threads),
        ..keep_selection(data)
    };
    if !data.is_selected(target) {
        return keep;
    }
    let Some(workspace) = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == target.workspace_id)
    else {
        return keep;
    };
    let root_id = match workspace.kind {
        WorkspaceKind::Worktree => workspace
            .root_workspace_id
            .clone()
            .unwrap_or_else(|| workspace.id.clone()),
        WorkspaceKind::Primary => workspace.id.clone(),
    };
    let mut candidates: Vec<_> = state
        .workspaces
        .iter()
        .filter(|entry| {
            entry.id == root_id || entry.root_workspace_id.as_deref() == Some(root_id.as_str())
        })
        .flat_map(|entry| {
            entry
                .sessions
                .iter()
                .filter(|session| {
                    (session.id != target.session_id || entry.id != target.workspace_id)
                        && session.archived_at.is_none()
                })
                .map(move |session| (entry.id.as_str(), session))
        })
        .collect();
    candidates.sort_by(|(left_workspace, left), (right_workspace, right)| {
        let left_home = *left_workspace == target.workspace_id;
        let right_home = *right_workspace == target.workspace_id;
        if left_home != right_home {
            return if left_home {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        if left.updated_at != right.updated_at {
            return crate::locale::compare(&right.updated_at, &left.updated_at);
        }
        crate::locale::compare(&left.title, &right.title)
    });
    let next = candidates.first();
    RefreshOptions {
        selected_workspace_id: Some(
            next.map(|(workspace_id, _)| (*workspace_id).to_owned())
                .unwrap_or_else(|| target.workspace_id.clone()),
        ),
        selected_session_id: Some(
            next.map(|(_, session)| session.id.clone())
                .unwrap_or_default(),
        ),
        clear_last_error: true,
        active_view: Some(AppView::Threads),
        ..Default::default()
    }
}

/// `unarchiveSession`: selects the thread when its folder has none selected.
pub async fn unarchive_session(
    kernel: &Kernel,
    target: &SessionRef,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    sessions::with_error_handling(kernel, async {
        sessions::clear_pending_auto_title(kernel, target);
        kernel
            .driver()
            .call("unarchiveSession", args([json!(target)]))
            .await?;
        let options = {
            let state = &kernel.data.borrow().state;
            RefreshOptions {
                selected_workspace_id: Some(state.selected_workspace_id.clone()),
                selected_session_id: Some(
                    if state.selected_workspace_id == target.workspace_id
                        && state.selected_session_id.is_empty()
                    {
                        target.session_id.clone()
                    } else {
                        state.selected_session_id.clone()
                    },
                ),
                clear_last_error: true,
                active_view: Some(AppView::Threads),
                ..Default::default()
            }
        };
        refresh::refresh_state(kernel, options).await
    })
    .await
}

/// `markSessionRead`.
pub async fn mark_session_read(
    kernel: &Kernel,
    target: &SessionRef,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    if kernel.data.borrow().session(target).is_none() {
        return sessions::with_error(kernel, unknown_session(target)).await;
    }
    {
        let mut data = kernel.data.borrow_mut();
        if !sessions::mark_session_viewed(kernel, &mut data, target) {
            return Ok(data.state.clone());
        }
        data.state.last_error = None;
        data.bump();
    }
    persist::persist_and_emit(kernel).await
}

/// `setSessionPinned`: a new pin goes first in the pinned order; an archived thread cannot be
/// pinned.
pub async fn set_session_pinned(
    kernel: &Kernel,
    target: &SessionRef,
    pinned: bool,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some((archived, session_pinned_at)) = kernel
        .data
        .borrow()
        .session(target)
        .map(|session| (session.archived_at.is_some(), session.pinned_at.clone()))
    else {
        return sessions::with_error(kernel, unknown_session(target)).await;
    };
    if pinned && archived {
        return sessions::with_error(
            kernel,
            format!(
                "Cannot pin archived session: {}:{}",
                target.workspace_id, target.session_id
            ),
        )
        .await;
    }
    let now = kernel.env().now_iso();
    {
        let mut data = kernel.data.borrow_mut();
        let key = session_key(target);
        let current = data.sessions.pinned_at_by_session.get(&key).cloned();
        let next = if pinned {
            Some(current.clone().unwrap_or(now))
        } else {
            None
        };
        if current == next && session_pinned_at == next {
            return Ok(data.state.clone());
        }
        match &next {
            Some(pinned_at) => {
                data.sessions
                    .pinned_at_by_session
                    .insert(key.clone(), pinned_at.clone());
                data.sessions
                    .pinned_session_order
                    .retain(|entry| *entry != key);
                data.sessions.pinned_session_order.insert(0, key);
            }
            None => unpin_session(&mut data, target),
        }
        let order = ui::reconcile_pinned_session_order(
            &data.sessions.pinned_at_by_session,
            &data.sessions.pinned_session_order,
        );
        data.sessions.pinned_session_order = order.clone();
        for workspace in &mut data.state.workspaces {
            if workspace.id != target.workspace_id {
                continue;
            }
            for session in &mut workspace.sessions {
                if session.id == target.session_id {
                    session.pinned_at = next.clone();
                }
            }
        }
        data.state.pinned_at_by_session = data.sessions.pinned_at_by_session.clone();
        data.state.pinned_session_order = order;
        data.state.last_error = None;
        data.bump();
    }
    persist::persist_and_emit(kernel).await
}

/// `reorderPinnedSessions`.
pub async fn reorder_pinned_sessions(
    kernel: &Kernel,
    order: &[String],
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    {
        let mut data = kernel.data.borrow_mut();
        let order = ui::reconcile_pinned_session_order(&data.sessions.pinned_at_by_session, order);
        data.sessions.pinned_session_order = order.clone();
        data.state.pinned_session_order = order;
        data.state.last_error = None;
        data.bump();
    }
    persist::persist_and_emit(kernel).await
}
