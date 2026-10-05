//! pi's session events: one FIFO per subscription so a thread's events apply in order and
//! never interleave (`enqueueSessionEvent`), and `handleSessionEvent`, which folds each one into
//! the state and publishes it.

use super::refresh::{self, RefreshOptions};
use super::{extensions, orchestration, persist, publish, sessions, Kernel};
use crate::error::CoreResult;
use crate::state::desktop_state::{
    ExtensionCommandCompatibilityRecord, ExtensionCommandCompatibilityStatus,
};
use crate::state::driver::{
    session_key, ExtensionCompatibilityIssue, SessionDriverEvent, SessionEventKind, SessionRef,
    SessionStatus,
};
use crate::state::extension_command_compatibility::record_learned_command_compatibility;
use crate::state::session_state::apply_session_event_state;
use crate::state::timeline::{append_assistant_delta, apply_timeline_event, TimelineRuntimeState};
use crate::state::tool_labels::extension_tool_labels;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

/// Events waiting per subscription key. A key is present while its worker runs.
#[derive(Default)]
pub struct SessionEventQueues {
    queues: RefCell<HashMap<String, VecDeque<SessionDriverEvent>>>,
}

impl SessionEventQueues {
    /// Whether events are waiting or applying for this key.
    pub fn is_busy(&self, subscription_key: &str) -> bool {
        self.queues.borrow().contains_key(subscription_key)
    }
}

/// `enqueueSessionEvent`: parses the event and applies it after the ones before it.
pub fn enqueue_session_event(kernel: &Kernel, event: Value, subscription_key: &str) {
    let event: SessionDriverEvent = match serde_json::from_value(event) {
        Ok(event) => event,
        Err(error) => {
            eprintln!(
                "[app-store] dropped an unreadable session event for {subscription_key}: {error}"
            );
            return;
        }
    };
    enqueue_parsed(kernel, event, subscription_key);
}

/// Queues an already parsed event (`test.emitSessionEvent` comes in here too).
pub fn enqueue_parsed(kernel: &Kernel, event: SessionDriverEvent, subscription_key: &str) {
    {
        let mut queues = kernel.events.queues.borrow_mut();
        if let Some(queue) = queues.get_mut(subscription_key) {
            queue.push_back(event);
            return;
        }
        queues.insert(subscription_key.to_owned(), VecDeque::from([event]));
    }
    let kernel = kernel.rc();
    let key = subscription_key.to_owned();
    tokio::task::spawn_local(async move {
        loop {
            let next = {
                let mut queues = kernel.events.queues.borrow_mut();
                let next = queues.get_mut(&key).and_then(VecDeque::pop_front);
                if next.is_none() {
                    queues.remove(&key);
                }
                next
            };
            let Some(event) = next else {
                break;
            };
            Box::pin(handle_session_event(&kernel, event, &key)).await;
        }
    });
}

/// `handleSessionEvent`. Applying is wrapped so the event is always published: at once, or
/// coalesced for token-level streaming.
pub async fn handle_session_event(
    kernel: &Kernel,
    event: SessionDriverEvent,
    subscription_key: &str,
) {
    let key = session_key(&event.session_ref);
    if subscription_key != key {
        migrate_session_subscription_key(kernel, subscription_key, &key);
    }
    if let Err(error) = apply_session_event(kernel, &event, subscription_key, &key).await {
        eprintln!(
            "[app-store] failed to apply session event {} for {key}: {}",
            event.kind.type_name(),
            error.message
        );
    }
    if kernel.publisher.should_defer(&event) {
        kernel.publisher.schedule(kernel, &event.session_ref);
        let state = sessions::snapshot(kernel);
        publish::emit_session_event(kernel, &event, &state).await;
    } else {
        kernel.publisher.cancel(&event.session_ref);
        let snapshot = publish::emit(kernel);
        publish::publish_selected_transcript_for(kernel, &event.session_ref);
        publish::emit_session_event(kernel, &event, &snapshot).await;
    }
    kernel.publisher.observe(&event);
}

async fn apply_session_event(
    kernel: &Kernel,
    event: &SessionDriverEvent,
    subscription_key: &str,
    key: &str,
) -> CoreResult<()> {
    let session_ref = &event.session_ref;
    let (known, follow) = {
        let data = kernel.data.borrow();
        (
            data.session(session_ref).is_some(),
            subscription_key != key && data.selected_session_key() == subscription_key,
        )
    };
    let mut refreshed_followed_session = false;
    let reloads = matches!(
        event.kind,
        SessionEventKind::SessionOpened { .. }
            | SessionEventKind::SessionUpdated { .. }
            | SessionEventKind::RunCompleted { .. }
            | SessionEventKind::HostUiRequest { .. }
    );
    if !known && reloads {
        if kernel.refresh.depth() == 0 {
            let (selected_workspace_id, selected_session_id) = {
                let state = &kernel.data.borrow().state;
                (
                    if state.selected_workspace_id == session_ref.workspace_id {
                        session_ref.workspace_id.clone()
                    } else {
                        state.selected_workspace_id.clone()
                    },
                    if follow {
                        session_ref.session_id.clone()
                    } else {
                        state.selected_session_id.clone()
                    },
                )
            };
            refresh::refresh_state(
                kernel,
                RefreshOptions {
                    selected_workspace_id: Some(selected_workspace_id),
                    selected_session_id: Some(selected_session_id),
                    clear_last_error: true,
                    ..Default::default()
                },
            )
            .await?;
            refreshed_followed_session = follow;
        } else {
            // The reload that would pull this thread into state is skipped while a refresh
            // is unwinding, and the event then changes nothing; say so.
            eprintln!(
                "[app-store] {} for unknown session {key} skipped reload (refreshStateDepth={}); event state not applied",
                event.kind.type_name(),
                kernel.refresh.depth()
            );
        }
    }

    match &event.kind {
        SessionEventKind::AssistantDelta { text } => {
            let mut data = kernel.data.borrow_mut();
            let sessions = &mut data.sessions;
            append_assistant_delta(
                kernel.env(),
                &mut sessions.transcript_cache,
                &mut sessions.active_assistant_message_by_session,
                session_ref,
                text,
            );
        }
        SessionEventKind::SessionOpened { snapshot }
        | SessionEventKind::RunCompleted { snapshot } => {
            {
                let mut data = kernel.data.borrow_mut();
                sessions::update_session_config(&mut data, session_ref, snapshot.config.as_ref());
                sessions::update_session_usage(&mut data, session_ref, snapshot.usage.as_ref());
                sessions::update_queued_composer_messages(
                    kernel,
                    &mut data,
                    session_ref,
                    snapshot.queued_messages.as_deref(),
                );
            }
            sessions::refresh_session_commands(kernel, session_ref).await?;
        }
        SessionEventKind::SessionUpdated { snapshot } => {
            {
                let mut data = kernel.data.borrow_mut();
                sessions::update_session_config(&mut data, session_ref, snapshot.config.as_ref());
                sessions::update_session_usage(&mut data, session_ref, snapshot.usage.as_ref());
                sessions::update_queued_composer_messages(
                    kernel,
                    &mut data,
                    session_ref,
                    snapshot.queued_messages.as_deref(),
                );
            }
            if snapshot.status != SessionStatus::Running {
                sessions::refresh_session_commands_coalesced(kernel, session_ref);
            }
        }
        SessionEventKind::RunFailed { error } => {
            kernel.data.borrow_mut().state.last_error = Some(error.message.clone());
            sessions::refresh_session_commands(kernel, session_ref).await?;
        }
        SessionEventKind::ExtensionCompatibilityIssue { issue } => {
            report_extension_compatibility_issue(kernel, session_ref, issue, &event.timestamp);
        }
        SessionEventKind::SessionClosed { .. } => {
            {
                let mut data = kernel.data.borrow_mut();
                extensions::clear_dialog_timeouts_for_session(&mut data, session_ref);
                let sessions = &mut data.sessions;
                sessions.extension_ui_by_session.shift_remove(key);
                sessions.session_commands_by_session.shift_remove(key);
                sessions.session_usage_by_session.shift_remove(key);
                sessions
                    .queued_composer_messages_by_session
                    .shift_remove(key);
                sessions.queued_composer_edits_by_session.shift_remove(key);
            }
            sessions::clear_pending_auto_title(kernel, session_ref);
            let mut data = kernel.data.borrow_mut();
            data.pending_runtime_commands.shift_remove(key);
            data.reported_compatibility_issues.shift_remove(key);
        }
        SessionEventKind::HostUiRequest { request } => {
            extensions::apply_host_ui_request(kernel, session_ref, request, &event.timestamp);
        }
        _ => {}
    }

    {
        let mut data = kernel.data.borrow_mut();
        match &event.kind {
            SessionEventKind::SessionClosed { .. } => {
                if let Some(unsubscribe) = data.sessions.session_subscriptions.shift_remove(key) {
                    unsubscribe();
                }
                data.sessions.session_errors_by_session.shift_remove(key);
            }
            SessionEventKind::RunFailed { error } => {
                data.sessions
                    .session_errors_by_session
                    .insert(key.to_owned(), error.message.clone());
            }
            SessionEventKind::RunCompleted { .. } => {
                data.sessions.session_errors_by_session.shift_remove(key);
            }
            _ => {}
        }

        let data = &mut *data;
        let runtime_by_workspace = &data.runtime_by_workspace;
        let labels = |target: &SessionRef| {
            extension_tool_labels(runtime_by_workspace.get(&target.workspace_id))
        };
        let sessions = &mut data.sessions;
        apply_timeline_event(
            kernel.env(),
            &mut sessions.transcript_cache,
            event,
            &mut TimelineRuntimeState {
                run_metrics_by_session: &mut sessions.run_metrics_by_session,
                running_since_by_session: &mut sessions.running_since_by_session,
                active_assistant_message_by_session: &mut sessions
                    .active_assistant_message_by_session,
                pending_assistant_message_by_session: &mut sessions
                    .pending_assistant_message_by_session,
                active_working_activity_by_session: &mut sessions
                    .active_working_activity_by_session,
                extension_tool_labels: &labels,
            },
        );
        apply_session_event_state(
            &mut data.state,
            event,
            &sessions.transcript_cache,
            &sessions.running_since_by_session,
            &sessions.last_viewed_at_by_session,
        );
    }
    if matches!(event.kind, SessionEventKind::ToolFinished { .. }) {
        orchestration::handle_orchestration_thread_tool_result(kernel, event).await?;
    }
    sessions::mark_session_viewed_if_actively_viewed(kernel, session_ref);
    sessions::sync_derived_session_state(&mut kernel.data.borrow_mut(), session_ref);
    if orchestration::has_orchestration_child_session(kernel, session_ref)
        || orchestration::has_orchestration_parent_session(kernel, session_ref)
    {
        let children =
            orchestration::project_orchestration_children_for_session(kernel, session_ref);
        kernel.data.borrow_mut().state.orchestration_children = children;
        orchestration::schedule_supervision(kernel);
    }
    let closed = matches!(event.kind, SessionEventKind::SessionClosed { .. });
    if follow && !closed {
        sessions::apply_fast_session_selection(kernel, session_ref);
        if !refreshed_followed_session {
            sessions::start_selected_session_hydration(kernel, Some(session_ref.clone()), true);
        }
    }
    match event.kind {
        SessionEventKind::RunCompleted { .. }
        | SessionEventKind::RunFailed { .. }
        | SessionEventKind::SessionClosed { .. } => persist::persist_ui_state(kernel).await?,
        SessionEventKind::HostUiRequest { .. } => {}
        _ => persist::schedule_persist_ui_state(kernel),
    }
    Ok(())
}

/// `migrateSessionSubscriptionKey`: an extension's new session or fork moves the same pi
/// runtime, and its subscription, to another thread.
pub fn migrate_session_subscription_key(kernel: &Kernel, source_key: &str, target_key: &str) {
    if source_key == target_key {
        return;
    }
    let mut data = kernel.data.borrow_mut();
    if !data.sessions.session_subscriptions.contains_key(source_key) {
        return;
    }
    // The runtime keeps the flags it loaded with. A thread that has its own flags keeps them
    // for its next reopen.
    let flags = data
        .sessions
        .extension_flags_by_session
        .get(source_key)
        .cloned();
    let mut persist_flags = false;
    if let Some(flags) = flags {
        if !data
            .sessions
            .extension_flags_by_session
            .contains_key(target_key)
        {
            data.sessions
                .extension_flags_by_session
                .insert(target_key.to_owned(), flags);
            data.state.extension_flags_by_session =
                data.sessions.extension_flags_by_session.clone();
            persist_flags = true;
        }
    }
    let unsubscribe = data
        .sessions
        .session_subscriptions
        .shift_remove(source_key)
        .expect("checked above");
    if data.sessions.session_subscriptions.contains_key(target_key) {
        unsubscribe();
    } else {
        data.sessions
            .session_subscriptions
            .insert(target_key.to_owned(), unsubscribe);
    }
    drop(data);
    if persist_flags {
        persist::schedule_persist_ui_state(kernel);
    }
}

/// `formatCapabilityLabel`.
fn format_capability_label(capability: &str) -> String {
    match capability {
        "custom" => "custom UI".into(),
        "onTerminalInput" => "terminal input".into(),
        "setEditorComponent" => "custom editor UI".into(),
        "setFooter" => "footer UI".into(),
        "setHeader" => "header UI".into(),
        other => {
            let mut label = String::with_capacity(other.len() + 4);
            let mut previous_lower = false;
            for character in other.chars() {
                if previous_lower && character.is_ascii_uppercase() {
                    label.push(' ');
                }
                previous_lower = character.is_ascii_lowercase();
                label.push(character);
            }
            label.to_lowercase()
        }
    }
}

/// `reportExtensionCompatibilityIssue`.
pub fn report_extension_compatibility_issue(
    kernel: &Kernel,
    session_ref: &SessionRef,
    issue: &ExtensionCompatibilityIssue,
    timestamp: &str,
) {
    let key = session_key(session_ref);
    let mut data = kernel.data.borrow_mut();
    let data = &mut *data;
    if let Some(pending) = data.pending_runtime_commands.get_mut(&key) {
        let message = format!(
            "/{} requires terminal-only {} and is not supported in pi-gui yet. Use pi in the terminal for this command.",
            pending.command.name,
            format_capability_label(&issue.capability)
        );
        pending.blocked_message = Some(message.clone());
        record_learned_command_compatibility(
            &mut data.compatibility_by_workspace,
            &session_ref.workspace_id,
            ExtensionCommandCompatibilityRecord {
                command_name: pending.command.name.clone(),
                extension_path: pending.command.source_info.path.clone(),
                status: ExtensionCommandCompatibilityStatus::TerminalOnly,
                message: message.clone(),
                capability: issue.capability.clone(),
                updated_at: timestamp.to_owned(),
            },
        );
        data.sessions.session_errors_by_session.insert(key, message);
        return;
    }
    let fingerprint = format!(
        "{}:{}:{}",
        issue.extension_path.as_deref().unwrap_or("<unknown>"),
        issue.event_name.as_deref().unwrap_or("<unknown>"),
        issue.capability
    );
    let seen = data
        .reported_compatibility_issues
        .entry(key.clone())
        .or_default();
    if !seen.insert(fingerprint) {
        return;
    }
    data.sessions
        .session_errors_by_session
        .insert(key, issue.message.clone());
}

#[cfg(test)]
mod tests {
    use super::format_capability_label;

    #[test]
    fn capability_labels_read_like_the_typescript() {
        assert_eq!(format_capability_label("custom"), "custom UI");
        assert_eq!(
            format_capability_label("setWidgetFactory"),
            "set widget factory"
        );
        assert_eq!(format_capability_label("x"), "x");
    }
}
