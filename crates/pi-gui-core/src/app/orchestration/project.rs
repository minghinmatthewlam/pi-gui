//! What a child thread shows: its status, recent transcript, evidence and supervision loop,
//! worked out from the child's and parent's transcripts (`projectOrchestrationChild` and the
//! evidence and supervision helpers in `app-store-orchestration.ts`).

use super::super::AppData;
use crate::js;
use crate::persistence::catalog::SessionStatus;
use crate::state::app_store_utils::{latest_session_activity_at, preview_from_transcript};
use crate::state::desktop_state::{
    EvidenceSeverity, OrchestrationChildThread, OrchestrationChildThreadStatus as ChildStatus,
    OrchestrationChildTranscriptMessage, OrchestrationChildTranscriptRole,
    OrchestrationEvidenceKind as Kind, OrchestrationEvidenceRecord as Evidence,
    OrchestrationEvidenceSource as Source, OrchestrationEvidenceStatus as EvidenceStatus,
    OrchestrationSupervisionGate as Gate, OrchestrationSupervisionLoop,
    OrchestrationSupervisionStatus as LoopStatus,
};
use crate::state::driver::{session_key, session_ref, SessionRef, SessionTranscriptRole};
use crate::state::env::StateEnv;
use crate::state::timeline_types::{TimelineToolCall, TimelineToolStatus, TranscriptMessage};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashMap;

pub const MAX_CHILD_TRANSCRIPT_MESSAGES: usize = 40;
pub const MAX_EVIDENCE_RECORDS_PER_CHILD: usize = 80;
const DEFAULT_SUPERVISION_INTERVAL_MS: f64 = 60_000.0;
const MIN_SUPERVISION_INTERVAL_MS: f64 = 250.0;
const EVIDENCE_DETAIL_LIMIT: usize = 260;

pub const LIST_THREADS_ACTION: &str = "pi_gui_list_threads";
pub const READ_THREAD_ACTION: &str = "pi_gui_read_thread";
pub const SEND_MESSAGE_TO_THREAD_ACTION: &str = "pi_gui_send_message_to_thread";
pub const CREATE_CHILD_THREAD_ACTION: &str = "pi_gui_create_child_thread";

/// `childSessionRef`.
pub fn child_session_ref(child: &OrchestrationChildThread) -> SessionRef {
    session_ref(&child.child_workspace_id, &child.child_session_id)
}

/// `transcriptFor`: the cached transcript, or none.
pub fn transcript_for<'a>(data: &'a AppData, session_ref: &SessionRef) -> &'a [TranscriptMessage] {
    data.sessions
        .transcript_cache
        .get(&session_key(session_ref))
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// `getQueuedComposerMessages(...).length`.
pub fn queued_message_count(data: &AppData, session_ref: &SessionRef) -> usize {
    data.sessions
        .queued_composer_messages_by_session
        .get(&session_key(session_ref))
        .map_or(0, Vec::len)
}

/// `isWorkerResponse`: a tool row or an assistant reply.
pub fn is_worker_response(item: &TranscriptMessage) -> bool {
    match item {
        TranscriptMessage::Tool(_) => true,
        TranscriptMessage::Message(message) => message.role == SessionTranscriptRole::Assistant,
        _ => false,
    }
}

/// `toOrchestrationStatus`.
pub fn to_orchestration_status(
    data: &AppData,
    status: SessionStatus,
    session_ref: &SessionRef,
) -> ChildStatus {
    if queued_message_count(data, session_ref) > 0 {
        return ChildStatus::Waiting;
    }
    match status {
        SessionStatus::Failed => ChildStatus::Failed,
        SessionStatus::Running => ChildStatus::Running,
        // An idle session that has never produced a run is queued, not complete. The child
        // record is inserted before its prompt is sent, so without this a never-started child
        // would read "complete" and trigger a false parent wake.
        SessionStatus::Idle
            if !transcript_for(data, session_ref)
                .iter()
                .any(is_worker_response) =>
        {
            ChildStatus::Queued
        }
        SessionStatus::Idle => ChildStatus::Complete,
    }
}

/// `projectOrchestrationChildren`.
pub fn project_children(
    data: &AppData,
    env: &dyn StateEnv,
    children: &[OrchestrationChildThread],
) -> Vec<OrchestrationChildThread> {
    let now = env.now_iso();
    let parent_evidence = parent_evidence_index(data, children);
    children
        .iter()
        .map(|child| {
            project_child(
                data,
                env,
                child,
                &now,
                parent_evidence
                    .get(&child.id)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
            )
        })
        .collect()
}

/// `projectOrchestrationChildrenForSession`: only the children whose own thread is
/// `session_ref` are worked out again.
pub fn project_children_for_session(
    data: &AppData,
    env: &dyn StateEnv,
    session_ref: &SessionRef,
) -> Vec<OrchestrationChildThread> {
    let now = env.now_iso();
    let children = &data.state.orchestration_children;
    let parent_evidence = parent_evidence_index(data, children);
    children
        .iter()
        .map(|child| {
            if child.child_workspace_id == session_ref.workspace_id
                && child.child_session_id == session_ref.session_id
            {
                project_child(
                    data,
                    env,
                    child,
                    &now,
                    parent_evidence
                        .get(&child.id)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                )
            } else {
                child.clone()
            }
        })
        .collect()
}

/// `projectOrchestrationChild`.
pub fn project_child(
    data: &AppData,
    env: &dyn StateEnv,
    child: &OrchestrationChildThread,
    now_iso: &str,
    parent_evidence: &[Evidence],
) -> OrchestrationChildThread {
    if child.child_session_id.is_empty() {
        return child.clone();
    }
    let child_ref = child_session_ref(child);
    let session = data.session(&child_ref);
    let raw = recent_transcript_items(transcript_for(data, &child_ref));
    let transcript = to_child_transcript(&raw, MAX_CHILD_TRANSCRIPT_MESSAGES);
    let latest_transcript = session
        .map(|session| session.preview.clone())
        .filter(|preview| !preview.is_empty())
        .or_else(|| preview_from_transcript(&raw).filter(|preview| !preview.is_empty()))
        .unwrap_or_else(|| child.goal.clone());
    let updated_at = latest_session_activity_at(
        session.map_or(&child.updated_at, |session| &session.updated_at),
        &raw,
    )
    .to_owned();
    let status = session.map_or(child.status, |session| {
        to_orchestration_status(data, session.status, &child_ref)
    });
    let mut derived = evidence_from_child_transcript(child, &raw);
    derived.extend(parent_evidence.iter().cloned());
    derived.extend(blocker_evidence_from_child_status(
        child,
        status,
        &updated_at,
    ));
    OrchestrationChildThread {
        title: session
            .map(|session| session.title.clone())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| child.title.clone()),
        status,
        latest_transcript,
        transcript,
        evidence: merge_evidence_records(&child.evidence, derived),
        supervision_loop: Some(project_supervision_loop(
            env,
            child.supervision_loop.as_ref(),
            status,
            now_iso,
        )),
        updated_at,
        ..child.clone()
    }
}

// ---- Transcript summaries ----

/// `recentTranscriptItems`: pins sit at the end of a transcript but are never child messages,
/// so they take no slots.
fn recent_transcript_items(transcript: &[TranscriptMessage]) -> Vec<TranscriptMessage> {
    let items: Vec<&TranscriptMessage> = transcript
        .iter()
        .filter(|item| !matches!(item, TranscriptMessage::Pin(_)))
        .collect();
    let start = items.len().saturating_sub(MAX_CHILD_TRANSCRIPT_MESSAGES);
    items[start..].iter().map(|item| (*item).clone()).collect()
}

/// `toChildTranscript`: the last `limit` rows that say something, oldest first.
pub fn to_child_transcript(
    transcript: &[TranscriptMessage],
    limit: usize,
) -> Vec<OrchestrationChildTranscriptMessage> {
    let mut messages = Vec::new();
    for message in transcript.iter().rev() {
        if messages.len() >= limit {
            break;
        }
        let text = transcript_text(message);
        if text.is_empty() {
            continue;
        }
        messages.push(OrchestrationChildTranscriptMessage {
            id: message.id().to_owned(),
            role: transcript_role(message),
            text,
            created_at: message.created_at().to_owned(),
        });
    }
    messages.reverse();
    messages
}

fn labelled(label: &str, detail: Option<&str>) -> String {
    match detail.filter(|detail| !detail.is_empty()) {
        Some(detail) => format!("{label}: {detail}"),
        None => label.to_owned(),
    }
}

/// `transcriptText`.
fn transcript_text(message: &TranscriptMessage) -> String {
    match message {
        TranscriptMessage::Message(message) => message.text.clone(),
        TranscriptMessage::Custom(custom) => format!("[{}] {}", custom.custom_type, custom.text),
        TranscriptMessage::Card(card) => labelled(&card.card.title, card.card.subtitle.as_deref()),
        TranscriptMessage::Activity(activity) => {
            labelled(&activity.label, activity.detail.as_deref())
        }
        TranscriptMessage::Tool(tool) => labelled(&tool.label, tool.detail.as_deref()),
        TranscriptMessage::Summary(summary) => {
            labelled(&summary.label, summary.metadata.as_deref())
        }
        // A pin is extension state above the composer, not something the thread said.
        TranscriptMessage::Pin(_) => String::new(),
    }
}

fn transcript_role(message: &TranscriptMessage) -> OrchestrationChildTranscriptRole {
    match message {
        TranscriptMessage::Message(message) => match message.role {
            SessionTranscriptRole::User => OrchestrationChildTranscriptRole::Parent,
            SessionTranscriptRole::Assistant => OrchestrationChildTranscriptRole::Child,
            _ => OrchestrationChildTranscriptRole::System,
        },
        _ => OrchestrationChildTranscriptRole::System,
    }
}

// ---- Evidence ----

/// `evidenceId`.
pub fn evidence_id(prefix: &str, source_id: &str) -> String {
    format!("{prefix}:{source_id}")
}

/// An evidence record with only the required fields set.
pub fn evidence(
    id: String,
    child: &OrchestrationChildThread,
    (kind, source, status): (Kind, Source, EvidenceStatus),
    title: &str,
    created_at: &str,
) -> Evidence {
    Evidence {
        id,
        child_thread_id: child.id.clone(),
        kind,
        source,
        status,
        title: title.to_owned(),
        detail: None,
        command: None,
        tool_name: None,
        severity: None,
        parent_session_id: Some(child.parent_session_id.clone()),
        child_session_id: Some(child.child_session_id.clone()),
        git: None,
        created_at: created_at.to_owned(),
        updated_at: None,
    }
}

/// `mergeEvidenceRecords`: a derived record replaces the fields it has of the saved one with
/// the same id; newest first, capped.
pub fn merge_evidence_records(existing: &[Evidence], derived: Vec<Evidence>) -> Vec<Evidence> {
    let mut records: IndexMap<String, Evidence> = existing
        .iter()
        .map(|record| (record.id.clone(), record.clone()))
        .collect();
    for record in derived {
        let merged = match records.get(&record.id) {
            Some(previous) => Evidence {
                detail: record.detail.or_else(|| previous.detail.clone()),
                command: record.command.or_else(|| previous.command.clone()),
                tool_name: record.tool_name.or_else(|| previous.tool_name.clone()),
                severity: record.severity.or(previous.severity),
                parent_session_id: record
                    .parent_session_id
                    .or_else(|| previous.parent_session_id.clone()),
                child_session_id: record
                    .child_session_id
                    .or_else(|| previous.child_session_id.clone()),
                git: record.git.or_else(|| previous.git.clone()),
                updated_at: record.updated_at.or_else(|| previous.updated_at.clone()),
                ..record
            },
            None => record,
        };
        records.insert(merged.id.clone(), merged);
    }
    let mut sorted: Vec<Evidence> = records.into_values().collect();
    sorted.sort_by(|left, right| crate::locale::compare(&right.created_at, &left.created_at));
    cap_evidence_records(sorted)
}

/// `capEvidenceRecords`: blocked, failed and accepted records are kept first.
pub fn cap_evidence_records(records: Vec<Evidence>) -> Vec<Evidence> {
    if records.len() <= MAX_EVIDENCE_RECORDS_PER_CHILD {
        return records;
    }
    let (priority, remaining): (Vec<Evidence>, Vec<Evidence>) =
        records.into_iter().partition(|record| {
            matches!(
                record.status,
                EvidenceStatus::Blocked | EvidenceStatus::Failed
            ) || record.source == Source::OrchestratorAccepted
        });
    priority
        .into_iter()
        .chain(remaining)
        .take(MAX_EVIDENCE_RECORDS_PER_CHILD)
        .collect()
}

/// `parentEvidenceIndex`: what each parent's transcript says about its children, by child id.
fn parent_evidence_index(
    data: &AppData,
    children: &[OrchestrationChildThread],
) -> HashMap<String, Vec<Evidence>> {
    let child_by_id: HashMap<&str, &OrchestrationChildThread> = children
        .iter()
        .map(|child| (child.id.as_str(), child))
        .collect();
    let mut parent_keys: Vec<String> = Vec::new();
    for child in children {
        let key = session_key(&session_ref(
            &child.parent_workspace_id,
            &child.parent_session_id,
        ));
        if !parent_keys.contains(&key) {
            parent_keys.push(key);
        }
    }
    let mut index: HashMap<String, Vec<Evidence>> = HashMap::new();
    for key in parent_keys {
        let transcript = data
            .sessions
            .transcript_cache
            .get(&key)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for record in evidence_from_parent_transcript(&child_by_id, transcript) {
            index
                .entry(record.child_thread_id.clone())
                .or_default()
                .push(record);
        }
    }
    index
}

/// `evidenceFromChildTranscript`.
fn evidence_from_child_transcript(
    child: &OrchestrationChildThread,
    transcript: &[TranscriptMessage],
) -> Vec<Evidence> {
    let mut records = Vec::new();
    for message in transcript {
        match message {
            TranscriptMessage::Tool(tool) => records.push(command_evidence_from_tool(child, tool)),
            TranscriptMessage::Message(message)
                if message.role == SessionTranscriptRole::Assistant =>
            {
                let text = js::trim(&message.text);
                if text.is_empty() {
                    continue;
                }
                let severity = severity_from_text(text);
                let is_blocker = looks_like_blocker(text);
                let (kind, status) = if is_blocker {
                    (Kind::Blocker, EvidenceStatus::Blocked)
                } else if severity.is_some() {
                    (Kind::ReviewFinding, EvidenceStatus::Reported)
                } else {
                    (Kind::WorkerReport, EvidenceStatus::Reported)
                };
                let title = if is_blocker {
                    "Worker reported blocker".to_owned()
                } else if let Some(severity) = severity {
                    format!("{} review finding", severity_name(severity))
                } else {
                    "Worker reported output".to_owned()
                };
                let mut record = evidence(
                    evidence_id("worker", &message.id),
                    child,
                    (kind, Source::WorkerReported, status),
                    &title,
                    &message.created_at,
                );
                record.detail = Some(truncate_evidence_detail(text));
                record.severity = severity;
                records.push(record);
            }
            _ => {}
        }
    }
    records
}

fn severity_name(severity: EvidenceSeverity) -> &'static str {
    match severity {
        EvidenceSeverity::P0 => "P0",
        EvidenceSeverity::P1 => "P1",
        EvidenceSeverity::P2 => "P2",
        EvidenceSeverity::P3 => "P3",
    }
}

/// `commandEvidenceFromTool`.
fn command_evidence_from_tool(
    child: &OrchestrationChildThread,
    tool: &TimelineToolCall,
) -> Evidence {
    let command = command_from_tool_input(tool.input.as_ref());
    let status = match tool.status {
        TimelineToolStatus::Running => EvidenceStatus::Running,
        TimelineToolStatus::Error => EvidenceStatus::Failed,
        TimelineToolStatus::Success => EvidenceStatus::Passed,
    };
    let title = if command.as_deref().is_some_and(looks_like_test_command) {
        "Test command run"
    } else {
        "Command or tool run"
    };
    let mut record = evidence(
        evidence_id("command", &tool.call_id),
        child,
        (Kind::Command, Source::Command, status),
        title,
        &tool.created_at,
    );
    record.detail = Some(
        match tool.detail.as_deref().filter(|detail| !detail.is_empty()) {
            Some(detail) => truncate_evidence_detail(detail),
            None => tool.label.clone(),
        },
    );
    record.command = command;
    record.tool_name = Some(tool.tool_name.clone());
    record
}

/// `textFromToolOutput`: the output's text parts, one per line.
pub fn text_from_tool_output(output: &Value) -> String {
    output["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            (item["type"] == "text")
                .then(|| item["text"].as_str())
                .flatten()
                .filter(|text| !text.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `evidenceFromParentTranscript`.
fn evidence_from_parent_transcript(
    child_by_id: &HashMap<&str, &OrchestrationChildThread>,
    transcript: &[TranscriptMessage],
) -> Vec<Evidence> {
    let mut records = Vec::new();
    for message in transcript {
        let tool = match message {
            TranscriptMessage::Message(message)
                if message.role == SessionTranscriptRole::Assistant =>
            {
                records.extend(explicit_acceptance_evidence(
                    child_by_id,
                    &message.id,
                    &message.text,
                    &message.created_at,
                ));
                continue;
            }
            TranscriptMessage::Tool(tool) if tool.status == TimelineToolStatus::Success => tool,
            _ => continue,
        };
        let Some(output) = tool.output.as_ref().filter(|output| output.is_object()) else {
            continue;
        };
        let Some(details) = output.get("details").filter(|details| details.is_object()) else {
            continue;
        };
        let child_id = details["childThreadId"]
            .as_str()
            .or_else(|| details["threadId"].as_str());
        let Some(child) = child_id.and_then(|id| child_by_id.get(id)) else {
            continue;
        };
        let action = details["action"].as_str();
        if action == Some(READ_THREAD_ACTION) && details["childThreadId"] == child.id.as_str() {
            let mut record = evidence(
                evidence_id("observed-read", &tool.call_id),
                child,
                (
                    Kind::OrchestratorObservation,
                    Source::OrchestratorObserved,
                    EvidenceStatus::Reported,
                ),
                "Orchestrator read child output",
                &tool.created_at,
            );
            record.detail = Some(truncate_evidence_detail(&text_from_tool_output(output)));
            records.push(record);
        } else if action == Some(SEND_MESSAGE_TO_THREAD_ACTION)
            && details["threadId"] == child.id.as_str()
        {
            let mut record = evidence(
                evidence_id("follow-up", &tool.call_id),
                child,
                (
                    Kind::OrchestratorAction,
                    Source::OrchestratorAction,
                    EvidenceStatus::Reported,
                ),
                "Orchestrator sent follow-up",
                &tool.created_at,
            );
            record.detail = details["message"].as_str().map(truncate_evidence_detail);
            records.push(record);
        }
    }
    records
}

/// `explicitAcceptanceEvidenceFromParentMessage`: lines like
/// `orchestrator-accepted: <child id> <note>`.
fn explicit_acceptance_evidence(
    child_by_id: &HashMap<&str, &OrchestrationChildThread>,
    message_id: &str,
    text: &str,
    created_at: &str,
) -> Vec<Evidence> {
    let mut records = Vec::new();
    for line in text.split('\n') {
        let Some((child_id, note)) = parse_acceptance_line(js::trim(line)) else {
            continue;
        };
        let Some(child) = child_by_id.get(child_id) else {
            continue;
        };
        let mut record = evidence(
            evidence_id("accepted", &format!("{message_id}:{}", child.id)),
            child,
            (
                Kind::OrchestratorAcceptance,
                Source::OrchestratorAccepted,
                EvidenceStatus::Accepted,
            ),
            "Orchestrator accepted child evidence",
            created_at,
        );
        record.detail = Some(truncate_evidence_detail(if note.is_empty() {
            text
        } else {
            note
        }));
        records.push(record);
    }
    records
}

/// `/^orchestrator-accepted:\s*(\S+)\s*(.*)$/i`.
fn parse_acceptance_line(line: &str) -> Option<(&str, &str)> {
    const PREFIX: &str = "orchestrator-accepted:";
    let head = line.get(..PREFIX.len())?;
    if !head.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let rest = line[PREFIX.len()..].trim_start_matches(js::is_space);
    let id_end = rest.find(js::is_space).unwrap_or(rest.len());
    let (id, rest) = rest.split_at(id_end);
    let note = rest.trim_start_matches(js::is_space);
    // `.` stops at line breaks, so a note holding one does not match.
    if id.is_empty() || note.contains(['\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((id, note))
}

/// `blockerEvidenceFromChildStatus`.
fn blocker_evidence_from_child_status(
    child: &OrchestrationChildThread,
    status: ChildStatus,
    updated_at: &str,
) -> Option<Evidence> {
    if status != ChildStatus::Failed {
        return None;
    }
    let mut record = evidence(
        evidence_id("blocker-status", &child.id),
        child,
        (Kind::Blocker, Source::Blocker, EvidenceStatus::Blocked),
        "Child thread failed",
        updated_at,
    );
    record.detail = Some(child.latest_transcript.clone());
    Some(record)
}

/// `commandFromToolInput`.
fn command_from_tool_input(input: Option<&Value>) -> Option<String> {
    let input = input?.as_object()?;
    ["cmd", "command", "script"].iter().find_map(|key| {
        input
            .get(*key)
            .and_then(Value::as_str)
            .map(js::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

/// `/\b(test|spec|typecheck|build|playwright|vitest|jest|tsc)\b/i`: one of these is a whole
/// word.
fn looks_like_test_command(command: &str) -> bool {
    const WORDS: [&str; 8] = [
        "test",
        "spec",
        "typecheck",
        "build",
        "playwright",
        "vitest",
        "jest",
        "tsc",
    ];
    command
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|word| WORDS.iter().any(|known| word.eq_ignore_ascii_case(known)))
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

fn then_colon(rest: &str) -> bool {
    rest.trim_start_matches(js::is_space).starts_with(':')
}

/// `/^\s*(?:\[?BLOCKER\]?|blocked)\s*:/i`.
fn looks_like_blocker(text: &str) -> bool {
    let text = text.trim_start_matches(js::is_space);
    let blocker = strip_prefix_ignore_case(text.strip_prefix('[').unwrap_or(text), "blocker")
        .is_some_and(|rest| then_colon(rest.strip_prefix(']').unwrap_or(rest)));
    blocker || strip_prefix_ignore_case(text, "blocked").is_some_and(then_colon)
}

/// `/^\s*\[?(P[0-3])\]?\s*:/`.
fn severity_from_text(text: &str) -> Option<EvidenceSeverity> {
    let text = text.trim_start_matches(js::is_space);
    let text = text.strip_prefix('[').unwrap_or(text);
    let rest = text.strip_prefix('P')?;
    let severity = match rest.chars().next()? {
        '0' => EvidenceSeverity::P0,
        '1' => EvidenceSeverity::P1,
        '2' => EvidenceSeverity::P2,
        '3' => EvidenceSeverity::P3,
        _ => return None,
    };
    let rest = &rest[1..];
    then_colon(rest.strip_prefix(']').unwrap_or(rest)).then_some(severity)
}

/// `truncateEvidenceDetail`: one line, at most 260 characters.
pub fn truncate_evidence_detail(text: &str) -> String {
    let normalized = js::trim(&js::collapse_whitespace(text)).to_owned();
    if js::length(&normalized) > EVIDENCE_DETAIL_LIMIT {
        format!(
            "{}...",
            js::utf16_prefix(&normalized, EVIDENCE_DETAIL_LIMIT - 3)
        )
    } else {
        normalized
    }
}

// ---- Supervision loops ----

/// `supervisionIntervalMs`: `PI_APP_ORCHESTRATION_SUPERVISION_INTERVAL_MS`, at least 250 ms.
pub fn supervision_interval_ms() -> f64 {
    let configured = std::env::var("PI_APP_ORCHESTRATION_SUPERVISION_INTERVAL_MS")
        .ok()
        .map_or(f64::NAN, |value| js_number(&value));
    if !configured.is_finite() || configured <= 0.0 {
        return DEFAULT_SUPERVISION_INTERVAL_MS;
    }
    configured.floor().max(MIN_SUPERVISION_INTERVAL_MS)
}

/// `Number(text)` for the decimal forms an environment variable holds.
fn js_number(text: &str) -> f64 {
    let text = js::trim(text);
    if text.is_empty() {
        return 0.0;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// `nextIso`.
pub fn next_iso(env: &dyn StateEnv, from_iso: &str, interval_ms: f64) -> String {
    js::to_iso_string(env.date_parse(from_iso) + interval_ms).unwrap_or_default()
}

/// `monitoringReason`.
fn monitoring_reason(status: ChildStatus) -> String {
    match status {
        ChildStatus::Waiting => "Child has queued follow-up; waiting for the run to continue.",
        ChildStatus::Queued => "Child queued; waiting for the run to start.",
        _ => "Monitoring child thread.",
    }
    .to_owned()
}

/// `createSupervisionLoop`.
pub fn create_supervision_loop(
    env: &dyn StateEnv,
    status: ChildStatus,
    now_iso: &str,
) -> OrchestrationSupervisionLoop {
    let interval_ms = supervision_interval_ms();
    OrchestrationSupervisionLoop {
        id: env.random_uuid(),
        status: LoopStatus::Monitoring,
        gate: Gate::Continue,
        interval_ms: js::JsNumber(interval_ms),
        iteration_count: js::JsNumber(0.0),
        last_checked_at: now_iso.to_owned(),
        next_run_at: Some(next_iso(env, now_iso, interval_ms)),
        reason: monitoring_reason(status),
        last_child_status: status,
        stopped_at: None,
    }
}

/// `projectSupervisionLoop`: a finished child wakes its parent; a running one is monitored.
pub fn project_supervision_loop(
    env: &dyn StateEnv,
    current: Option<&OrchestrationSupervisionLoop>,
    status: ChildStatus,
    now_iso: &str,
) -> OrchestrationSupervisionLoop {
    let Some(current) = current else {
        return create_supervision_loop(env, status, now_iso);
    };
    if current.status == LoopStatus::Stopped || current.gate == Gate::Stop {
        return current.clone();
    }
    if matches!(status, ChildStatus::Complete | ChildStatus::Failed) {
        if current.gate == Gate::Wake && current.last_child_status == status {
            return current.clone();
        }
        return OrchestrationSupervisionLoop {
            status: LoopStatus::Attention,
            gate: Gate::Wake,
            last_checked_at: now_iso.to_owned(),
            next_run_at: None,
            reason: if status == ChildStatus::Failed {
                "Child failed; parent review is needed."
            } else {
                "Child completed; parent review is ready."
            }
            .to_owned(),
            last_child_status: status,
            ..current.clone()
        };
    }
    if current.gate != Gate::Continue
        || current.status != LoopStatus::Monitoring
        || current.last_child_status != status
    {
        return OrchestrationSupervisionLoop {
            status: LoopStatus::Monitoring,
            gate: Gate::Continue,
            last_checked_at: now_iso.to_owned(),
            next_run_at: Some(
                current
                    .next_run_at
                    .clone()
                    .unwrap_or_else(|| next_iso(env, now_iso, current.interval_ms.0)),
            ),
            reason: monitoring_reason(status),
            last_child_status: status,
            ..current.clone()
        };
    }
    current.clone()
}

/// `advanceSupervisionLoop`: one supervision check done.
fn advance_supervision_loop(
    env: &dyn StateEnv,
    current: &OrchestrationSupervisionLoop,
    status: ChildStatus,
    now_iso: &str,
) -> OrchestrationSupervisionLoop {
    let projected = project_supervision_loop(env, Some(current), status, now_iso);
    let iteration_count = js::JsNumber(current.iteration_count.0 + 1.0);
    if projected.gate == Gate::Wake || projected.status == LoopStatus::Stopped {
        return OrchestrationSupervisionLoop {
            iteration_count,
            ..projected
        };
    }
    OrchestrationSupervisionLoop {
        iteration_count,
        last_checked_at: now_iso.to_owned(),
        next_run_at: Some(next_iso(env, now_iso, projected.interval_ms.0)),
        reason: monitoring_reason(status),
        last_child_status: status,
        ..projected
    }
}

/// `supervisionPublishKey`: what a supervision check must change to be worth publishing.
fn supervision_publish_key(child: &OrchestrationChildThread) -> impl PartialEq {
    let current = child.supervision_loop.as_ref();
    (
        child.id.clone(),
        child.status,
        current.map(|current| current.status),
        current.map(|current| current.gate),
        current.map(|current| current.reason.clone()),
        current.map(|current| current.last_child_status),
        current.and_then(|current| current.stopped_at.clone()),
    )
}

/// `reconcileDueSupervisionLoops`: projects every child and advances the loops that are due.
/// Answers the children and whether anything worth publishing changed.
pub fn reconcile_due_supervision_loops(
    data: &AppData,
    env: &dyn StateEnv,
) -> (Vec<OrchestrationChildThread>, bool) {
    let now_ms = env.now_ms();
    let now_iso = env.now_iso();
    let current = &data.state.orchestration_children;
    let parent_evidence = parent_evidence_index(data, current);
    let mut changed = false;
    let children = current
        .iter()
        .map(|child| {
            let before = supervision_publish_key(child);
            let projected = project_child(
                data,
                env,
                child,
                &now_iso,
                parent_evidence
                    .get(&child.id)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
            );
            if supervision_publish_key(&projected) != before {
                changed = true;
            }
            if projected.child_session_id.is_empty()
                || projected
                    .supervision_loop
                    .as_ref()
                    .is_some_and(|current| current.status == LoopStatus::Stopped)
            {
                return projected;
            }
            let current = project_supervision_loop(
                env,
                projected.supervision_loop.as_ref(),
                projected.status,
                &now_iso,
            );
            let due = current
                .next_run_at
                .as_deref()
                .filter(|at| !at.is_empty())
                .is_some_and(|at| {
                    env.date_parse(at).partial_cmp(&now_ms) != Some(std::cmp::Ordering::Greater)
                });
            if !due {
                return OrchestrationChildThread {
                    supervision_loop: Some(current),
                    ..projected
                };
            }
            let advanced = OrchestrationChildThread {
                supervision_loop: Some(advance_supervision_loop(
                    env,
                    &current,
                    projected.status,
                    &now_iso,
                )),
                ..projected
            };
            if supervision_publish_key(&advanced) != before {
                changed = true;
            }
            advanced
        })
        .collect();
    (children, changed)
}

/// `nextSupervisionRunAt`: the earliest next check of a loop that is not stopped.
pub fn next_supervision_run_at(
    env: &dyn StateEnv,
    children: &[OrchestrationChildThread],
) -> Option<String> {
    children
        .iter()
        .filter_map(|child| child.supervision_loop.as_ref())
        .filter(|current| current.status != LoopStatus::Stopped)
        .filter_map(|current| current.next_run_at.as_deref())
        .filter(|at| !at.is_empty() && env.date_parse(at).is_finite())
        .min_by(|left, right| js::compare_strings(left, right))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_text_patterns_match_the_typescript_ones() {
        assert!(looks_like_blocker("BLOCKER: no access"));
        assert!(looks_like_blocker("  [blocker] : waiting"));
        assert!(looks_like_blocker("Blocked: tests"));
        assert!(!looks_like_blocker("blocking: x"));
        assert!(!looks_like_blocker("[blocked]: x"));
        assert_eq!(severity_from_text("[P1]: bad"), Some(EvidenceSeverity::P1));
        assert_eq!(severity_from_text("P3 : nit"), Some(EvidenceSeverity::P3));
        assert_eq!(severity_from_text("p1: lower"), None);
        assert_eq!(severity_from_text("P4: no"), None);
        assert!(looks_like_test_command("pnpm test"));
        assert!(looks_like_test_command("npx TSC --noEmit"));
        assert!(!looks_like_test_command("cargo testing"));
        assert!(!looks_like_test_command("my_test"));
        assert_eq!(
            parse_acceptance_line("Orchestrator-Accepted:  child-1   looks good"),
            Some(("child-1", "looks good"))
        );
        assert_eq!(parse_acceptance_line("orchestrator-accepted: "), None);
    }

    #[test]
    fn long_evidence_details_are_cut_to_one_line() {
        assert_eq!(truncate_evidence_detail("  a\n\tb  "), "a b");
        let long = "x".repeat(300);
        let cut = truncate_evidence_detail(&long);
        assert_eq!(cut.len(), 260);
        assert!(cut.ends_with("..."));
    }
}
