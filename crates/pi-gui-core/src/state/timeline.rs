//! Twin of `apps/desktop/electron/conversation/app-store-timeline.ts`: builds a thread's
//! transcript from pi's saved items and folds live session events into it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::app_store_utils::{
    format_elapsed_duration, make_activity_item, make_summary_item, make_tool_item,
    make_transcript_message, make_transcript_message_with_attachments, ActivityOptions, SessionMap,
    ToolItemOptions,
};
use super::driver::{
    session_key, AppendedTranscriptItem, HostUiRequest, NoticeLevel, SessionAttachment,
    SessionDriverEvent, SessionEventKind, SessionQueuedMessage, SessionRef, SessionStatus,
    SessionToolStatus, SessionTranscriptItem, SessionTranscriptMessage, SessionTranscriptPin,
    SessionTranscriptRole,
};
use super::env::StateEnv;
use super::js;
use super::timeline_types::{
    is_card_entry_item, TimelineSummaryPresentation, TimelineTone, TimelineToolStatus,
    TranscriptMessage,
};
use super::tool_labels::{
    extension_tool_row_label, tool_input_summary, truncate_default, ExtensionToolLabels,
};

/// The orchestration tools' names, as in `electron/orchestration/orchestration-runtime.ts`.
pub const CREATE_CHILD_THREAD_TOOL_NAME: &str = "create_child_thread";
pub const LIST_THREADS_TOOL_NAME: &str = "list_threads";
pub const READ_THREAD_TOOL_NAME: &str = "read_thread";
pub const SEND_MESSAGE_TO_THREAD_TOOL_NAME: &str = "send_message_to_thread";

/// Each thread's transcript, by session key.
pub type TranscriptCache = SessionMap<Vec<TranscriptMessage>>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMetrics {
    pub started_at: String,
    pub tool_count: u32,
    pub search_count: u32,
    pub file_count: u32,
}

/// `TimelineRuntimeState`: the per-session run bookkeeping the timeline reads and writes.
pub struct TimelineRuntimeState<'a> {
    pub run_metrics_by_session: &'a mut SessionMap<RunMetrics>,
    pub running_since_by_session: &'a mut SessionMap<String>,
    pub active_assistant_message_by_session: &'a mut SessionMap<String>,
    pub pending_assistant_message_by_session: &'a mut SessionMap<String>,
    pub active_working_activity_by_session: &'a mut SessionMap<String>,
    /// Labels of the tools the session's folder extensions registered.
    pub extension_tool_labels: &'a dyn Fn(&SessionRef) -> ExtensionToolLabels,
}

/// `timelineFromDriverTranscript`: pi's saved items as timeline rows. Tool calls become tool
/// rows with labels; everything else passes through.
pub fn timeline_from_driver_transcript(
    env: &dyn StateEnv,
    items: Vec<SessionTranscriptItem>,
    extension_tool_labels: &ExtensionToolLabels,
) -> Vec<TranscriptMessage> {
    items
        .into_iter()
        .map(|item| match item {
            SessionTranscriptItem::Message(item) => TranscriptMessage::Message(item),
            SessionTranscriptItem::Custom(item) => TranscriptMessage::Custom(item),
            SessionTranscriptItem::Card(item) => TranscriptMessage::Card(item),
            SessionTranscriptItem::Pin(item) => TranscriptMessage::Pin(item),
            SessionTranscriptItem::Tool(item) => {
                let detail = detail_from_output(item.output.as_ref());
                let label = match extension_tool_labels.get(&item.tool_name) {
                    None => tool_label(&item.tool_name, item.input.as_ref()),
                    Some(label) => extension_tool_row_label(label, item.input.as_ref()),
                };
                let status = match item.status {
                    SessionToolStatus::Success => TimelineToolStatus::Success,
                    SessionToolStatus::Error => TimelineToolStatus::Error,
                };
                let mut row = make_tool_item(
                    env,
                    &item.call_id,
                    &item.tool_name,
                    status,
                    label,
                    ToolItemOptions {
                        detail,
                        metadata: None,
                        input: item.input,
                        output: item.output,
                    },
                );
                row.created_at = item.created_at;
                TranscriptMessage::Tool(row)
            }
        })
        .collect()
}

/// `appendUserMessage`: the optimistic row for a message the user just sent. Returns its id.
pub fn append_user_message(
    env: &dyn StateEnv,
    transcript_cache: &mut TranscriptCache,
    session_ref: &SessionRef,
    text: &str,
    attachments: &[SessionAttachment],
) -> String {
    let message = if attachments.is_empty() {
        make_transcript_message(env, SessionTranscriptRole::User, text)
    } else {
        make_transcript_message_with_attachments(
            env,
            SessionTranscriptRole::User,
            text,
            attachments,
        )
    };
    let id = message.id.clone();
    transcript_cache
        .entry(session_key(session_ref))
        .or_default()
        .push(TranscriptMessage::Message(message));
    id
}

/// `appendQueuedUserMessage`: a queued message that started, replacing its row if shown.
pub fn append_queued_user_message(
    transcript_cache: &mut TranscriptCache,
    session_ref: &SessionRef,
    message: &SessionQueuedMessage,
) {
    let transcript = transcript_cache
        .entry(session_key(session_ref))
        .or_default();
    let next = TranscriptMessage::Message(SessionTranscriptMessage {
        role: SessionTranscriptRole::User,
        text: message.text.clone(),
        attachments: message
            .attachments
            .clone()
            .filter(|attachments| !attachments.is_empty()),
        created_at: message.created_at.clone(),
        id: message.id.clone(),
        source_message_id: None,
        extra: Default::default(),
    });
    let existing = transcript
        .iter()
        .position(|item| matches!(item, TranscriptMessage::Message(row) if row.id == message.id));
    match existing {
        Some(index) => transcript[index] = next,
        None => transcript.push(next),
    }
}

/// `appendAssistantDelta`: streamed reply text, added to the reply being written or to a new
/// row.
pub fn append_assistant_delta(
    env: &dyn StateEnv,
    transcript_cache: &mut TranscriptCache,
    active_assistant_message_by_session: &mut SessionMap<String>,
    session_ref: &SessionRef,
    text: &str,
) {
    let key = session_key(session_ref);
    let transcript = transcript_cache.entry(key.clone()).or_default();
    let active_id = active_assistant_message_by_session
        .get(&key)
        .filter(|id| !id.is_empty());
    let current = active_id.and_then(|active_id| {
        transcript
            .iter_mut()
            .find(|item| item.id() == active_id.as_str())
    });
    if let Some(TranscriptMessage::Message(current)) = current {
        current.text.push_str(text);
        return;
    }
    let message = make_transcript_message(env, SessionTranscriptRole::Assistant, text);
    active_assistant_message_by_session.insert(key, message.id.clone());
    transcript.push(TranscriptMessage::Message(message));
}

/// `clearActiveAssistantMessage`.
pub fn clear_active_assistant_message(
    active_assistant_message_by_session: &mut SessionMap<String>,
    session_ref: &SessionRef,
) {
    active_assistant_message_by_session.shift_remove(&session_key(session_ref));
}

/// `applyTimelineEvent`: folds one session event into the thread's transcript and run
/// bookkeeping. Assistant text arrives through `append_assistant_delta` instead.
pub fn apply_timeline_event(
    env: &dyn StateEnv,
    transcript_cache: &mut TranscriptCache,
    event: &SessionDriverEvent,
    state: &mut TimelineRuntimeState<'_>,
) {
    let key = session_key(&event.session_ref);
    match &event.kind {
        SessionEventKind::AssistantDelta { .. } => return,
        SessionEventKind::AssistantMessageEnded {} => {
            match state
                .active_assistant_message_by_session
                .get(&key)
                .filter(|id| !id.is_empty())
                .cloned()
            {
                Some(active_id) => {
                    state
                        .pending_assistant_message_by_session
                        .insert(key, active_id);
                }
                None => {
                    state
                        .pending_assistant_message_by_session
                        .shift_remove(&key);
                }
            }
            clear_active_assistant_message(
                state.active_assistant_message_by_session,
                &event.session_ref,
            );
            return;
        }
        SessionEventKind::AssistantMessagePersisted { source_message_id } => {
            let ended_id = state
                .pending_assistant_message_by_session
                .shift_remove(&key);
            let Some(transcript) = transcript_cache.get_mut(&key) else {
                return;
            };
            let ended = ended_id
                .and_then(|ended_id| transcript.iter_mut().find(|item| item.id() == ended_id));
            if let Some(TranscriptMessage::Message(ended)) = ended {
                if ended.role == SessionTranscriptRole::Assistant {
                    ended.source_message_id = Some(source_message_id.clone());
                }
            }
            return;
        }
        SessionEventKind::QueuedMessageStarted { message } => {
            state
                .pending_assistant_message_by_session
                .shift_remove(&key);
            clear_active_assistant_message(
                state.active_assistant_message_by_session,
                &event.session_ref,
            );
            append_queued_user_message(transcript_cache, &event.session_ref, message);
            return;
        }
        _ => {}
    }

    let current_metrics = state.run_metrics_by_session.get(&key).cloned();
    let transcript = transcript_cache.entry(key.clone()).or_default();

    match &event.kind {
        SessionEventKind::SessionOpened { .. } => {
            state
                .pending_assistant_message_by_session
                .shift_remove(&key);
            transcript.push(make_activity_item(
                env,
                "Resumed session",
                ActivityOptions {
                    metadata: Some(relative_detail(env, &event.timestamp)),
                    ..Default::default()
                },
            ));
        }
        SessionEventKind::SessionUpdated { snapshot } => {
            if snapshot.status == SessionStatus::Running
                && snapshot
                    .running_run_id
                    .as_deref()
                    .is_some_and(|id| !id.is_empty())
                && !state.running_since_by_session.contains_key(&key)
            {
                state
                    .running_since_by_session
                    .insert(key.clone(), event.timestamp.clone());
                state.run_metrics_by_session.insert(
                    key.clone(),
                    RunMetrics {
                        started_at: event.timestamp.clone(),
                        tool_count: 0,
                        search_count: 0,
                        file_count: 0,
                    },
                );
                let activity = make_activity_item(env, "Working…", ActivityOptions::default());
                state
                    .active_working_activity_by_session
                    .insert(key.clone(), activity.id().to_string());
                transcript.push(activity);
            }
        }
        SessionEventKind::ToolStarted {
            tool_name,
            call_id,
            input,
        } => {
            clear_active_assistant_message(
                state.active_assistant_message_by_session,
                &event.session_ref,
            );
            let mut metrics = current_metrics.unwrap_or_else(|| RunMetrics {
                started_at: event.timestamp.clone(),
                tool_count: 0,
                search_count: 0,
                file_count: 0,
            });
            metrics.tool_count += 1;
            let labels = (state.extension_tool_labels)(&event.session_ref);
            let extension_label = labels.get(tool_name);
            // An extension's tool is counted as a tool: its name says nothing about files or
            // searches.
            if extension_label.is_none() && looks_like_search(tool_name, input.as_ref()) {
                metrics.search_count += 1;
            }
            if extension_label.is_none() && looks_like_file_explore(tool_name, input.as_ref()) {
                metrics.file_count += 1;
            }
            state.run_metrics_by_session.insert(key.clone(), metrics);
            let label = match extension_label {
                None => tool_label(tool_name, input.as_ref()),
                Some(label) => extension_tool_row_label(label, input.as_ref()),
            };
            upsert_tool_row(
                env,
                transcript,
                call_id,
                ToolRowUpdate {
                    tool_name: Some(tool_name),
                    status: Some(TimelineToolStatus::Running),
                    label: Some(label),
                    input: input.clone(),
                    ..Default::default()
                },
            );
        }
        SessionEventKind::ToolUpdated {
            call_id,
            text,
            progress,
        } => {
            upsert_tool_row(
                env,
                transcript,
                call_id,
                ToolRowUpdate {
                    status: Some(TimelineToolStatus::Running),
                    detail: text
                        .clone()
                        .or_else(|| progress.map(|progress| progress_label(progress.0))),
                    ..Default::default()
                },
            );
        }
        SessionEventKind::ToolFinished {
            call_id,
            success,
            output,
        } => {
            upsert_tool_row(
                env,
                transcript,
                call_id,
                ToolRowUpdate {
                    status: Some(if *success {
                        TimelineToolStatus::Success
                    } else {
                        TimelineToolStatus::Error
                    }),
                    detail: detail_from_output(output.as_ref()),
                    output: output.clone(),
                    ..Default::default()
                },
            );
        }
        SessionEventKind::RunCompleted { .. } => {
            clear_run_state(transcript, &key, state);
            match current_metrics {
                Some(metrics) => {
                    if let Some(label) = summary_label(&metrics) {
                        transcript.push(make_summary_item(
                            env,
                            &label,
                            Some(TimelineSummaryPresentation::Inline),
                            None,
                        ));
                    }
                    // No "Worked for" row here: the renderer derives one per turn from
                    // timestamps and places it above the turn's final reply.
                }
                None => transcript.push(make_summary_item(
                    env,
                    "Completed",
                    Some(TimelineSummaryPresentation::Divider),
                    Some(relative_detail(env, &event.timestamp)),
                )),
            }
        }
        SessionEventKind::RunFailed { error } => {
            let latest_tool_error = current_metrics
                .as_ref()
                .and_then(|metrics| latest_error_tool_detail(env, transcript, &metrics.started_at));
            let failure_label = clearer_run_failure_label(&error.message, latest_tool_error);
            clear_run_state(transcript, &key, state);
            transcript.push(make_activity_item(
                env,
                &failure_label,
                ActivityOptions {
                    tone: Some(TimelineTone::Error),
                    metadata: current_metrics.map(|metrics| {
                        worked_for_label(env, &metrics.started_at, &event.timestamp)
                    }),
                    detail: error.code.clone(),
                },
            ));
        }
        SessionEventKind::SessionClosed { .. } => {
            clear_run_state(transcript, &key, state);
            transcript.push(make_activity_item(
                env,
                "Stopped",
                ActivityOptions {
                    metadata: Some(relative_detail(env, &event.timestamp)),
                    ..Default::default()
                },
            ));
        }
        SessionEventKind::TranscriptItemAppended { item } => {
            let item = match item.clone() {
                // A pin shows above the composer, so it never ends or moves a streaming reply.
                AppendedTranscriptItem::Pin(pin) => {
                    upsert_pin(transcript, pin);
                    return;
                }
                AppendedTranscriptItem::Custom(custom) => TranscriptMessage::Custom(custom),
                AppendedTranscriptItem::Card(card) => TranscriptMessage::Card(card),
            };
            // Same id as the persisted entry, so a reload replaces rather than duplicates it.
            // A keyed card (or a pin's error row) already shown updates where it is.
            if let Some(index) = transcript.iter().position(|row| row.id() == item.id()) {
                if is_card_entry_item(&item) {
                    transcript[index] = item;
                }
                return;
            }
            // pi saves a streaming reply only when it ends, so a card appended mid-reply comes
            // before that reply in the session file. Place it there now so a reload never
            // moves it.
            let streaming_index = state
                .active_assistant_message_by_session
                .get(&key)
                .filter(|id| !id.is_empty() && is_card_entry_item(&item))
                .and_then(|streaming_id| {
                    transcript.iter().position(|row| row.id() == streaming_id)
                });
            if let Some(index) = streaming_index {
                transcript.insert(index, item);
                return;
            }
            // Otherwise it lands between assistant messages like a tool row: the reply above
            // keeps its row and later text starts a new one below.
            clear_active_assistant_message(
                state.active_assistant_message_by_session,
                &event.session_ref,
            );
            transcript.push(item);
        }
        SessionEventKind::HostUiRequest {
            request:
                HostUiRequest::Notify {
                    message,
                    level: Some(NoticeLevel::Error),
                    ..
                },
        } => {
            // Notices show as toasts; only errors also stay in the transcript.
            transcript.push(make_activity_item(
                env,
                message,
                ActivityOptions {
                    tone: Some(TimelineTone::Error),
                    metadata: Some(relative_detail(env, &event.timestamp)),
                    ..Default::default()
                },
            ));
        }
        _ => {}
    }
}

/// `upsertPin`: replaces a pin's earlier write; a pin written after its removal is new.
fn upsert_pin(transcript: &mut Vec<TranscriptMessage>, pin: SessionTranscriptPin) {
    let index = transcript.iter().position(|row| row.id() == pin.id);
    if let Some(index) = index {
        if let TranscriptMessage::Pin(existing) = &transcript[index] {
            if existing.card.is_some() || pin.card.is_none() {
                transcript[index] = TranscriptMessage::Pin(pin);
                return;
            }
        }
        transcript.remove(index);
    }
    transcript.push(TranscriptMessage::Pin(pin));
}

/// The fields `upsertToolRow` may set; `None` keeps the row's current value.
#[derive(Default)]
struct ToolRowUpdate<'a> {
    tool_name: Option<&'a str>,
    status: Option<TimelineToolStatus>,
    label: Option<String>,
    detail: Option<String>,
    input: Option<Value>,
    output: Option<Value>,
}

fn upsert_tool_row(
    env: &dyn StateEnv,
    transcript: &mut Vec<TranscriptMessage>,
    call_id: &str,
    update: ToolRowUpdate<'_>,
) {
    let index = transcript
        .iter()
        .position(|row| matches!(row, TranscriptMessage::Tool(tool) if tool.call_id == call_id));
    let existing = index.and_then(|index| match &transcript[index] {
        TranscriptMessage::Tool(tool) => Some(tool.clone()),
        _ => None,
    });
    // `??` treats null like a missing value, so a null input or output keeps the old one.
    let nullish = |value: Option<Value>| value.filter(|value| !value.is_null());
    let mut next = make_tool_item(
        env,
        call_id,
        update
            .tool_name
            .or(existing.as_ref().map(|tool| tool.tool_name.as_str()))
            .unwrap_or("tool"),
        update
            .status
            .or(existing.as_ref().map(|tool| tool.status))
            .unwrap_or(TimelineToolStatus::Running),
        update
            .label
            .or_else(|| existing.as_ref().map(|tool| tool.label.clone()))
            .unwrap_or_else(|| "Working".into()),
        ToolItemOptions {
            detail: update
                .detail
                .or_else(|| existing.as_ref().and_then(|tool| tool.detail.clone())),
            metadata: existing.as_ref().and_then(|tool| tool.metadata.clone()),
            input: nullish(update.input)
                .or_else(|| existing.as_ref().and_then(|tool| tool.input.clone())),
            output: nullish(update.output)
                .or_else(|| existing.as_ref().and_then(|tool| tool.output.clone())),
        },
    );
    match (index, existing) {
        (Some(index), Some(existing)) => {
            next.created_at = existing.created_at;
            transcript[index] = TranscriptMessage::Tool(next);
        }
        _ => transcript.push(TranscriptMessage::Tool(next)),
    }
}

fn remove_working_activity(transcript: &mut Vec<TranscriptMessage>, activity_id: Option<&str>) {
    let Some(activity_id) = activity_id.filter(|id| !id.is_empty()) else {
        return;
    };
    if let Some(index) = transcript.iter().position(
        |row| matches!(row, TranscriptMessage::Activity(activity) if activity.id == activity_id),
    ) {
        transcript.remove(index);
    }
}

fn clear_run_state(
    transcript: &mut Vec<TranscriptMessage>,
    key: &str,
    state: &mut TimelineRuntimeState<'_>,
) {
    state.active_assistant_message_by_session.shift_remove(key);
    state.pending_assistant_message_by_session.shift_remove(key);
    remove_working_activity(
        transcript,
        state
            .active_working_activity_by_session
            .get(key)
            .map(String::as_str),
    );
    state.active_working_activity_by_session.shift_remove(key);
    state.running_since_by_session.shift_remove(key);
    state.run_metrics_by_session.shift_remove(key);
}

/// `toolLabel`: pi-gui's wording for a tool row ("Read src/app.ts", "Searched …").
pub fn tool_label(tool_name: &str, input: Option<&Value>) -> String {
    let detail = tool_input_summary(input).filter(|detail| !detail.is_empty());
    let with = |prefix: &str, fallback: String| match &detail {
        Some(detail) => format!("{prefix}{detail}"),
        None => fallback,
    };
    match tool_name {
        CREATE_CHILD_THREAD_TOOL_NAME => {
            return with("Started child thread: ", "Started child thread".into())
        }
        LIST_THREADS_TOOL_NAME => return "Listed threads".into(),
        READ_THREAD_TOOL_NAME => return with("Read thread: ", "Read thread".into()),
        SEND_MESSAGE_TO_THREAD_TOOL_NAME => {
            return with("Sent message to thread: ", "Sent message to thread".into())
        }
        _ => {}
    }
    if looks_like_search(tool_name, input) {
        return with("Searched ", format!("Searched with {tool_name}"));
    }
    if looks_like_file_explore(tool_name, input) {
        if tool_name.to_lowercase() == "read" {
            return with("Read ", "Read a file".into());
        }
        return with("Explored ", format!("Explored files with {tool_name}"));
    }
    match &detail {
        Some(detail) => format!("Ran {tool_name}: {detail}"),
        None => format!("Ran {tool_name}"),
    }
}

fn progress_label(progress: f64) -> String {
    if progress <= 1.0 {
        return format!("{}%", js::number_to_string(js::js_round(progress * 100.0)));
    }
    js::number_to_string(progress)
}

/// `detailFromOutput`: the short text a tool row shows under its label.
pub fn detail_from_output(output: Option<&Value>) -> Option<String> {
    let output = output?;
    if let Value::Object(record) = output {
        let direct_error = string_property(record, "error")
            .or_else(|| string_property(record, "message"))
            .or_else(|| string_property(record, "stderr"));
        if let Some(direct_error) = direct_error {
            return Some(truncate_default(direct_error));
        }
        if let Some(Value::Array(content)) = record.get("content") {
            let text = content
                .iter()
                .map(|part| match (part.get("type"), part.get("text")) {
                    (Some(Value::String(kind)), Some(Value::String(text))) if kind == "text" => {
                        text.as_str()
                    }
                    _ => "",
                })
                .collect::<Vec<_>>()
                .join("\n");
            let text = js::js_trim(&text);
            if !text.is_empty() {
                return Some(truncate_default(text));
            }
            // The row shows a tool's images itself, so the detail names them rather than dump
            // their data.
            let images: Vec<String> = content
                .iter()
                .filter_map(|part| match part {
                    Value::Object(part)
                        if part.get("type").and_then(Value::as_str) == Some("image") =>
                    {
                        Some(format!(
                            "[{} image]",
                            string_property(part, "mimeType").unwrap_or("image")
                        ))
                    }
                    _ => None,
                })
                .collect();
            if !images.is_empty() {
                return Some(truncate_default(&images.join(" ")));
            }
        }
    }
    match output {
        Value::String(text) => Some(truncate_default(text)),
        Value::Null => None,
        other => Some(truncate_default(&js::json_stringify(other))),
    }
}

fn looks_like_search(tool_name: &str, input: Option<&Value>) -> bool {
    if tool_name.to_lowercase().contains("search") {
        return true;
    }
    matches!(input, Some(Value::String(text)) if contains_ascii_insensitive(text, &["http://", "https://", "site:", "query", "search"]))
}

fn looks_like_file_explore(tool_name: &str, input: Option<&Value>) -> bool {
    if contains_ascii_insensitive(tool_name, &["read", "glob", "ls", "list", "open"]) {
        return true;
    }
    matches!(input, Some(Value::String(text)) if contains_ascii_insensitive(text, &["/", ".md", ".ts", "file"]))
}

/// A case-insensitive regex alternation of ASCII words: JavaScript's `/…/i` without `u` folds
/// only ASCII letters onto ASCII ones.
fn contains_ascii_insensitive(haystack: &str, needles: &[&str]) -> bool {
    let lower = haystack.to_ascii_lowercase();
    needles.iter().any(|needle| lower.contains(needle))
}

fn summary_label(metrics: &RunMetrics) -> Option<String> {
    let plural = |count: u32, one: &str, many: &str| {
        format!("{count} {}", if count == 1 { one } else { many })
    };
    let mut parts = Vec::new();
    if metrics.file_count > 0 {
        parts.push(format!(
            "Explored {}",
            plural(metrics.file_count, "file", "files")
        ));
    }
    if metrics.search_count > 0 {
        parts.push(plural(metrics.search_count, "search", "searches"));
    }
    if parts.is_empty() && metrics.tool_count > 0 {
        parts.push(format!(
            "Used {}",
            plural(metrics.tool_count, "tool", "tools")
        ));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn worked_for_label(env: &dyn StateEnv, started_at: &str, ended_at: &str) -> String {
    format!(
        "Worked for {}",
        format_elapsed_duration(env, started_at, ended_at)
    )
}

/// `relativeDetail`: the time of day an event happened, as the row's metadata.
fn relative_detail(env: &dyn StateEnv, timestamp: &str) -> String {
    js::en_us_time_of_day(env.date_parse(timestamp), env.time_zone())
}

fn latest_error_tool_detail(
    env: &dyn StateEnv,
    transcript: &[TranscriptMessage],
    run_started_at: &str,
) -> Option<String> {
    let run_started_at_ms = env.date_parse(run_started_at);
    for item in transcript.iter().rev() {
        if run_started_at_ms.is_finite() && env.date_parse(item.created_at()) < run_started_at_ms {
            break;
        }
        if let TranscriptMessage::Tool(tool) = item {
            if tool.status == TimelineToolStatus::Error {
                if let Some(detail) = tool.detail.as_ref().filter(|detail| !detail.is_empty()) {
                    return Some(detail.clone());
                }
            }
        }
    }
    None
}

fn clearer_run_failure_label(message: &str, latest_tool_error: Option<String>) -> String {
    let Some(latest_tool_error) = latest_tool_error else {
        return message.to_string();
    };
    let normalized = js::js_trim(message).to_lowercase();
    if matches!(
        normalized.as_str(),
        "terminated" | "failed" | "error" | "run failed"
    ) {
        return latest_tool_error;
    }
    message.to_string()
}

fn string_property<'a>(record: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    match record.get(key) {
        Some(Value::String(text)) if !js::js_trim(text).is_empty() => Some(text),
        _ => None,
    }
}
