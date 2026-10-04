//! Golden parity tests for the app-state twins in `src/state`. The fixtures under
//! `tests/fixtures/state` hold inputs and what the TypeScript functions made of them, written
//! by `apps/desktop/tests/unit/rust-state-fixtures.spec.ts` (rewrite them with
//! `pnpm --filter @pi-gui/desktop run fixtures:rust-state`). Each test replays the inputs here
//! and must produce the same JSON: keys sorted, generated UUIDs numbered by first appearance.

use std::collections::HashSet;
use std::path::PathBuf;

use indexmap::IndexMap;
use pi_gui_core::persistence::catalog::{SessionEntry, WorkspaceEntry, WorktreeEntry};
use pi_gui_core::state::app_store_utils::{
    build_workspace_records, build_worktree_records, clone_composer_attachments,
    format_elapsed_duration, has_unseen_session_update, merge_queued_composer_messages,
    preview_from_transcript, to_session_queued_messages, to_transcript_attachments,
    SessionRecordSources,
};
use pi_gui_core::state::desktop_state::{
    ComposerAttachment, DesktopAppState, ExtensionCommandCompatibilityRecord,
    QueuedComposerMessage, ScheduledTaskSchedule, SelectedTranscriptRecord, SessionRecord,
};
use pi_gui_core::state::driver::{
    session_key, RuntimeCommandRecord, RuntimeSnapshot, SessionDriverEvent, SessionEventKind,
    SessionQueuedMessage, SessionRef, SessionStatus, SessionTranscriptItem,
};
use pi_gui_core::state::env::{FixedEnv, StateEnv};
use pi_gui_core::state::extension_command_compatibility::{
    get_learned_command_compatibility, prune_compatibility_for_runtime_snapshot,
    record_learned_command_compatibility, restore_compatibility_by_workspace,
    serialize_compatibility_by_workspace,
};
use pi_gui_core::state::js::{self, json_stringify};
use pi_gui_core::state::scheduled_task_schedule::{
    earliest_scheduled_wake_at, next_run_at, ScheduledWake,
};
use pi_gui_core::state::session_state::{
    apply_session_event_state, update_session_record, SessionRecordUpdate, SnapshotFields,
};
use pi_gui_core::state::session_state_map::{
    apply_host_ui_request_to_extension_ui_state, create_empty_extension_ui_state,
    serialize_extension_ui_state, MutableSessionExtensionUiState, PendingAutoTitle,
    SessionStateMap,
};
use pi_gui_core::state::timeline::{
    append_assistant_delta, append_user_message, apply_timeline_event,
    timeline_from_driver_transcript, RunMetrics, TimelineRuntimeState, TranscriptCache,
};
use pi_gui_core::state::timeline_types::TranscriptMessage;
use pi_gui_core::state::tool_labels::{
    extension_tool_labels, extension_tool_row_label, tool_input_summary, truncate, truncate_default,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/state")
        .join(name);
    let text = std::fs::read_to_string(&path).expect("fixture exists");
    serde_json::from_str(&text).expect("fixture is JSON")
}

fn parse<T: DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{error}: {value}"))
}

/// Keys sorted as JavaScript's default sort does (by UTF-16 code units).
fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| js::js_string_cmp(left, right));
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&map[key])))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// The fixture writer's `normalize`: canonical JSON text with UUIDs numbered in order.
fn normalize(value: &Value) -> Value {
    let text = json_stringify(&canonical(value));
    let mut ids: IndexMap<String, String> = IndexMap::new();
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while !rest.is_empty() {
        if let Some(id) = rest.get(..36).filter(|candidate| is_uuid(candidate)) {
            let count = ids.len();
            let name = ids
                .entry(id.to_string())
                .or_insert_with(|| format!("uuid-{}", count + 1));
            out.push_str(name);
            rest = &rest[36..];
        } else {
            let next = rest.chars().next().expect("not empty");
            out.push(next);
            rest = &rest[next.len_utf8()..];
        }
    }
    serde_json::from_str(&out).expect("normalized text is JSON")
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn assert_same(actual: &Value, expected: &Value, context: &str) {
    let actual = normalize(actual);
    if &actual != expected {
        panic!(
            "{context}: Rust and TypeScript differ\n--- Rust\n{}\n--- TypeScript\n{}",
            serde_json::to_string_pretty(&actual).unwrap_or_default(),
            serde_json::to_string_pretty(expected).unwrap_or_default()
        );
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serializes")
}

/// Reads `value` as `T` and writes it back; the JSON must not change.
fn assert_round_trip<T: serde::Serialize + DeserializeOwned>(value: &Value, context: &str) -> T {
    let parsed: T = parse(value);
    let written = to_json(&parsed);
    if canonical(&written) != canonical(value) {
        panic!(
            "{context}: round trip changed the JSON\n--- written\n{}\n--- read\n{}",
            serde_json::to_string_pretty(&canonical(&written)).unwrap_or_default(),
            serde_json::to_string_pretty(&canonical(value)).unwrap_or_default()
        );
    }
    parsed
}

// ---- Event streams ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioInput {
    name: String,
    initial_state: Value,
    runtime_by_workspace: IndexMap<String, RuntimeSnapshot>,
    last_viewed_at_by_session: IndexMap<String, String>,
    steps: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Step {
    Event {
        now: String,
        event: Value,
    },
    UserMessage {
        now: String,
        session_ref: SessionRef,
        text: String,
        #[serde(default)]
        attachments: Vec<ComposerAttachment>,
    },
    LoadTranscript {
        now: String,
        session_ref: SessionRef,
        items: Vec<SessionTranscriptItem>,
    },
}

fn record<V: serde::Serialize>(map: &IndexMap<String, V>) -> Value {
    to_json(map)
}

#[test]
fn event_streams_build_the_same_transcripts_and_state() {
    let fixtures = fixture("event-streams.json");
    for fixture in fixtures.as_array().expect("a list of streams") {
        let input: ScenarioInput = parse(&fixture["input"]);
        let name = input.name.as_str();
        let mut state: DesktopAppState =
            assert_round_trip(&input.initial_state, &format!("{name}: initial state"));
        let env = FixedEnv::new("2026-01-01T00:00:00.000Z");
        let mut transcript_cache = TranscriptCache::new();
        let mut run_metrics: IndexMap<String, RunMetrics> = IndexMap::new();
        let mut running_since: IndexMap<String, String> = IndexMap::new();
        let mut active_assistant: IndexMap<String, String> = IndexMap::new();
        let mut pending_assistant: IndexMap<String, String> = IndexMap::new();
        let mut active_working: IndexMap<String, String> = IndexMap::new();
        let mut extension_ui: IndexMap<String, MutableSessionExtensionUiState> = IndexMap::new();
        let runtime_by_workspace = &input.runtime_by_workspace;
        let labels = |session_ref: &SessionRef| {
            extension_tool_labels(runtime_by_workspace.get(&session_ref.workspace_id))
        };
        let mut steps = Vec::new();

        for (index, raw) in input.steps.iter().enumerate() {
            let context = format!("{name}: step {index}");
            let step: Step = parse(raw);
            let mut returned = None;
            let session_ref = match step {
                Step::UserMessage {
                    now,
                    session_ref,
                    text,
                    attachments,
                } => {
                    env.set_now(&now);
                    returned = Some(append_user_message(
                        &env,
                        &mut transcript_cache,
                        &session_ref,
                        &text,
                        &to_transcript_attachments(&attachments),
                    ));
                    session_ref
                }
                Step::LoadTranscript {
                    now,
                    session_ref,
                    items,
                } => {
                    env.set_now(&now);
                    let transcript =
                        timeline_from_driver_transcript(&env, items, &labels(&session_ref));
                    transcript_cache.insert(session_key(&session_ref), transcript);
                    session_ref
                }
                Step::Event { now, event } => {
                    env.set_now(&now);
                    let event: SessionDriverEvent =
                        assert_round_trip(&event, &format!("{context}: event"));
                    let key = session_key(&event.session_ref);
                    match &event.kind {
                        SessionEventKind::AssistantDelta { text } => append_assistant_delta(
                            &env,
                            &mut transcript_cache,
                            &mut active_assistant,
                            &event.session_ref,
                            text,
                        ),
                        SessionEventKind::HostUiRequest { request } => {
                            let ui = extension_ui
                                .entry(key)
                                .or_insert_with(|| create_empty_extension_ui_state(&env));
                            apply_host_ui_request_to_extension_ui_state(ui, request);
                        }
                        _ => {}
                    }
                    apply_timeline_event(
                        &env,
                        &mut transcript_cache,
                        &event,
                        &mut TimelineRuntimeState {
                            run_metrics_by_session: &mut run_metrics,
                            running_since_by_session: &mut running_since,
                            active_assistant_message_by_session: &mut active_assistant,
                            pending_assistant_message_by_session: &mut pending_assistant,
                            active_working_activity_by_session: &mut active_working,
                            extension_tool_labels: &labels,
                        },
                    );
                    apply_session_event_state(
                        &mut state,
                        &event,
                        &transcript_cache,
                        &running_since,
                        &input.last_viewed_at_by_session,
                    );
                    event.session_ref
                }
            };
            let key = session_key(&session_ref);
            let session = state
                .workspaces
                .iter()
                .find(|workspace| workspace.id == session_ref.workspace_id)
                .and_then(|workspace| {
                    workspace
                        .sessions
                        .iter()
                        .find(|session| session.id == session_ref.session_id)
                });
            let mut output = Map::new();
            if let Some(returned) = returned {
                output.insert("returned".into(), Value::String(returned));
            }
            output.insert(
                "transcript".into(),
                transcript_cache
                    .get(&key)
                    .map(to_json)
                    .unwrap_or(Value::Null),
            );
            output.insert(
                "transcriptKeys".into(),
                to_json(&transcript_cache.keys().collect::<Vec<_>>()),
            );
            output.insert(
                "timeline".into(),
                json!({
                    "runMetricsBySession": record(&run_metrics),
                    "runningSinceBySession": record(&running_since),
                    "activeAssistantMessageBySession": record(&active_assistant),
                    "pendingAssistantMessageBySession": record(&pending_assistant),
                    "activeWorkingActivityBySession": record(&active_working),
                }),
            );
            output.insert(
                "extensionUi".into(),
                extension_ui
                    .get(&key)
                    .map(|ui| to_json(&serialize_extension_ui_state(ui)))
                    .unwrap_or(Value::Null),
            );
            output.insert(
                "session".into(),
                session.map(to_json).unwrap_or(Value::Null),
            );
            output.insert("revision".into(), to_json(&state.revision));
            steps.push(Value::Object(output));
        }
        let actual = json!({ "steps": steps, "workspaces": to_json(&state.workspaces) });
        assert_same(&actual, &fixture["expected"], name);
    }
}

// ---- Single functions ----

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> T {
    parse(args.get(key).unwrap_or(&Value::Null))
}

fn opt<T: DeserializeOwned>(args: &Value, key: &str) -> Option<T> {
    args.get(key).filter(|value| !value.is_null()).map(parse)
}

fn session_map<V: DeserializeOwned>(args: &Value, key: &str) -> IndexMap<String, V> {
    opt(args, key).unwrap_or_default()
}

fn run_case(env: &FixedEnv, function: &str, args: &Value) -> Value {
    match function {
        "extensionToolLabels" => {
            let runtime: Option<RuntimeSnapshot> = opt(args, "runtime");
            let labels = extension_tool_labels(runtime.as_ref());
            to_json(&labels.into_iter().collect::<Vec<_>>())
        }
        "extensionToolRowLabel" => json!(extension_tool_row_label(
            &arg::<String>(args, "label"),
            args.get("input")
        )),
        "toolInputSummary" => to_json(&tool_input_summary(args.get("input"))),
        "truncate" => json!(match opt::<usize>(args, "limit") {
            Some(limit) => truncate(&arg::<String>(args, "value"), limit),
            None => truncate_default(&arg::<String>(args, "value")),
        }),
        "timelineFromDriverTranscript" => {
            let labels: Vec<(String, String)> = arg(args, "labels");
            to_json(&timeline_from_driver_transcript(
                env,
                arg(args, "items"),
                &labels.into_iter().collect(),
            ))
        }
        "buildWorkspaceRecords" => {
            let workspaces: Vec<WorkspaceEntry> = arg(args, "workspaces");
            let worktrees: Vec<WorktreeEntry> = arg(args, "worktrees");
            let sessions: Vec<SessionEntry> = arg(args, "sessions");
            to_json(&build_workspace_records(
                &workspaces,
                &worktrees,
                &sessions,
                &SessionRecordSources {
                    transcript_cache: &session_map(args, "transcriptCache"),
                    running_since_by_session: &session_map(args, "runningSinceBySession"),
                    session_config_by_session: &session_map(args, "sessionConfigBySession"),
                    last_viewed_at_by_session: &session_map(args, "lastViewedAtBySession"),
                    last_interacted_at_by_session: &session_map(args, "lastInteractedAtBySession"),
                    pinned_at_by_session: &session_map(args, "pinnedAtBySession"),
                },
            ))
        }
        "buildWorktreeRecords" => {
            let workspaces: Vec<WorkspaceEntry> = arg(args, "workspaces");
            let worktrees: Vec<WorktreeEntry> = arg(args, "worktrees");
            to_json(&build_worktree_records(&workspaces, &worktrees))
        }
        "hasUnseenSessionUpdate" => {
            let transcript: Vec<TranscriptMessage> = arg(args, "transcript");
            json!(has_unseen_session_update(
                arg::<SessionStatus>(args, "status"),
                &arg::<String>(args, "updatedAt"),
                opt::<String>(args, "lastViewedAt").as_deref(),
                &transcript,
            ))
        }
        "previewFromTranscript" => {
            let transcript: Vec<TranscriptMessage> = arg(args, "transcript");
            to_json(&preview_from_transcript(&transcript))
        }
        "formatElapsedDuration" => json!(format_elapsed_duration(
            env,
            &arg::<String>(args, "startedAt"),
            &arg::<String>(args, "endedAt"),
        )),
        "cloneComposerAttachments" => {
            let attachments: Vec<Value> = arg(args, "attachments");
            to_json(&clone_composer_attachments(&attachments))
        }
        "toSessionQueuedMessages" => {
            let messages: Vec<QueuedComposerMessage> = arg(args, "messages");
            to_json(&to_session_queued_messages(&messages))
        }
        "mergeQueuedComposerMessages" => {
            let previous: Option<Vec<QueuedComposerMessage>> = opt(args, "previous");
            let next: Option<Vec<SessionQueuedMessage>> = opt(args, "next");
            to_json(&merge_queued_composer_messages(
                env,
                previous.as_deref(),
                next.as_deref(),
            ))
        }
        "updateSessionRecord" => {
            let session: SessionRecord = arg(args, "session");
            let transcript: Vec<TranscriptMessage> = arg(args, "transcript");
            let snapshot = args.get("snapshot").map(|snapshot| SnapshotFields {
                title: opt(snapshot, "title"),
                updated_at: opt(snapshot, "updatedAt"),
                archived_at: opt(snapshot, "archivedAt"),
                preview: opt(snapshot, "preview"),
                status: opt(snapshot, "status"),
                config: opt(snapshot, "config"),
            });
            to_json(&update_session_record(
                &session,
                SessionRecordUpdate {
                    snapshot,
                    status: opt(args, "status"),
                    transcript: &transcript,
                    preview: opt(args, "preview"),
                    running_since: opt(args, "runningSince"),
                    last_viewed_at: opt(args, "lastViewedAt"),
                },
            ))
        }
        "extensionCommandCompatibility" => {
            let payload: Option<IndexMap<String, Vec<ExtensionCommandCompatibilityRecord>>> =
                opt(args, "payload");
            let mut restored = restore_compatibility_by_workspace(payload.as_ref());
            let after_restore = serialize_compatibility_by_workspace(&restored);
            let recorded = &args["record"];
            record_learned_command_compatibility(
                &mut restored,
                &arg::<String>(recorded, "workspaceId"),
                arg(recorded, "record"),
            );
            let after_record = serialize_compatibility_by_workspace(&restored);
            let lookup = &args["lookup"];
            let command: RuntimeCommandRecord = arg(lookup, "command");
            let learned = get_learned_command_compatibility(
                &restored,
                &arg::<String>(lookup, "workspaceId"),
                &command,
            )
            .cloned();
            let runtime: Option<RuntimeSnapshot> = opt(args, "runtime");
            prune_compatibility_for_runtime_snapshot(&mut restored, runtime.as_ref());
            json!({
                "afterRestore": to_json(&after_restore),
                "afterRecord": to_json(&after_record),
                "learned": to_json(&learned),
                "afterPrune": to_json(&serialize_compatibility_by_workspace(&restored)),
            })
        }
        "SessionStateMap.prune" => prune_case(args),
        "nextRunAt" => {
            let schedule: ScheduledTaskSchedule = arg(args, "schedule");
            let from = env.date_parse(&arg::<String>(args, "from"));
            match next_run_at(env, &schedule, from) {
                Ok(value) => json!({ "value": value }),
                Err(error) => json!({ "error": { "name": error.name, "message": error.message } }),
            }
        }
        "earliestScheduledWakeAt" => {
            let tasks: Vec<Value> = arg(args, "tasks");
            let wakes: Vec<ScheduledWake<'_>> = tasks
                .iter()
                .map(|task| ScheduledWake {
                    status: task["status"].as_str().unwrap_or_default(),
                    next_run_at: task.get("nextRunAt").and_then(Value::as_str),
                })
                .collect();
            let now = env.date_parse(&arg::<String>(args, "now"));
            to_json(&earliest_scheduled_wake_at(env, &wakes, now))
        }
        other => panic!("no Rust runner for {other}"),
    }
}

fn prune_case(args: &Value) -> Value {
    use std::cell::RefCell;
    use std::rc::Rc;

    let keys = &args["keys"];
    let list = |name: &str| -> Vec<String> { opt(keys, name).unwrap_or_default() };
    let log = Rc::new(RefCell::new(Vec::<String>::new()));
    let mut map = SessionStateMap::new();
    for key in list("transcriptCache") {
        map.transcript_cache.insert(key, Vec::new());
    }
    for key in list("composerDraftsBySession") {
        map.composer_drafts_by_session.insert(key, "draft".into());
    }
    for key in list("lastViewedAtBySession") {
        map.last_viewed_at_by_session.insert(key, String::new());
    }
    for key in list("pinnedAtBySession") {
        map.pinned_at_by_session.insert(key, String::new());
    }
    for key in list("extensionFlagsBySession") {
        map.extension_flags_by_session.insert(key, IndexMap::new());
    }
    for key in list("runningSinceBySession") {
        map.running_since_by_session.insert(key, String::new());
    }
    for key in list("sessionErrorsBySession") {
        map.session_errors_by_session.insert(key, "error".into());
    }
    for key in list("sessionSubscriptions") {
        let log = log.clone();
        let entry = format!("unsubscribe:{key}");
        map.session_subscriptions
            .insert(key, Box::new(move || log.borrow_mut().push(entry.clone())));
    }
    for key in list("pendingAutoTitleBySession") {
        let log = log.clone();
        let entry = format!("cancel:{key}");
        map.pending_auto_title_by_session.insert(
            key,
            PendingAutoTitle {
                request_token: "token".into(),
                cancel: Box::new(move || log.borrow_mut().push(entry.clone())),
            },
        );
    }
    for key in list("loadedTranscriptKeys") {
        map.loaded_transcript_keys.insert(key);
    }
    map.pinned_session_order = list("pinnedSessionOrder");
    let active: HashSet<String> = arg::<Vec<String>>(args, "activeKeys").into_iter().collect();
    let changed = map.prune(&active);
    let keys_of = |keys: Vec<&String>| to_json(&keys);
    let log = log.borrow().clone();
    json!({
        "changed": changed,
        "log": log,
        "remaining": {
            "transcriptCache": keys_of(map.transcript_cache.keys().collect()),
            "composerDraftsBySession": keys_of(map.composer_drafts_by_session.keys().collect()),
            "lastViewedAtBySession": keys_of(map.last_viewed_at_by_session.keys().collect()),
            "pinnedAtBySession": keys_of(map.pinned_at_by_session.keys().collect()),
            "extensionFlagsBySession": keys_of(map.extension_flags_by_session.keys().collect()),
            "runningSinceBySession": keys_of(map.running_since_by_session.keys().collect()),
            "sessionErrorsBySession": keys_of(map.session_errors_by_session.keys().collect()),
            "sessionSubscriptions": keys_of(map.session_subscriptions.keys().collect()),
            "pendingAutoTitleBySession": keys_of(map.pending_auto_title_by_session.keys().collect()),
            "loadedTranscriptKeys": keys_of(map.loaded_transcript_keys.iter().collect()),
            "pinnedSessionOrder": to_json(&map.pinned_session_order),
        },
    })
}

#[test]
fn single_functions_give_the_same_results() {
    let cases = fixture("functions.json");
    for (index, case) in cases
        .as_array()
        .expect("a list of cases")
        .iter()
        .enumerate()
    {
        let function = case["fn"].as_str().expect("a function name");
        let env = FixedEnv::new(
            case.get("now")
                .and_then(Value::as_str)
                .unwrap_or("2026-10-01T19:00:00.000Z"),
        );
        let actual = run_case(&env, function, &case["args"]);
        assert_same(
            &actual,
            &case["expected"],
            &format!("case {index} ({function})"),
        );
    }
}

// ---- Contracts ----

#[test]
fn renderer_contracts_read_and_write_unchanged() {
    let contracts = fixture("contracts.json");
    for (index, state) in contracts["desktopStates"]
        .as_array()
        .expect("states")
        .iter()
        .enumerate()
    {
        assert_round_trip::<DesktopAppState>(state, &format!("desktop state {index}"));
    }
    for (index, record) in contracts["selectedTranscripts"]
        .as_array()
        .expect("transcripts")
        .iter()
        .enumerate()
    {
        assert_round_trip::<SelectedTranscriptRecord>(record, &format!("transcript {index}"));
    }
    let empty = to_json(&pi_gui_core::state::desktop_state::create_empty_desktop_app_state());
    assert_eq!(canonical(&empty), canonical(&contracts["desktopStates"][0]));
}
