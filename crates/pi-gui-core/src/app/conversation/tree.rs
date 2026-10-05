//! A thread's history as a tree: reading it, moving to another branch (`/tree`), and forking
//! a new thread from a message.

use crate::app::dispatch::{self, MethodTable, Reply};
use crate::app::pi::{args, driver_call};
use crate::app::refresh::{self, RefreshOptions};
use crate::app::workspace::{
    build_worktree_options, record_extension_flags, rollback_worktree, set_active_session,
};
use crate::app::{sessions, validation, Kernel};
use crate::error::CoreResult;
use crate::persistence::catalog::WorktreeEntry;
use crate::state::desktop_state::{AppView, ComposerDraftSyncSource, DesktopAppState};
use crate::state::driver::{session_key, session_ref, SessionRef, SessionSnapshot};
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub fn register(table: &mut MethodTable) {
    table.on("getSessionTree", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let target = validation::expect_session_target(call.arg(0), "target")?;
            get_session_tree(&kernel, &target).await.map(Reply::Value)
        })
    });
    table.on("navigateSessionTree", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let target = validation::expect_session_target(call.arg(0), "target")?;
            let target_id = validation::expect_non_empty_string(call.arg(1), "targetId")?;
            let options = validation::expect_navigate_session_tree_options(call.arg(2))?;
            dispatch::run_result(&kernel, &call, || {
                navigate_session_tree(&kernel, &target, &target_id, options)
            })
            .await
        })
    });
    table.on("forkThread", |kernel, call| {
        Box::pin(async move {
            let input = call.arg(0).cloned();
            dispatch::run(&kernel, &call, || async {
                let input = validation::expect_fork_thread_input(input.as_ref())?;
                fork_thread(&kernel, input).await
            })
            .await
        })
    });
}

/// `getSessionTree`.
pub async fn get_session_tree(kernel: &Kernel, target: &SessionRef) -> CoreResult<Value> {
    kernel.initialize().await;
    Box::pin(sessions::ensure_session_ready(kernel, target)).await?;
    Ok(kernel
        .driver()
        .call("getSessionTree", args([json!(target)]))
        .await?
        .unwrap_or(Value::Null))
}

/// `navigateSessionTree`: moves the thread to another point in its history. Unless pi
/// cancelled or aborted the move, the transcript and commands are reloaded and the thread is
/// shown.
pub async fn navigate_session_tree(
    kernel: &Kernel,
    target: &SessionRef,
    target_id: &str,
    options: Value,
) -> CoreResult<(Value, DesktopAppState)> {
    kernel.initialize().await;
    Box::pin(sessions::ensure_session_ready(kernel, target)).await?;
    let result = kernel
        .driver()
        .call(
            "navigateSessionTree",
            args([json!(target), json!(target_id), options]),
        )
        .await?
        .unwrap_or(Value::Null);
    let stopped = |field: &str| result.get(field).and_then(Value::as_bool) == Some(true);
    let state = if stopped("cancelled") || stopped("aborted") {
        sessions::snapshot(kernel)
    } else {
        sessions::reload_transcript_from_driver(kernel, target).await?;
        sessions::refresh_session_commands(kernel, target).await?;
        refresh::refresh_state(
            kernel,
            RefreshOptions {
                selected_workspace_id: Some(target.workspace_id.clone()),
                selected_session_id: Some(target.session_id.clone()),
                clear_last_error: true,
                mark_selected_session_viewed: Some(false),
                ..Default::default()
            },
        )
        .await?
    };
    Ok((json!({ "result": result }), state))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkThreadInput {
    source_workspace_id: String,
    source_session_id: String,
    root_workspace_id: String,
    environment: String,
    source_message_id: Option<String>,
    source_message_index: Option<f64>,
    user_message_index: Option<f64>,
    position: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkedSession {
    snapshot: SessionSnapshot,
    selected_text: Option<String>,
}

/// `forkThread`: a new thread with the source's history up to a message, in the same folder
/// or a new worktree. The composer gets the text of the message forked from.
pub async fn fork_thread(kernel: &Kernel, input: Value) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let input: ForkThreadInput = crate::parse(input)?;
    let Some(source_workspace) = kernel
        .data
        .borrow()
        .workspace_ref(&input.source_workspace_id)
    else {
        return sessions::with_error(
            kernel,
            format!("Unknown workspace: {}", input.source_workspace_id),
        )
        .await;
    };
    sessions::with_error_handling(kernel, async {
        let source_ref = session_ref(&input.source_workspace_id, &input.source_session_id);
        let mut fork_options = Map::new();
        if let Some(id) = &input.source_message_id {
            fork_options.insert("sourceMessageId".into(), json!(id));
        }
        if let Some(index) = input.source_message_index {
            fork_options.insert("sourceMessageIndex".into(), json!(index));
        }
        if let Some(index) = input.user_message_index {
            fork_options.insert("userMessageIndex".into(), json!(index));
        }
        if let Some(position) = &input.position {
            fork_options.insert("position".into(), json!(position));
        }
        let mut validate_options = Map::new();
        validate_options.insert("targetWorkspace".into(), json!(source_workspace));
        validate_options.extend(fork_options.clone());
        kernel
            .driver()
            .call(
                "validateForkSession",
                args([json!(source_ref), Value::Object(validate_options)]),
            )
            .await?;

        let mut target_workspace = source_workspace.clone();
        let mut rollback: Option<Value> = None;
        if input.environment == "worktree" {
            let Some(root) = kernel.data.borrow().workspace_ref(&input.root_workspace_id) else {
                return sessions::with_error(
                    kernel,
                    format!("Unknown workspace: {}", input.root_workspace_id),
                )
                .await;
            };
            let title = kernel
                .data
                .borrow()
                .session(&source_ref)
                .map(|session| crate::js::trim(&session.title).to_owned());
            let options = build_worktree_options(kernel, &root, title.as_deref().unwrap_or(""));
            let created: WorktreeEntry = crate::parse(
                kernel
                    .core_call(
                        crate::methods::WORKTREES_CREATE,
                        json!({
                            "workspace": root,
                            "path": options.path,
                            "displayName": options.display_name,
                            "branchName": options.branch_name,
                            "startPoint": "HEAD",
                        }),
                    )
                    .await?,
            )?;
            let destroy = json!({
                "workspace": root,
                "path": options.path,
                "branchName": options.branch_name,
            });
            match sessions::sync_workspace(kernel, &created.path, Some(&created.display_name)).await
            {
                Ok(synced) => target_workspace = synced.workspace,
                Err(error) => {
                    rollback_worktree(kernel, destroy).await;
                    return Err(error);
                }
            }
            rollback = Some(destroy);
        }

        // A fork keeps the flags its source thread started with, as terminal pi keeps them
        // for the process.
        let flags = kernel
            .data
            .borrow()
            .sessions
            .extension_flags_by_session
            .get(&session_key(&source_ref))
            .cloned()
            .unwrap_or_default();
        let mut options = Map::new();
        options.insert("targetWorkspace".into(), json!(target_workspace));
        options.extend(fork_options);
        options.insert("extensionFlagValues".into(), json!(flags));
        let forked: CoreResult<ForkedSession> = driver_call(
            kernel.driver(),
            "forkSession",
            args([json!(source_ref), Value::Object(options)]),
        )
        .await;
        let forked = match forked {
            Ok(forked) => forked,
            Err(error) => {
                if let Some(destroy) = rollback {
                    rollback_worktree(kernel, destroy).await;
                }
                return Err(error);
            }
        };
        let session = forked.snapshot;
        sessions::update_session_config(
            &mut kernel.data.borrow_mut(),
            &session.session_ref,
            session.config.as_ref(),
        );
        record_extension_flags(kernel, &session.session_ref, flags, None);

        // Selected first, so replayed subscription events read the new thread.
        set_active_session(kernel, &session.session_ref);
        // The branched history loads before the state that shows it.
        sessions::reload_transcript_from_driver(kernel, &session.session_ref).await?;
        refresh::refresh_state(
            kernel,
            RefreshOptions {
                selected_workspace_id: Some(session.session_ref.workspace_id.clone()),
                selected_session_id: Some(session.session_ref.session_id.clone()),
                composer_draft: Some(forked.selected_text.unwrap_or_default()),
                composer_draft_sync_source: Some(ComposerDraftSyncSource::Selection),
                clear_last_error: true,
                refresh_worktrees: input.environment == "worktree",
                active_view: Some(AppView::Threads),
                ..Default::default()
            },
        )
        .await
    })
    .await
}
