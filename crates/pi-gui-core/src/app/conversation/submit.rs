//! Submitting the composer: a message, a follow-up or steer behind a running turn, one of the
//! app's own slash commands, or one of pi's runtime commands (extensions, prompt templates
//! and skills).

use super::commands::{self, ParsedComposerCommand};
use super::{
    attachments, build_queued_composer_message, known, publish_composer_attachments, queue,
    queued_messages, remove_optimistic_message, set_composer_attachments,
};
use crate::app::pi::args;
use crate::app::refresh::{self, RefreshOptions};
use crate::app::{persist, publish, sessions, AppData, Kernel};
use crate::error::{CoreError, CoreResult};
use crate::state::app_store_utils::{
    make_activity_item, preview_from_transcript, to_session_queued_messages, ActivityOptions,
};
use crate::state::desktop_state::{
    ComposerAttachment, ComposerDraftSyncSource, DesktopAppState,
    ExtensionCommandCompatibilityRecord, ExtensionCommandCompatibilityStatus,
};
use crate::state::driver::{
    session_key, RuntimeCommandRecord, RuntimeCommandSource, SessionConfig,
    SessionMessageDeliveryMode, SessionQueuedMessage, SessionRef, SessionStatus,
};
use crate::state::extension_command_compatibility::{
    get_learned_command_compatibility, record_learned_command_compatibility,
    PendingRuntimeCommandExecution,
};
use crate::state::timeline::append_queued_user_message;
use serde_json::{json, Value};

/// `composerSubmitNeedsSenderView` for the window's thread.
pub fn needs_sender_view(kernel: &Kernel, session_ref: Option<&SessionRef>, text: &str) -> bool {
    let Some(session_ref) = session_ref else {
        return crate::js::trim(text).starts_with('/');
    };
    let data = kernel.data.borrow();
    commands::composer_submit_needs_sender_view(
        text,
        data.runtime_by_workspace.get(&session_ref.workspace_id),
        data.sessions
            .session_commands_by_session
            .get(&session_key(session_ref))
            .map(Vec::as_slice),
    )
}

/// `submitComposer`.
pub async fn submit_composer(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
    text_input: &str,
    deliver_as: Option<SessionMessageDeliveryMode>,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let text = crate::js::trim(text_input);
    let attachments = session_ref
        .and_then(|session_ref| {
            kernel
                .data
                .borrow()
                .sessions
                .composer_attachments_by_session
                .get(&session_key(session_ref))
                .cloned()
        })
        .unwrap_or_default();
    if text.is_empty() && attachments.is_empty() {
        return Ok(publish::emit(kernel));
    }
    let Some(session_ref) = known(kernel, session_ref) else {
        return sessions::with_error(
            kernel,
            "Create or select a session before sending a message.".into(),
        )
        .await;
    };
    submit_composer_to_session(
        kernel,
        &session_ref,
        text_input,
        attachments,
        deliver_as,
        true,
    )
    .await
}

/// `submitComposerToSession`.
pub async fn submit_composer_to_session(
    kernel: &Kernel,
    session_ref: &SessionRef,
    text_input: &str,
    attachments: Vec<ComposerAttachment>,
    deliver_as: Option<SessionMessageDeliveryMode>,
    allow_commands: bool,
) -> CoreResult<DesktopAppState> {
    let text = crate::js::trim(text_input);
    let key = session_key(session_ref);
    let runtime_command = if allow_commands {
        resolve_runtime_command(kernel, session_ref, text)
    } else {
        None
    };

    if allow_commands && text.starts_with('/') && runtime_command.is_none() {
        if let Some(handled) = run_composer_command(kernel, session_ref, text).await? {
            return Ok(handled);
        }
    }

    let (running, editing) = {
        let data = kernel.data.borrow();
        (
            data.session(session_ref)
                .is_some_and(|session| session.status == SessionStatus::Running),
            data.sessions
                .queued_composer_edits_by_session
                .get(&key)
                .cloned(),
        )
    };
    let is_extension = runtime_command
        .as_ref()
        .is_some_and(|command| command.source == RuntimeCommandSource::Extension);
    let mut optimistic_steer: Option<SessionQueuedMessage> = None;
    let result = async {
        if let Some(command) = &runtime_command {
            let learned = get_learned_command_compatibility(
                &kernel.data.borrow().compatibility_by_workspace,
                &session_ref.workspace_id,
                command,
            )
            .cloned();
            if let Some(learned) = learned.filter(|learned| {
                learned.status == ExtensionCommandCompatibilityStatus::TerminalOnly
            }) {
                if !attachments.is_empty() {
                    set_composer_attachments(&mut kernel.data.borrow_mut(), &key, &attachments);
                    attachments::persist_composer_attachments(kernel, &key, &attachments).await?;
                }
                {
                    let mut data = kernel.data.borrow_mut();
                    sessions::set_composer_draft_for_session(
                        &mut data,
                        session_ref,
                        text_input,
                        ComposerDraftSyncSource::Command,
                    );
                    publish_composer_attachments(&mut data, session_ref, &attachments);
                }
                return sessions::with_session_error(kernel, session_ref, learned.message).await;
            }
            begin_runtime_command_execution(kernel, session_ref, command);
        }

        if running && runtime_command.is_none() {
            let mode = deliver_as.unwrap_or(SessionMessageDeliveryMode::FollowUp);
            let mut queued = queued_messages(kernel, session_ref);
            let existing = editing.as_ref().and_then(|editing| {
                queued
                    .iter()
                    .find(|message| message.id == editing.message_id)
            });
            let next = build_queued_composer_message(kernel, text, &attachments, mode, existing);
            match &editing {
                Some(editing) => {
                    for message in queued.iter_mut() {
                        if message.id == editing.message_id {
                            *message = next.clone();
                        }
                    }
                }
                None => queued.push(next.clone()),
            }
            {
                let mut data = kernel.data.borrow_mut();
                data.sessions.composer_drafts_by_session.shift_remove(&key);
                data.sessions
                    .composer_attachments_by_session
                    .shift_remove(&key);
                data.sessions
                    .queued_composer_edits_by_session
                    .shift_remove(&key);
            }
            attachments::persist_composer_attachments(kernel, &key, &[]).await?;
            let session_queued = to_session_queued_messages(&queued);
            optimistic_steer = (mode == SessionMessageDeliveryMode::Steer)
                .then(|| {
                    session_queued
                        .iter()
                        .find(|message| message.id == next.id)
                        .cloned()
                })
                .flatten();
            if let Some(message) = &optimistic_steer {
                append_queued_user_message(
                    &mut kernel.data.borrow_mut().sessions.transcript_cache,
                    session_ref,
                    message,
                );
                publish::publish_selected_transcript_for(kernel, session_ref);
            }
            sessions::record_user_message_recency(kernel, session_ref);
            queue::send_queued_messages(kernel, session_ref, &session_queued).await?;
            return refresh::refresh_state(kernel, queue::after_queue_change()).await;
        }

        if is_extension {
            // pi runs an extension command and ignores attachments, so it is not a message:
            // only the typed text is used up.
            sessions::set_composer_draft_for_session(
                &mut kernel.data.borrow_mut(),
                session_ref,
                "",
                ComposerDraftSyncSource::Command,
            );
            send_extension_command(kernel, session_ref, text).await?;
        } else {
            super::send_message_to_session(kernel, session_ref, text, &attachments, true).await?;
        }
        let outcome = runtime_command
            .as_ref()
            .and_then(|_| finish_runtime_command_execution(kernel, session_ref));
        if runtime_command.is_some() {
            sessions::refresh_session_commands(kernel, session_ref).await?;
        }
        let blocked = outcome
            .and_then(|outcome| outcome.blocked_message)
            .is_some_and(|message| !message.is_empty());
        refresh::refresh_state(
            kernel,
            RefreshOptions {
                clear_last_error: !blocked,
                mark_selected_session_viewed: Some(false),
                ..Default::default()
            },
        )
        .await
    }
    .await;

    let error = match result {
        Ok(state) => return Ok(state),
        Err(error) => error,
    };
    if runtime_command.is_some() {
        finish_runtime_command_execution(kernel, session_ref);
    }
    if is_extension {
        // The command path cleared the shown draft before sending, so the text goes back there.
        sessions::set_composer_draft_for_session(
            &mut kernel.data.borrow_mut(),
            session_ref,
            text_input,
            ComposerDraftSyncSource::Command,
        );
    } else if !text_input.is_empty() {
        kernel
            .data
            .borrow_mut()
            .sessions
            .composer_drafts_by_session
            .insert(key.clone(), text_input.to_owned());
    }
    if !attachments.is_empty() {
        set_composer_attachments(&mut kernel.data.borrow_mut(), &key, &attachments);
        attachments::persist_composer_attachments(kernel, &key, &attachments).await?;
    }
    if let Some(editing) = editing {
        kernel
            .data
            .borrow_mut()
            .sessions
            .queued_composer_edits_by_session
            .insert(key.clone(), editing);
    }
    if let Some(message) = optimistic_steer {
        remove_optimistic_message(kernel, session_ref, &message.id);
    }
    sessions::with_session_error(kernel, session_ref, sessions::describe_store_error(&error)).await
}

/// `resolveRuntimeSlashCommand` against the thread's commands.
fn resolve_runtime_command(
    kernel: &Kernel,
    session_ref: &SessionRef,
    text: &str,
) -> Option<RuntimeCommandRecord> {
    let data = kernel.data.borrow();
    commands::resolve_runtime_slash_command(
        text,
        data.runtime_by_workspace.get(&session_ref.workspace_id),
        data.sessions
            .session_commands_by_session
            .get(&session_key(session_ref))
            .map(Vec::as_slice)
            .unwrap_or_default(),
    )
}

/// `runExtensionCommand`: an extension command for a card button. It is not a user message:
/// nothing is added to the thread or taken from the composer, and pi refuses anything that is
/// not an extension command. Fails so the caller shows one kind of error.
pub async fn run_extension_command(
    kernel: &Kernel,
    session_ref: &SessionRef,
    command_text: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let text = crate::js::trim(command_text);
    // pi is the check that matters (`extensionCommandOnly`); this only keeps the terminal-only
    // bookkeeping the same as for a typed command.
    let tracked = resolve_runtime_command(kernel, session_ref, text)
        .filter(|command| command.source == RuntimeCommandSource::Extension);
    if let Some(command) = &tracked {
        let learned = get_learned_command_compatibility(
            &kernel.data.borrow().compatibility_by_workspace,
            &session_ref.workspace_id,
            command,
        )
        .cloned();
        if let Some(learned) = learned
            .filter(|learned| learned.status == ExtensionCommandCompatibilityStatus::TerminalOnly)
        {
            return Err(CoreError::new(learned.message));
        }
        begin_runtime_command_execution(kernel, session_ref, command);
    }
    // A button is not typed text, so the draft stays too.
    let sent = send_extension_command(kernel, session_ref, text).await;
    if tracked.is_some() {
        finish_runtime_command_execution(kernel, session_ref);
    }
    sent?;
    sessions::refresh_session_commands(kernel, session_ref).await?;
    refresh::refresh_state(
        kernel,
        RefreshOptions {
            mark_selected_session_viewed: Some(false),
            ..Default::default()
        },
    )
    .await
}

/// `sendExtensionCommand`: not a message from the user, so no row, no recency bump and no
/// unarchive, and attachments and a streaming reply stay as they are. pi saves nothing for
/// the command itself, so the live thread matches the reopened one.
async fn send_extension_command(
    kernel: &Kernel,
    session_ref: &SessionRef,
    text: &str,
) -> CoreResult<()> {
    let loaded = kernel
        .data
        .borrow()
        .sessions
        .loaded_transcript_keys
        .contains(&session_key(session_ref));
    if !loaded {
        Box::pin(sessions::ensure_session_ready(kernel, session_ref)).await?;
    }
    kernel
        .driver()
        .call(
            "sendUserMessage",
            args([
                json!(session_ref),
                json!({ "text": text, "extensionCommandOnly": true }),
            ]),
        )
        .await?;
    Ok(())
}

/// `beginRuntimeCommandExecution`.
fn begin_runtime_command_execution(
    kernel: &Kernel,
    session_ref: &SessionRef,
    command: &RuntimeCommandRecord,
) {
    kernel.data.borrow_mut().pending_runtime_commands.insert(
        session_key(session_ref),
        PendingRuntimeCommandExecution {
            command: command.clone(),
            blocked_message: None,
        },
    );
}

/// `finishRuntimeCommandExecution`: a command that ran without being blocked is learned as
/// working here.
fn finish_runtime_command_execution(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> Option<PendingRuntimeCommandExecution> {
    let timestamp = kernel.env().now_iso();
    let mut data = kernel.data.borrow_mut();
    let pending = data
        .pending_runtime_commands
        .shift_remove(&session_key(session_ref))?;
    if pending.blocked_message.is_none() {
        record_learned_command_compatibility(
            &mut data.compatibility_by_workspace,
            &session_ref.workspace_id,
            ExtensionCommandCompatibilityRecord {
                command_name: pending.command.name.clone(),
                extension_path: pending.command.source_info.path.clone(),
                status: ExtensionCommandCompatibilityStatus::Supported,
                message: "Observed working in pi-gui.".into(),
                capability: "gui-safe".into(),
                updated_at: timestamp,
            },
        );
    }
    Some(pending)
}

/// `syncSessionConfig`: merges the change now so the transcript and sidebar show it before
/// pi's `sessionUpdated` arrives.
pub fn sync_session_config(data: &mut AppData, key: &str, patch: SessionConfig) {
    let current = data
        .sessions
        .session_config_by_session
        .get(key)
        .cloned()
        .unwrap_or_default();
    data.sessions.session_config_by_session.insert(
        key.to_owned(),
        SessionConfig {
            provider: patch.provider.or(current.provider),
            model_id: patch.model_id.or(current.model_id),
            thinking_level: patch.thinking_level.or(current.thinking_level),
        },
    );
}

/// `runComposerCommand`: one of the app's own slash commands, or `None` for text pi should
/// get as a prompt.
async fn run_composer_command(
    kernel: &Kernel,
    session_ref: &SessionRef,
    command_text: &str,
) -> CoreResult<Option<DesktopAppState>> {
    let Some(parsed) = commands::parse_composer_command(command_text) else {
        return match commands::incomplete_composer_command_message(command_text) {
            Some(message) => sessions::with_session_error(kernel, session_ref, message.into())
                .await
                .map(Some),
            None => Ok(None),
        };
    };
    let key = session_key(session_ref);
    let finished = match parsed {
        ParsedComposerCommand::Model { provider, model_id } => {
            kernel
                .driver()
                .call(
                    "setSessionModel",
                    args([
                        json!(session_ref),
                        json!({ "provider": provider, "modelId": model_id }),
                    ]),
                )
                .await?;
            let label = format!("Model set to {provider}:{model_id}");
            sync_session_config(
                &mut kernel.data.borrow_mut(),
                &key,
                SessionConfig {
                    provider: Some(provider),
                    model_id: Some(model_id),
                    thinking_level: None,
                },
            );
            finish_composer_command(kernel, session_ref, &label, None)
        }
        ParsedComposerCommand::Thinking { thinking_level } => {
            kernel
                .driver()
                .call(
                    "setSessionThinkingLevel",
                    args([json!(session_ref), json!(thinking_level)]),
                )
                .await?;
            let label = format!("Thinking set to {thinking_level}");
            sync_session_config(
                &mut kernel.data.borrow_mut(),
                &key,
                SessionConfig {
                    thinking_level: Some(thinking_level),
                    ..Default::default()
                },
            );
            finish_composer_command(kernel, session_ref, &label, None)
        }
        ParsedComposerCommand::Status => {
            let label = commands::format_session_config_status(
                kernel
                    .data
                    .borrow()
                    .sessions
                    .session_config_by_session
                    .get(&key),
            );
            finish_composer_command(kernel, session_ref, &label, None)
        }
        ParsedComposerCommand::Session => {
            let label = describe_session(kernel, session_ref);
            finish_composer_command(kernel, session_ref, &label, None)
        }
        ParsedComposerCommand::Name { title } => {
            sessions::clear_pending_auto_title(kernel, session_ref);
            kernel
                .driver()
                .call("renameSession", args([json!(session_ref), json!(title)]))
                .await?;
            let label = format!("Session renamed to {title}");
            finish_composer_command(kernel, session_ref, &label, Some(title))
        }
        ParsedComposerCommand::Compact {
            custom_instructions,
        } => {
            kernel
                .driver()
                .call(
                    "compactSession",
                    vec![
                        Some(json!(session_ref)),
                        custom_instructions.map(Value::from),
                    ],
                )
                .await?;
            sessions::reload_transcript_from_driver(kernel, session_ref).await?;
            finish_composer_command(kernel, session_ref, "Compacted session context", None)
        }
        ParsedComposerCommand::Reload => {
            clear_extension_ui_for_session(kernel, session_ref);
            kernel
                .driver()
                .call("reloadSession", args([json!(session_ref)]))
                .await?;
            sessions::refresh_session_commands(kernel, session_ref).await?;
            finish_composer_command(kernel, session_ref, "Reloaded session resources", None)
        }
        ParsedComposerCommand::Tree => {
            return sessions::with_session_error(
                kernel,
                session_ref,
                format!("Unsupported slash command: {command_text}"),
            )
            .await
            .map(Some);
        }
    };
    Ok(Some(finished))
}

/// The `/session` line: title, id, folder and status.
fn describe_session(kernel: &Kernel, session_ref: &SessionRef) -> String {
    let data = kernel.data.borrow();
    let described = data
        .state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == session_ref.workspace_id)
        .and_then(|workspace| {
            workspace
                .sessions
                .iter()
                .find(|session| session.id == session_ref.session_id)
                .map(|session| (workspace.name.clone(), session))
        });
    let mut parts = vec![format!(
        "Session {}",
        described
            .as_ref()
            .map(|(_, session)| session.title.as_str())
            .unwrap_or(&session_ref.session_id)
    )];
    parts.push(format!("ID {}", session_ref.session_id));
    if let Some((workspace_name, session)) = &described {
        parts.push(format!("Workspace {workspace_name}"));
        let status = serde_json::to_value(session.status).unwrap_or_default();
        parts.push(format!("Status {}", status.as_str().unwrap_or_default()));
    }
    parts.join(" · ")
}

/// `clearExtensionUiForSession`.
fn clear_extension_ui_for_session(kernel: &Kernel, session_ref: &SessionRef) {
    let mut data = kernel.data.borrow_mut();
    let key = session_key(session_ref);
    if !data.sessions.extension_ui_by_session.contains_key(&key) {
        return;
    }
    crate::app::extensions::clear_dialog_timeouts_for_session(&mut data, session_ref);
    data.sessions.extension_ui_by_session.shift_remove(&key);
    sessions::sync_derived_session_state(&mut data, session_ref);
}

/// `finishComposerCommand`: a typed slash command used up its text, so the draft clears;
/// attachments stay for the next message, since a command is not a message.
fn finish_composer_command(
    kernel: &Kernel,
    session_ref: &SessionRef,
    label: &str,
    session_title: Option<String>,
) -> DesktopAppState {
    sessions::set_composer_draft_for_session(
        &mut kernel.data.borrow_mut(),
        session_ref,
        "",
        ComposerDraftSyncSource::Command,
    );
    finish_session_change(kernel, session_ref, label, session_title)
}

/// `finishSessionChange`: records the change in the transcript and sidebar without touching
/// the composer.
pub fn finish_session_change(
    kernel: &Kernel,
    session_ref: &SessionRef,
    label: &str,
    session_title: Option<String>,
) -> DesktopAppState {
    {
        let mut data = kernel.data.borrow_mut();
        let key = session_key(session_ref);
        let activity = make_activity_item(kernel.env(), label, ActivityOptions::default());
        let transcript = data
            .sessions
            .transcript_cache
            .entry(key.clone())
            .or_default();
        transcript.push(activity);
        let preview = preview_from_transcript(transcript).filter(|preview| !preview.is_empty());
        let config = data.sessions.session_config_by_session.get(&key).cloned();
        apply_local_session_update(&mut data, session_ref, session_title, preview, config);
    }
    persist::schedule_persist_ui_state(kernel);
    let snapshot = publish::emit(kernel);
    publish::publish_selected_transcript_for(kernel, session_ref);
    snapshot
}

/// `applyLocalSessionUpdate`.
fn apply_local_session_update(
    data: &mut AppData,
    session_ref: &SessionRef,
    title: Option<String>,
    preview: Option<String>,
    config: Option<SessionConfig>,
) {
    if let Some(session) = data
        .state
        .workspaces
        .iter_mut()
        .filter(|workspace| workspace.id == session_ref.workspace_id)
        .flat_map(|workspace| workspace.sessions.iter_mut())
        .find(|session| session.id == session_ref.session_id)
    {
        if let Some(title) = title {
            session.title = title;
        }
        if let Some(preview) = preview {
            session.preview = preview;
        }
        session.config = config;
    }
    data.state.last_error = None;
    data.bump();
}
