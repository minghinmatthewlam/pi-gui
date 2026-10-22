//! Messages queued behind a running turn: editing one in the composer, removing one, and
//! steering one into the running turn.

use super::{
    attachments, known, queued_messages, remove_optimistic_message, set_composer_attachments,
};
use crate::app::dispatch::{self, MethodTable};
use crate::app::pi::args;
use crate::app::refresh::{self, RefreshOptions};
use crate::app::{publish, sessions, validation, Kernel};
use crate::error::CoreResult;
use crate::state::app_store_utils::to_session_queued_messages;
use crate::state::desktop_state::{
    ComposerDraftSyncSource, DesktopAppState, QueuedComposerMessage,
};
use crate::state::driver::{
    session_key, SessionMessageDeliveryMode, SessionQueuedMessage, SessionRef,
};
use crate::state::session_state_map::QueuedComposerEditState;
use crate::state::timeline::append_queued_user_message;
use serde_json::json;

pub fn register(table: &mut MethodTable) {
    table.on("editQueuedComposerMessage", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let target = kernel.windows.target_for_window(&kernel, window);
            let (message_id, current_draft) = (call.arg(0).cloned(), call.arg(1).cloned());
            dispatch::run_for(&kernel, window, || async {
                let message_id =
                    validation::expect_non_empty_string(message_id.as_ref(), "messageId")?;
                let current_draft =
                    validation::expect_optional_string(current_draft.as_ref(), "currentDraft")?;
                edit_queued_composer_message(
                    &kernel,
                    target.as_ref(),
                    &message_id,
                    current_draft.as_deref().unwrap_or(""),
                )
                .await
            })
            .await
        })
    });
    table.on("cancelQueuedComposerEdit", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let target = kernel.windows.target_for_window(&kernel, window);
            dispatch::run_for(&kernel, window, || {
                cancel_queued_composer_edit(&kernel, target.as_ref())
            })
            .await
        })
    });
    table.on("removeQueuedComposerMessage", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let target = kernel.windows.target_for_window(&kernel, window);
            let message_id = call.arg(0).cloned();
            dispatch::run_for(&kernel, window, || async {
                let message_id =
                    validation::expect_non_empty_string(message_id.as_ref(), "messageId")?;
                remove_queued_composer_message(&kernel, target.as_ref(), &message_id).await
            })
            .await
        })
    });
    table.on("steerQueuedComposerMessage", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let target = kernel.windows.target_for_window(&kernel, window);
            let message_id = call.arg(0).cloned();
            dispatch::run_for(&kernel, window, || async {
                let message_id =
                    validation::expect_non_empty_string(message_id.as_ref(), "messageId")?;
                steer_queued_composer_message(&kernel, target.as_ref(), &message_id).await
            })
            .await
        })
    });
}

/// The refresh after the queue changed.
pub fn after_queue_change() -> RefreshOptions {
    RefreshOptions {
        clear_last_error: true,
        mark_selected_session_viewed: Some(false),
        ..Default::default()
    }
}

/// `driver.replaceQueuedMessages`.
pub async fn send_queued_messages(
    kernel: &Kernel,
    session_ref: &SessionRef,
    messages: &[SessionQueuedMessage],
) -> CoreResult<()> {
    kernel
        .driver()
        .call(
            "replaceQueuedMessages",
            args([json!(session_ref), json!(messages)]),
        )
        .await?;
    Ok(())
}

/// `driver.replaceQueuedMessages(sessionRef, toSessionQueuedMessages(messages))`.
pub async fn replace_queued_messages(
    kernel: &Kernel,
    session_ref: &SessionRef,
    messages: &[QueuedComposerMessage],
) -> CoreResult<()> {
    send_queued_messages(kernel, session_ref, &to_session_queued_messages(messages)).await
}

/// Puts back the draft and attachments the composer had before an edit started.
async fn restore_from_edit(
    kernel: &Kernel,
    session_ref: &SessionRef,
    edit: &QueuedComposerEditState,
) -> CoreResult<()> {
    let key = session_key(session_ref);
    {
        let mut data = kernel.data.borrow_mut();
        data.sessions
            .queued_composer_edits_by_session
            .shift_remove(&key);
        sessions::set_composer_draft_for_session(
            &mut data,
            session_ref,
            &edit.restore_draft,
            ComposerDraftSyncSource::QueuedMessageEdit,
        );
        set_composer_attachments(&mut data, &key, &edit.restore_attachments);
    }
    attachments::persist_composer_attachments(kernel, &key, &edit.restore_attachments).await
}

/// `editQueuedComposerMessage`: the message moves into the composer; the draft and
/// attachments there are kept to put back.
pub async fn edit_queued_composer_message(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
    message_id: &str,
    current_draft: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) = known(kernel, session_ref) else {
        return Ok(publish::emit(kernel));
    };
    let key = session_key(&session_ref);
    let Some(message) = queued_messages(kernel, &session_ref)
        .into_iter()
        .find(|message| message.id == message_id)
    else {
        return Ok(publish::emit(kernel));
    };
    {
        let mut data = kernel.data.borrow_mut();
        let restore_draft = if current_draft.is_empty() {
            data.sessions
                .composer_drafts_by_session
                .get(&key)
                .cloned()
                .unwrap_or_default()
        } else {
            current_draft.to_owned()
        };
        let restore_attachments = data
            .sessions
            .composer_attachments_by_session
            .get(&key)
            .cloned()
            .unwrap_or_default();
        data.sessions.queued_composer_edits_by_session.insert(
            key.clone(),
            QueuedComposerEditState {
                message_id: message_id.to_owned(),
                restore_draft,
                restore_attachments,
            },
        );
        sessions::set_composer_draft_for_session(
            &mut data,
            &session_ref,
            &message.text,
            ComposerDraftSyncSource::QueuedMessageEdit,
        );
        data.sessions
            .composer_attachments_by_session
            .insert(key.clone(), message.attachments.clone());
    }
    attachments::persist_composer_attachments(kernel, &key, &message.attachments).await?;
    refresh::refresh_state(kernel, after_queue_change()).await
}

/// `cancelQueuedComposerEdit`.
pub async fn cancel_queued_composer_edit(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) = known(kernel, session_ref) else {
        return Ok(publish::emit(kernel));
    };
    let edit = kernel
        .data
        .borrow()
        .sessions
        .queued_composer_edits_by_session
        .get(&session_key(&session_ref))
        .cloned();
    let Some(edit) = edit else {
        return Ok(publish::emit(kernel));
    };
    restore_from_edit(kernel, &session_ref, &edit).await?;
    refresh::refresh_state(kernel, after_queue_change()).await
}

/// `removeQueuedComposerMessage`: removing the message being edited puts the composer back.
pub async fn remove_queued_composer_message(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
    message_id: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) = known(kernel, session_ref) else {
        return Ok(publish::emit(kernel));
    };
    let mut next = queued_messages(kernel, &session_ref);
    next.retain(|message| message.id != message_id);
    let edit = kernel
        .data
        .borrow()
        .sessions
        .queued_composer_edits_by_session
        .get(&session_key(&session_ref))
        .cloned();
    if let Some(edit) = edit.filter(|edit| edit.message_id == message_id) {
        restore_from_edit(kernel, &session_ref, &edit).await?;
    }
    replace_queued_messages(kernel, &session_ref, &next).await?;
    refresh::refresh_state(kernel, after_queue_change()).await
}

/// `steerQueuedComposerMessage`: the message joins the running turn now. Its row shows at
/// once and goes again if pi refuses.
pub async fn steer_queued_composer_message(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
    message_id: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) = known(kernel, session_ref) else {
        return Ok(publish::emit(kernel));
    };
    let mut next = queued_messages(kernel, &session_ref);
    let Some(index) = next.iter().position(|message| message.id == message_id) else {
        return Ok(publish::emit(kernel));
    };
    next[index].mode = SessionMessageDeliveryMode::Steer;
    next[index].updated_at = kernel.env().now_iso();
    let session_queued = to_session_queued_messages(&next);
    let optimistic = session_queued
        .iter()
        .find(|message| message.id == message_id)
        .cloned();
    if let Some(message) = &optimistic {
        append_queued_user_message(
            &mut kernel.data.borrow_mut().sessions.transcript_cache,
            &session_ref,
            message,
        );
        publish::publish_selected_transcript_for(kernel, &session_ref);
    }
    let result = async {
        send_queued_messages(kernel, &session_ref, &session_queued).await?;
        refresh::refresh_state(kernel, after_queue_change()).await
    }
    .await;
    match result {
        Ok(state) => Ok(state),
        Err(error) => {
            if let Some(message) = optimistic {
                remove_optimistic_message(kernel, &session_ref, &message.id);
            }
            sessions::with_session_error(
                kernel,
                &session_ref,
                sessions::describe_store_error(&error),
            )
            .await
        }
    }
}
