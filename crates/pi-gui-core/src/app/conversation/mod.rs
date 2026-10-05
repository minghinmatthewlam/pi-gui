//! The composer and messages (`conversation/app-store-composer.ts`): drafts, attachments,
//! queued messages, submitting and cancelling. So far: drafts and sending a message; the rest
//! answers "not ported".

pub mod attachments;

use super::dispatch::{self, MethodTable, Reply};
use super::{persist, publish, sessions, Kernel};
use crate::error::{CoreError, CoreResult};
use crate::state::app_store_utils::{to_session_attachments, to_transcript_attachments};
use crate::state::desktop_state::{ComposerAttachment, ComposerDraftSyncSource, DesktopAppState};
use crate::state::driver::{session_key, SessionRef};
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
            let target = super::validation::expect_session_target(call.arg(1), "target")?;
            let window = dispatch::sender(&kernel, &call)?;
            let draft_arg = call.arg(0).cloned();
            dispatch::run_for(&kernel, window, || {
                kernel.windows.with_draft_persist_origin(window, async {
                    let draft =
                        super::validation::expect_string(draft_arg.as_ref(), "composerDraft")?;
                    update_composer_draft(&kernel, Some(&target), &draft).await
                })
            })
            .await
        })
    });
    table.on("persistComposerDraft", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::main_frame(&kernel, &call, "pi-gui:persist-composer-draft")?;
            let input = super::validation::expect_record(call.arg(0), "composer draft")?;
            let target = super::validation::expect_session_target(input.get("target"), "target")?;
            let draft = super::validation::expect_string(input.get("draft"), "draft")?;
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
}

/// `updateComposerDraft`.
pub async fn update_composer_draft(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
    draft: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) =
        session_ref.filter(|session_ref| kernel.data.borrow().session(session_ref).is_some())
    else {
        return Ok(publish::emit(kernel));
    };
    {
        let mut data = kernel.data.borrow_mut();
        sessions::set_composer_draft_for_session(
            &mut data,
            session_ref,
            draft,
            ComposerDraftSyncSource::Persist,
        );
        // `clearConversationError`.
        data.state.last_error = None;
    }
    persist::schedule_persist_ui_state(kernel);
    Ok(publish::emit(kernel))
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
            if let Some(transcript) = kernel
                .data
                .borrow_mut()
                .sessions
                .transcript_cache
                .get_mut(&key)
            {
                transcript.retain(|message| message.id() != optimistic_id);
            }
            publish::publish_selected_transcript_for(kernel, session_ref);
        }
        return Err(error);
    }
    Ok(())
}
