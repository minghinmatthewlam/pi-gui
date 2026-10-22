//! The composer and messages (`conversation/app-store-composer.ts`): drafts, attachments,
//! queued messages, submitting and slash commands, the thread's model and thinking level,
//! cancelling a run, and the session tree and forks.

pub mod attachments;
pub mod commands;
pub mod model;
pub mod queue;
pub mod submit;
pub mod tree;

use super::dispatch::{self, MethodTable, Reply};
use super::validation;
use super::{persist, publish, sessions, AppData, Kernel};
use crate::error::{CoreError, CoreResult};
use crate::state::app_store_utils::{to_session_attachments, to_transcript_attachments};
use crate::state::desktop_state::{
    ComposerAttachment, ComposerDraftSyncSource, DesktopAppState, QueuedComposerMessage,
};
use crate::state::driver::{session_key, SessionMessageDeliveryMode, SessionRef};
use crate::state::timeline::{append_user_message, clear_active_assistant_message};
use serde_json::json;

pub use attachments::{
    ensure_composer_attachments_loaded, migrate_legacy_attachments,
    prune_orphaned_attachment_files, validate_persisted_attachments,
};

/// What the composer keeps besides the shared session maps.
#[derive(Default)]
pub struct ConversationState {}

pub fn register(table: &mut MethodTable) {
    table.on("updateComposerDraft", |kernel, call| {
        Box::pin(async move {
            // A debounced write can arrive after the window selected another task, so it
            // names its own.
            let target = validation::expect_session_target(call.arg(1), "target")?;
            let window = dispatch::sender(&kernel, &call)?;
            let draft_arg = call.arg(0).cloned();
            dispatch::run_for(&kernel, window, || {
                kernel.windows.with_draft_persist_origin(window, async {
                    let draft = validation::expect_string(draft_arg.as_ref(), "composerDraft")?;
                    update_composer_draft(&kernel, Some(&target), &draft).await
                })
            })
            .await
        })
    });
    table.on("persistComposerDraft", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::main_frame(&kernel, &call, "pi-gui:persist-composer-draft")?;
            let input = validation::expect_record(call.arg(0), "composer draft")?;
            let target = validation::expect_session_target(input.get("target"), "target")?;
            let draft = validation::expect_string(input.get("draft"), "draft")?;
            kernel.initialize().await;
            let view = kernel.windows.view_for_window(&kernel, window);
            let state = publish::state_for_view(&kernel, &view);
            let exists = state.workspaces.iter().any(|workspace| {
                workspace.id == target.workspace_id
                    && workspace
                        .sessions
                        .iter()
                        .any(|session| session.id == target.session_id)
            });
            if !exists {
                return Err(CoreError::new("The draft's task is unavailable"));
            }
            kernel
                .windows
                .with_draft_persist_origin(
                    window,
                    update_composer_draft(&kernel, Some(&target), &draft),
                )
                .await?;
            Ok(Reply::Undefined)
        })
    });
    table.on("submitComposer", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let target = kernel.windows.target_for_window(&kernel, window);
            let text = validation::expect_string(call.arg(0), "text")?;
            let deliver_as = validation::expect_optional_deliver_options(call.arg(1))?
                .and_then(|options| options.get("deliverAs").cloned())
                .and_then(|mode| serde_json::from_value(mode).ok());
            // Ordinary prompts, skills and prompt templates target a captured thread and may
            // await the whole turn, so they wait outside the window queue and selection and
            // other windows stay usable. Local and extension commands can change selection
            // (an extension creating a child thread), so they keep the sender's view.
            let action = submit::submit_composer(&kernel, target.as_ref(), &text, deliver_as);
            if submit::needs_sender_view(&kernel, target.as_ref(), &text) {
                dispatch::run_for(&kernel, window, || action).await
            } else {
                dispatch::immediate(&kernel, &call, action).await
            }
        })
    });
    table.on("cancelCurrentRun", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            // A long slash command can still hold the window queue; Stop skips it and
            // cancels the thread the window showed when it was pressed.
            let target = kernel.windows.target_for_window(&kernel, window);
            dispatch::immediate(&kernel, &call, cancel_current_run(&kernel, target.as_ref())).await
        })
    });
    attachments::register(table);
    queue::register(table);
    model::register(table);
    tree::register(table);
}

/// Whether the thread is in the sidebar (`sessionFromState`).
fn known(kernel: &Kernel, session_ref: Option<&SessionRef>) -> Option<SessionRef> {
    session_ref
        .filter(|session_ref| kernel.data.borrow().session(session_ref).is_some())
        .cloned()
}

/// `clearConversationError`.
pub fn clear_conversation_error(data: &mut AppData) {
    if let Some(selected) = data.selected_session_ref() {
        data.sessions
            .session_errors_by_session
            .shift_remove(&session_key(&selected));
    }
    data.state.last_error = None;
    data.bump();
}

/// `publishComposerAttachments`: the selected thread's composer shows them at once.
pub fn publish_composer_attachments(
    data: &mut AppData,
    session_ref: &SessionRef,
    attachments: &[ComposerAttachment],
) {
    if data.state.selected_workspace_id == session_ref.workspace_id
        && data.state.selected_session_id == session_ref.session_id
    {
        data.state.composer_attachments = attachments.to_vec();
    }
    data.bump();
}

/// Puts the thread's composer attachments, or drops them when there are none.
fn set_composer_attachments(data: &mut AppData, key: &str, attachments: &[ComposerAttachment]) {
    if attachments.is_empty() {
        data.sessions
            .composer_attachments_by_session
            .shift_remove(key);
    } else {
        data.sessions
            .composer_attachments_by_session
            .insert(key.to_owned(), attachments.to_vec());
    }
}

/// `getQueuedComposerMessages`.
fn queued_messages(kernel: &Kernel, session_ref: &SessionRef) -> Vec<QueuedComposerMessage> {
    kernel
        .data
        .borrow()
        .sessions
        .queued_composer_messages_by_session
        .get(&session_key(session_ref))
        .cloned()
        .unwrap_or_default()
}

/// `buildQueuedComposerMessage`: an edited message keeps its id and creation time.
fn build_queued_composer_message(
    kernel: &Kernel,
    text: &str,
    attachments: &[ComposerAttachment],
    mode: SessionMessageDeliveryMode,
    existing: Option<&QueuedComposerMessage>,
) -> QueuedComposerMessage {
    let timestamp = kernel.env().now_iso();
    QueuedComposerMessage {
        id: existing
            .map(|message| message.id.clone())
            .unwrap_or_else(|| kernel.env().random_uuid()),
        text: text.to_owned(),
        mode,
        attachments: attachments.to_vec(),
        created_at: existing
            .map(|message| message.created_at.clone())
            .unwrap_or_else(|| timestamp.clone()),
        updated_at: timestamp,
    }
}

/// `removeOptimisticQueuedUserMessage`.
fn remove_optimistic_message(kernel: &Kernel, session_ref: &SessionRef, message_id: &str) {
    kernel
        .data
        .borrow_mut()
        .sessions
        .transcript_cache
        .entry(session_key(session_ref))
        .or_default()
        .retain(|message| message.id() != message_id);
    publish::publish_selected_transcript_for(kernel, session_ref);
}

/// `updateComposerDraft`.
pub async fn update_composer_draft(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
    draft: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) = known(kernel, session_ref) else {
        return Ok(publish::emit(kernel));
    };
    {
        let mut data = kernel.data.borrow_mut();
        sessions::set_composer_draft_for_session(
            &mut data,
            &session_ref,
            draft,
            ComposerDraftSyncSource::Persist,
        );
        clear_conversation_error(&mut data);
    }
    persist::schedule_persist_ui_state(kernel);
    Ok(publish::emit(kernel))
}

/// `cancelCurrentRun`: the store's check and the thread's children first, then the run.
pub async fn cancel_current_run(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) = known(kernel, session_ref) else {
        return Ok(publish::emit(kernel));
    };
    super::orchestration::cancel_child_runs_for_parent(kernel, &session_ref).await?;
    let cancelled = kernel
        .driver()
        .call("cancelCurrentRun", super::pi::args([json!(session_ref)]))
        .await;
    match cancelled {
        Ok(_) => {
            // The queued message-end event owns clearing the live reply, so a late host event
            // can still match the partial row with the entry pi saved.
            {
                let mut data = kernel.data.borrow_mut();
                data.sessions
                    .session_errors_by_session
                    .shift_remove(&session_key(&session_ref));
                clear_conversation_error(&mut data);
            }
            persist::schedule_persist_ui_state(kernel);
            Ok(publish::emit(kernel))
        }
        Err(error) => {
            sessions::with_session_error(
                kernel,
                &session_ref,
                sessions::describe_store_error(&error),
            )
            .await
        }
    }
}

/// `sendMessageToSession`: shows the message at once, then hands it to pi.
pub async fn send_message_to_session(
    kernel: &Kernel,
    session_ref: &SessionRef,
    text: &str,
    attachments: &[ComposerAttachment],
    rollback_optimistic_message_on_error: bool,
) -> CoreResult<()> {
    let key = session_key(session_ref);
    let loaded = kernel
        .data
        .borrow()
        .sessions
        .loaded_transcript_keys
        .contains(&key);
    if !loaded {
        Box::pin(sessions::ensure_session_ready(kernel, session_ref)).await?;
    }
    let archived = kernel
        .data
        .borrow()
        .session(session_ref)
        .is_some_and(|session| session.archived_at.is_some());
    if archived {
        kernel
            .driver()
            .call("unarchiveSession", super::pi::args([json!(session_ref)]))
            .await?;
    }
    sessions::record_user_message_recency(kernel, session_ref);
    let optimistic_id = {
        let mut data = kernel.data.borrow_mut();
        append_user_message(
            kernel.env(),
            &mut data.sessions.transcript_cache,
            session_ref,
            text,
            &to_transcript_attachments(attachments),
        )
    };
    publish::publish_selected_transcript_for(kernel, session_ref);
    {
        let mut data = kernel.data.borrow_mut();
        let sessions = &mut data.sessions;
        clear_active_assistant_message(
            &mut sessions.active_assistant_message_by_session,
            session_ref,
        );
        sessions.session_errors_by_session.shift_remove(&key);
        sessions.composer_drafts_by_session.shift_remove(&key);
        sessions.composer_attachments_by_session.shift_remove(&key);
    }
    attachments::persist_composer_attachments(kernel, &key, &[]).await?;
    let sent = kernel
        .driver()
        .call(
            "sendUserMessage",
            super::pi::args([
                json!(session_ref),
                json!({ "text": text, "attachments": to_session_attachments(attachments) }),
            ]),
        )
        .await;
    if let Err(error) = sent {
        if rollback_optimistic_message_on_error {
            remove_optimistic_message(kernel, session_ref, &optimistic_id);
        }
        return Err(error);
    }
    Ok(())
}

/// `deliverBackgroundInstruction`: a scheduled task's instruction, queued behind a running
/// turn or sent now. Returns the optimistic row's id when it was sent.
pub async fn deliver_background_instruction(
    kernel: &Kernel,
    session_ref: &SessionRef,
    text: &str,
) -> CoreResult<Option<String>> {
    let instruction = crate::js::trim(text);
    if instruction.is_empty() {
        return Err(CoreError::new("Scheduled task instruction is empty."));
    }
    Box::pin(sessions::ensure_session_ready(kernel, session_ref)).await?;
    let (archived, running) = {
        let data = kernel.data.borrow();
        let Some(session) = data.session(session_ref) else {
            return Err(CoreError::new(format!(
                "Unknown session: {}:{}",
                session_ref.workspace_id, session_ref.session_id
            )));
        };
        (
            session.archived_at.is_some(),
            session.status == crate::state::driver::SessionStatus::Running,
        )
    };
    if archived {
        return Err(CoreError::new("Scheduled task target thread is archived."));
    }
    sessions::record_user_message_recency(kernel, session_ref);
    if running {
        let next = build_queued_composer_message(
            kernel,
            instruction,
            &[],
            SessionMessageDeliveryMode::FollowUp,
            None,
        );
        let mut queued = queued_messages(kernel, session_ref);
        queued.push(next);
        queue::replace_queued_messages(kernel, session_ref, &queued).await?;
        super::refresh::refresh_state(kernel, queue::after_queue_change()).await?;
        return Ok(None);
    }
    let key = session_key(session_ref);
    let optimistic_id = {
        let mut data = kernel.data.borrow_mut();
        append_user_message(
            kernel.env(),
            &mut data.sessions.transcript_cache,
            session_ref,
            instruction,
            &[],
        )
    };
    publish::publish_selected_transcript_for(kernel, session_ref);
    {
        let mut data = kernel.data.borrow_mut();
        clear_active_assistant_message(
            &mut data.sessions.active_assistant_message_by_session,
            session_ref,
        );
        data.sessions.session_errors_by_session.shift_remove(&key);
    }
    kernel
        .driver()
        .call(
            "sendUserMessage",
            super::pi::args([
                json!(session_ref),
                json!({ "text": instruction, "attachments": [] }),
            ]),
        )
        .await?;
    Ok(Some(optimistic_id))
}
