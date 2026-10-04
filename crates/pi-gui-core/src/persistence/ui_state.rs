//! `ui-state.json` (version 19): selection, drafts, pins, layouts and settings. Same checks,
//! messages and decoded shape as `decodePersistedUiState` in the old
//! `app-store-persistence.ts`; the app store still keeps the state in memory.

use super::backed_file::{read_json_with_backup, write_with_backup};
use super::{attachments, workbench_template};
use crate::error::{CoreError, CoreResult};
use crate::js;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const VERSION: i64 = 19;
const MAX_ORCHESTRATION_TRANSCRIPT_MESSAGES: usize = 40;
const MAX_ORCHESTRATION_EVIDENCE_RECORDS: usize = 80;

pub fn read(path: &Path) -> CoreResult<Value> {
    let result = read_json_with_backup(path)?;
    if result.corrupted && !result.recovered {
        return Err(CoreError::new(format!(
            "Invalid ui-state at {}; original data was retained. Repair or restore the file before continuing.",
            path.display()
        )));
    }
    if result.corrupted {
        // Reported rather than silently replaced: the next write would otherwise save over
        // the last good state.
        eprintln!(
            "[app-store] corrupt ui-state at {} — recovered from backup",
            path.display()
        );
    }
    match result.value {
        None => Ok(Value::Object(Map::new())),
        Some(value) => decode(&value),
    }
}

/// Saves `state` as version 19. Saved data from an older version is first copied, byte for
/// byte, to `ui-state.pre-workbench-v<version>.<uuid>.json`.
pub fn write(path: &Path, state: Map<String, Value>) -> CoreResult<()> {
    let mut payload = state;
    decode(&Value::Object(payload.clone()))?;
    payload.insert("version".into(), json!(VERSION));
    let contents = format!("{}\n", js::stringify_pretty(&Value::Object(payload)));
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = stem.strip_suffix(".json").unwrap_or(&stem).to_owned();
    write_with_backup(
        path,
        contents.as_bytes(),
        |existing| decode(&existing),
        move |existing: &Value| -> Option<PathBuf> {
            let version = existing.get("version").and_then(Value::as_i64);
            if version == Some(VERSION) {
                return None;
            }
            let version = version.map_or_else(|| "legacy".to_owned(), |v| v.to_string());
            Some(dir.join(format!(
                "{stem}.pre-workbench-v{version}.{}.json",
                uuid::Uuid::new_v4()
            )))
        },
    )
}

fn fail<T>(field: &str) -> CoreResult<T> {
    Err(CoreError::new(format!(
        "Invalid ui-state field {field}; original data was retained."
    )))
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn known_keys(record: &Map<String, Value>, keys: &[&str], path: &str) -> CoreResult<()> {
    for (key, _) in js::entries(record) {
        if !keys.contains(&key.as_str()) {
            return fail(&format!("{path}.{key} (unsupported field)"));
        }
    }
    Ok(())
}

fn optional(
    record: &Map<String, Value>,
    key: &str,
    valid: impl Fn(&Value) -> bool,
    path: &str,
) -> CoreResult<()> {
    match record.get(key) {
        Some(value) if !valid(value) => fail(path),
        _ => Ok(()),
    }
}

fn is_string(value: &Value) -> bool {
    value.is_string()
}

fn is_strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn is_string_record(value: &Value) -> bool {
    object(value).is_some_and(|map| map.values().all(Value::is_string))
}

const ROOT_KEYS: [&str; 30] = [
    "version",
    "taskWorkbenchTemplatesBySession",
    "selectedWorkspaceId",
    "selectedSessionId",
    "activeView",
    "composerDraft",
    "composerDraftsBySession",
    "extensionCommandCompatibilityByWorkspace",
    "extensionFlagsByWorkspace",
    "extensionFlagsBySession",
    "notificationPreferences",
    "disabledBuiltinExtensions",
    "integratedTerminalShell",
    "lastViewedAtBySession",
    "lastInteractedAtBySession",
    "pinnedAtBySession",
    "pinnedSessionOrder",
    "workspaceOrder",
    "modelSettingsScopeMode",
    "appGlobalModelSettings",
    "sidebarCollapsed",
    "threadGrouping",
    "collapsedWorkspaceIds",
    "allowMultiple",
    "enableTransparency",
    "themeMode",
    "themePresetId",
    "orchestrationChildren",
    "composerAttachmentsBySession",
    "transcripts",
];

const APP_VIEWS: [&str; 6] = [
    "threads",
    "new-thread",
    "scheduled",
    "skills",
    "extensions",
    "settings",
];
const THEME_PRESETS: [&str; 8] = [
    "default",
    "catppuccin",
    "tokyo-night",
    "nord",
    "dracula",
    "gruvbox",
    "github",
    "vscode",
];
const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ORCHESTRATION_STATUSES: [&str; 5] = ["queued", "waiting", "complete", "failed", "running"];

fn one_of(options: &'static [&'static str]) -> impl Fn(&Value) -> bool {
    move |value| value.as_str().is_some_and(|text| options.contains(&text))
}

/// The version as a whole number from 2 to 19.
fn persisted_version(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && (2.0..=19.0).contains(&number)).then_some(number as i64)
}

/// `validateUiState`: refuses anything this version cannot write back without losing data.
fn validate(value: &Value) -> CoreResult<&Map<String, Value>> {
    let Some(root) = object(value) else {
        return Err(CoreError::new(
            "Invalid ui-state: expected an object; original data was retained.",
        ));
    };
    known_keys(root, &ROOT_KEYS, "ui-state")?;
    optional(
        root,
        "version",
        |v| persisted_version(v).is_some(),
        "version",
    )?;
    if root.contains_key("taskWorkbenchTemplatesBySession")
        && root
            .get("version")
            .and_then(Value::as_f64)
            .is_some_and(|version| version < 18.0)
    {
        return fail("workbench templates before v18");
    }
    for key in [
        "selectedWorkspaceId",
        "selectedSessionId",
        "composerDraft",
        "integratedTerminalShell",
    ] {
        optional(root, key, is_string, key)?;
    }
    for key in [
        "composerDraftsBySession",
        "lastViewedAtBySession",
        "lastInteractedAtBySession",
        "pinnedAtBySession",
    ] {
        optional(root, key, is_string_record, key)?;
    }
    for key in [
        "pinnedSessionOrder",
        "workspaceOrder",
        "disabledBuiltinExtensions",
        "collapsedWorkspaceIds",
    ] {
        optional(root, key, is_strings, key)?;
    }
    for key in ["sidebarCollapsed", "allowMultiple", "enableTransparency"] {
        optional(root, key, Value::is_boolean, key)?;
    }
    optional(root, "activeView", one_of(&APP_VIEWS), "activeView")?;
    optional(
        root,
        "threadGrouping",
        one_of(&["time", "workspace"]),
        "threadGrouping",
    )?;
    optional(
        root,
        "themeMode",
        one_of(&["system", "light", "dark"]),
        "themeMode",
    )?;
    optional(
        root,
        "themePresetId",
        one_of(&THEME_PRESETS),
        "themePresetId",
    )?;
    optional(
        root,
        "modelSettingsScopeMode",
        one_of(&["per-repo", "app-global"]),
        "modelSettingsScopeMode",
    )?;
    if let Some(value) = root.get("notificationPreferences") {
        let keys = [
            "backgroundCompletion",
            "backgroundFailure",
            "attentionNeeded",
        ];
        let Some(preferences) = object(value) else {
            return fail("notificationPreferences");
        };
        known_keys(preferences, &keys, "notificationPreferences")?;
        for key in keys {
            optional(
                preferences,
                key,
                Value::is_boolean,
                &format!("notificationPreferences.{key}"),
            )?;
        }
    }
    if let Some(value) = root.get("appGlobalModelSettings") {
        let Some(settings) = object(value) else {
            return fail("appGlobalModelSettings");
        };
        known_keys(
            settings,
            &[
                "defaultProvider",
                "defaultModelId",
                "defaultThinkingLevel",
                "enabledModelPatterns",
            ],
            "appGlobalModelSettings",
        )?;
        for key in ["defaultProvider", "defaultModelId"] {
            optional(
                settings,
                key,
                is_string,
                &format!("appGlobalModelSettings.{key}"),
            )?;
        }
        optional(
            settings,
            "defaultThinkingLevel",
            one_of(&THINKING_LEVELS),
            "appGlobalModelSettings.defaultThinkingLevel",
        )?;
        optional(
            settings,
            "enabledModelPatterns",
            is_strings,
            "appGlobalModelSettings.enabledModelPatterns",
        )?;
    }
    for key in ["extensionFlagsByWorkspace", "extensionFlagsBySession"] {
        let Some(value) = root.get(key) else {
            continue;
        };
        let Some(records) = object(value) else {
            return fail(key);
        };
        for (id, flags) in js::entries(records) {
            let valid = object(flags).is_some_and(|values| {
                values.iter().all(|(name, value)| {
                    !name.is_empty() && (value.is_boolean() || value.is_string())
                })
            });
            if id.is_empty() || !valid {
                return fail(&format!("{key}.{id}"));
            }
        }
    }
    if let Some(value) = root.get("extensionCommandCompatibilityByWorkspace") {
        let Some(records) = object(value) else {
            return fail("extensionCommandCompatibilityByWorkspace");
        };
        for (key, entries) in js::entries(records) {
            let valid = entries.as_array().is_some_and(|items| {
                items
                    .iter()
                    .all(|entry| compatibility_record(entry).is_some())
            });
            if key.is_empty() || !valid {
                return fail(&format!("extensionCommandCompatibilityByWorkspace.{key}"));
            }
        }
        for (_, entries) in js::entries(records) {
            for entry in entries.as_array().into_iter().flatten() {
                known_keys(
                    object(entry).expect("checked above"),
                    &[
                        "commandName",
                        "extensionPath",
                        "status",
                        "message",
                        "capability",
                        "updatedAt",
                    ],
                    "extensionCommandCompatibilityByWorkspace",
                )?;
            }
        }
    }
    for key in ["composerAttachmentsBySession", "transcripts"] {
        let Some(value) = root.get(key) else {
            continue;
        };
        let Some(records) = object(value) else {
            return fail(key);
        };
        for (id, entries) in js::entries(records) {
            let valid = entries
                .as_array()
                .is_some_and(|items| items.iter().all(|entry| object(entry).is_some()));
            if id.is_empty() || !valid {
                return fail(&format!("{key}.{id}"));
            }
        }
        if key == "composerAttachmentsBySession" {
            for (_, entries) in js::entries(records) {
                attachments::decode(entries)?;
            }
        }
    }
    if let Some(value) = root.get("orchestrationChildren") {
        let Some(children) = value.as_array() else {
            return fail("orchestrationChildren");
        };
        for (index, child) in children.iter().enumerate() {
            validate_child(&format!("orchestrationChildren[{index}]"), child)?;
        }
    }
    Ok(root)
}

fn validate_child(path: &str, child: &Value) -> CoreResult<()> {
    let Some(record) = object(child) else {
        return fail(path);
    };
    known_keys(
        record,
        &[
            "id",
            "sourceToolCallId",
            "parentWorkspaceId",
            "parentSessionId",
            "childWorkspaceId",
            "childSessionId",
            "title",
            "goal",
            "status",
            "latestTranscript",
            "transcript",
            "evidence",
            "supervisionLoop",
            "createdAt",
            "updatedAt",
        ],
        path,
    )?;
    if orchestration_child(child).is_none() {
        return fail(path);
    }
    for key in [
        "id",
        "sourceToolCallId",
        "parentWorkspaceId",
        "parentSessionId",
        "childWorkspaceId",
        "childSessionId",
        "title",
        "goal",
        "latestTranscript",
        "createdAt",
        "updatedAt",
    ] {
        optional(record, key, is_string, &format!("{path}.{key}"))?;
    }
    optional(
        record,
        "status",
        one_of(&ORCHESTRATION_STATUSES),
        &format!("{path}.status"),
    )?;
    if let Some(transcript) = record.get("transcript") {
        let transcript_path = format!("{path}.transcript");
        let Some(messages) = transcript.as_array() else {
            return fail(&transcript_path);
        };
        for message in messages {
            let Some(m) = object(message) else {
                return fail(&transcript_path);
            };
            known_keys(m, &["id", "role", "text", "createdAt"], &transcript_path)?;
            let role_ok =
                one_of(&["parent", "child", "system"])(m.get("role").unwrap_or(&Value::Null));
            let strings_ok = ["id", "text", "createdAt"]
                .iter()
                .all(|key| m.get(*key).is_some_and(Value::is_string));
            if !role_ok || !strings_ok {
                return fail(&transcript_path);
            }
        }
    }
    if let Some(evidence) = record.get("evidence") {
        let evidence_path = format!("{path}.evidence");
        let Some(entries) = evidence.as_array() else {
            return fail(&evidence_path);
        };
        for entry in entries {
            if evidence_record(entry, "").is_none() {
                return fail(&evidence_path);
            }
            let Some(evidence) = object(entry) else {
                return fail(&evidence_path);
            };
            known_keys(
                evidence,
                &[
                    "id",
                    "childThreadId",
                    "kind",
                    "source",
                    "status",
                    "title",
                    "detail",
                    "command",
                    "toolName",
                    "severity",
                    "parentSessionId",
                    "childSessionId",
                    "git",
                    "createdAt",
                    "updatedAt",
                ],
                &evidence_path,
            )?;
            for key in [
                "detail",
                "command",
                "toolName",
                "parentSessionId",
                "childSessionId",
                "updatedAt",
            ] {
                optional(evidence, key, is_string, &format!("{evidence_path}.{key}"))?;
            }
            optional(
                evidence,
                "severity",
                one_of(&["P0", "P1", "P2", "P3"]),
                &format!("{evidence_path}.severity"),
            )?;
            if let Some(git) = evidence.get("git") {
                let git_path = format!("{evidence_path}.git");
                let Some(git) = object(git) else {
                    return fail(&git_path);
                };
                known_keys(git, &["workspaceId", "branchName", "headSha"], &git_path)?;
                if evidence_git(git).is_none() {
                    return fail(&git_path);
                }
                for key in ["branchName", "headSha"] {
                    optional(git, key, is_string, &format!("{git_path}.{key}"))?;
                }
            }
        }
    }
    if let Some(loop_value) = record.get("supervisionLoop") {
        let loop_path = format!("{path}.supervisionLoop");
        let status = orchestration_status(record.get("status"));
        if supervision_loop(loop_value, &status).is_none() {
            return fail(&loop_path);
        }
        let Some(supervision) = object(loop_value) else {
            return fail(&loop_path);
        };
        known_keys(
            supervision,
            &[
                "id",
                "status",
                "gate",
                "intervalMs",
                "iterationCount",
                "lastCheckedAt",
                "nextRunAt",
                "reason",
                "lastChildStatus",
                "stoppedAt",
            ],
            &loop_path,
        )?;
        for key in ["nextRunAt", "stoppedAt"] {
            optional(supervision, key, is_string, &format!("{loop_path}.{key}"))?;
        }
        optional(
            supervision,
            "lastChildStatus",
            one_of(&ORCHESTRATION_STATUSES),
            &format!("{loop_path}.lastChildStatus"),
        )?;
    }
    Ok(())
}

/// `decodePersistedUiState`: validates, then returns the state in the shape the app reads.
pub fn decode(value: &Value) -> CoreResult<Value> {
    let candidate = validate(value)?;
    let get = |key: &str| candidate.get(key);
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.into(), value);
        }
    };
    put(
        "version",
        get("version").and_then(persisted_version).map(Value::from),
    );
    put(
        "taskWorkbenchTemplatesBySession",
        get("taskWorkbenchTemplatesBySession").map(workbench_templates),
    );
    put(
        "selectedWorkspaceId",
        string_value(get("selectedWorkspaceId")),
    );
    put("selectedSessionId", string_value(get("selectedSessionId")));
    put("activeView", matching(get("activeView"), &APP_VIEWS));
    put(
        "composerDraft",
        Some(string_value(get("composerDraft")).unwrap_or_else(|| json!(""))),
    );
    put(
        "composerDraftsBySession",
        string_record(get("composerDraftsBySession")),
    );
    put(
        "extensionCommandCompatibilityByWorkspace",
        compatibility_by_workspace(get("extensionCommandCompatibilityByWorkspace")),
    );
    put(
        "extensionFlagsByWorkspace",
        extension_flag_records(get("extensionFlagsByWorkspace")),
    );
    put(
        "extensionFlagsBySession",
        extension_flag_records(get("extensionFlagsBySession")),
    );
    put(
        "notificationPreferences",
        notification_preferences(get("notificationPreferences")),
    );
    put(
        "disabledBuiltinExtensions",
        string_array(get("disabledBuiltinExtensions")),
    );
    put(
        "integratedTerminalShell",
        string_value(get("integratedTerminalShell")),
    );
    put(
        "lastViewedAtBySession",
        string_record(get("lastViewedAtBySession")),
    );
    put(
        "lastInteractedAtBySession",
        string_record(get("lastInteractedAtBySession")),
    );
    put("pinnedAtBySession", string_record(get("pinnedAtBySession")));
    put(
        "pinnedSessionOrder",
        string_array(get("pinnedSessionOrder")),
    );
    put("workspaceOrder", string_array(get("workspaceOrder")));
    put(
        "modelSettingsScopeMode",
        matching(get("modelSettingsScopeMode"), &["per-repo", "app-global"]),
    );
    put(
        "appGlobalModelSettings",
        model_settings_snapshot(get("appGlobalModelSettings")),
    );
    put(
        "sidebarCollapsed",
        get("sidebarCollapsed").filter(|v| v.is_boolean()).cloned(),
    );
    put(
        "threadGrouping",
        matching(get("threadGrouping"), &["time", "workspace"]),
    );
    put(
        "collapsedWorkspaceIds",
        string_array(get("collapsedWorkspaceIds")),
    );
    put(
        "allowMultiple",
        get("allowMultiple").filter(|v| v.is_boolean()).cloned(),
    );
    put(
        "enableTransparency",
        get("enableTransparency")
            .filter(|v| v.is_boolean())
            .cloned(),
    );
    put(
        "themeMode",
        matching(get("themeMode"), &["system", "light", "dark"]),
    );
    put(
        "themePresetId",
        matching(get("themePresetId"), &THEME_PRESETS),
    );
    put(
        "orchestrationChildren",
        get("orchestrationChildren")
            .and_then(Value::as_array)
            .map(|children| {
                Value::Array(children.iter().filter_map(orchestration_child).collect())
            }),
    );
    put(
        "composerAttachmentsBySession",
        object_array_record(get("composerAttachmentsBySession")),
    );
    put("transcripts", object_array_record(get("transcripts")));
    Ok(Value::Object(out))
}

/// Layouts are per-task conveniences: one bad layout must not block the rest of the state.
fn workbench_templates(value: &Value) -> Value {
    let Some(records) = object(value) else {
        eprintln!("[app-store] dropped invalid ui-state taskWorkbenchTemplatesBySession");
        return Value::Object(Map::new());
    };
    let mut kept = Map::new();
    for (key, template) in js::entries(records) {
        let decoded = if key.is_empty() || js::length(key) > 8192 {
            Err("Invalid workbench task reference".to_owned())
        } else {
            workbench_template::decode(template)
        };
        match decoded {
            Ok(template) => {
                kept.insert(key.clone(), template);
            }
            Err(message) => eprintln!(
                "[app-store] dropped invalid ui-state workbench layout for {}: {message}",
                key.chars().take(200).collect::<String>()
            ),
        }
    }
    Value::Object(kept)
}

fn string_value(value: Option<&Value>) -> Option<Value> {
    value.filter(|v| v.is_string()).cloned()
}

/// A non-empty string, as JavaScript's truthiness test on a string field.
fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn matching(value: Option<&Value>, options: &[&str]) -> Option<Value> {
    value
        .filter(|v| v.as_str().is_some_and(|text| options.contains(&text)))
        .cloned()
}

fn string_array(value: Option<&Value>) -> Option<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| Value::Array(items.iter().filter(|v| v.is_string()).cloned().collect()))
}

fn string_record(value: Option<&Value>) -> Option<Value> {
    let entries: Map<String, Value> = js::entries(object(value?)?)
        .into_iter()
        .filter(|(key, value)| !key.is_empty() && text(Some(value)).is_some())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    (!entries.is_empty()).then_some(Value::Object(entries))
}

fn extension_flag_records(value: Option<&Value>) -> Option<Value> {
    let empty = Map::new();
    let records = value.and_then(object).unwrap_or(&empty);
    let entries: Map<String, Value> = js::entries(records)
        .into_iter()
        .filter(|(_, flags)| object(flags).is_some_and(|values| !values.is_empty()))
        .map(|(id, flags)| (id.clone(), flags.clone()))
        .collect();
    (!entries.is_empty()).then_some(Value::Object(entries))
}

fn notification_preferences(value: Option<&Value>) -> Option<Value> {
    let candidate = object(value?)?;
    let preferences: Map<String, Value> = [
        "backgroundCompletion",
        "backgroundFailure",
        "attentionNeeded",
    ]
    .into_iter()
    .filter_map(|key| {
        candidate
            .get(key)
            .filter(|v| v.is_boolean())
            .map(|v| (key.to_owned(), v.clone()))
    })
    .collect();
    (!preferences.is_empty()).then_some(Value::Object(preferences))
}

fn compatibility_by_workspace(value: Option<&Value>) -> Option<Value> {
    let entries: Map<String, Value> = js::entries(object(value?)?)
        .into_iter()
        .filter_map(|(workspace_id, records)| {
            let records = records.as_array().filter(|_| !workspace_id.is_empty())?;
            let valid: Vec<Value> = records.iter().filter_map(compatibility_record).collect();
            (!valid.is_empty()).then(|| (workspace_id.clone(), Value::Array(valid)))
        })
        .collect();
    (!entries.is_empty()).then_some(Value::Object(entries))
}

fn compatibility_record(value: &Value) -> Option<Value> {
    let candidate = object(value)?;
    let string = |key: &str| candidate.get(key).and_then(Value::as_str);
    let status = string("status").filter(|s| *s == "supported" || *s == "terminal-only")?;
    Some(json!({
        "commandName": string("commandName")?,
        "extensionPath": string("extensionPath")?,
        "status": status,
        "message": string("message")?,
        "capability": string("capability")?,
        "updatedAt": string("updatedAt")?,
    }))
}

fn object_array_record(value: Option<&Value>) -> Option<Value> {
    let entries: Map<String, Value> = js::entries(object(value?)?)
        .into_iter()
        .filter_map(|(key, values)| {
            let values = values.as_array().filter(|_| !key.is_empty())?;
            let objects: Vec<Value> = values.iter().filter(|v| v.is_object()).cloned().collect();
            (!objects.is_empty()).then(|| (key.clone(), Value::Array(objects)))
        })
        .collect();
    (!entries.is_empty()).then_some(Value::Object(entries))
}

fn model_settings_snapshot(value: Option<&Value>) -> Option<Value> {
    let candidate = object(value?)?;
    let mut snapshot = Map::new();
    for key in ["defaultProvider", "defaultModelId", "defaultThinkingLevel"] {
        if let Some(text) = candidate.get(key).filter(|v| v.is_string()) {
            snapshot.insert(key.into(), text.clone());
        }
    }
    let patterns = string_array(candidate.get("enabledModelPatterns")).unwrap_or(json!([]));
    snapshot.insert("enabledModelPatterns".into(), patterns);
    Some(Value::Object(snapshot))
}

fn orchestration_status(value: Option<&Value>) -> String {
    optional_orchestration_status(value).unwrap_or_else(|| "running".into())
}

fn optional_orchestration_status(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|status| ORCHESTRATION_STATUSES.contains(status))
        .map(str::to_owned)
}

fn orchestration_child(value: &Value) -> Option<Value> {
    let candidate = object(value)?;
    let get = |key: &str| candidate.get(key);
    let id = text(get("id"))?;
    let parent_workspace_id = get("parentWorkspaceId").and_then(Value::as_str);
    let parent_session_id = text(get("parentSessionId"));
    // `??`: an empty child id is kept; only a missing one falls back.
    let child_workspace_id = get("childWorkspaceId")
        .and_then(Value::as_str)
        .or(parent_workspace_id)
        .unwrap_or("");
    let child_session_id = get("childSessionId").and_then(Value::as_str).unwrap_or("");
    let title = text(get("title"));
    let goal = text(get("goal"));
    let created_at = text(get("createdAt"));
    let updated_at = text(get("updatedAt"));
    let (parent_workspace_id, parent_session_id, title, goal, created_at, updated_at) = (
        parent_workspace_id.filter(|text| !text.is_empty())?,
        parent_session_id?,
        title?,
        goal?,
        created_at?,
        updated_at?,
    );
    let transcript: Vec<Value> = get("transcript")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter_map(|message| {
                    let record = object(message)?;
                    let role = record
                        .get("role")
                        .and_then(Value::as_str)
                        .filter(|role| ["parent", "child", "system"].contains(role))?;
                    Some(json!({
                        "id": text(record.get("id"))?,
                        "role": role,
                        "text": text(record.get("text"))?,
                        "createdAt": text(record.get("createdAt"))?,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    let retained = transcript[transcript
        .len()
        .saturating_sub(MAX_ORCHESTRATION_TRANSCRIPT_MESSAGES)..]
        .to_vec();
    let status = orchestration_status(get("status"));
    let supervision = get("supervisionLoop").and_then(|value| supervision_loop(value, &status));
    let latest = text(get("latestTranscript"))
        .or_else(|| retained.last().and_then(|message| message["text"].as_str()))
        .unwrap_or(goal)
        .to_owned();
    let mut child = Map::new();
    child.insert("id".into(), json!(id));
    if let Some(source) = text(get("sourceToolCallId")) {
        child.insert("sourceToolCallId".into(), json!(source));
    }
    child.insert("parentWorkspaceId".into(), json!(parent_workspace_id));
    child.insert("parentSessionId".into(), json!(parent_session_id));
    child.insert("childWorkspaceId".into(), json!(child_workspace_id));
    child.insert("childSessionId".into(), json!(child_session_id));
    child.insert("title".into(), json!(title));
    child.insert("goal".into(), json!(goal));
    child.insert("status".into(), json!(status));
    child.insert("latestTranscript".into(), json!(latest));
    child.insert("transcript".into(), Value::Array(retained));
    child.insert("evidence".into(), evidence_list(get("evidence"), id));
    if let Some(supervision) = supervision {
        child.insert("supervisionLoop".into(), supervision);
    }
    child.insert("createdAt".into(), json!(created_at));
    child.insert("updatedAt".into(), json!(updated_at));
    Some(Value::Object(child))
}

fn evidence_list(value: Option<&Value>, child_thread_id: &str) -> Value {
    let records: Vec<Value> = value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| evidence_record(entry, child_thread_id))
                .take(MAX_ORCHESTRATION_EVIDENCE_RECORDS)
                .collect()
        })
        .unwrap_or_default();
    Value::Array(records)
}

fn evidence_record(value: &Value, child_thread_id: &str) -> Option<Value> {
    let candidate = object(value)?;
    let pick = |key: &str, options: &[&str]| {
        candidate
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| options.contains(value))
    };
    let id = text(candidate.get("id"))?;
    let kind = pick(
        "kind",
        &[
            "worker_report",
            "orchestrator_acceptance",
            "orchestrator_observation",
            "orchestrator_action",
            "command",
            "review_finding",
            "blocker",
        ],
    )?;
    let source = pick(
        "source",
        &[
            "worker-reported",
            "orchestrator-accepted",
            "orchestrator-observed",
            "orchestrator-action",
            "command",
            "review",
            "blocker",
        ],
    )?;
    let status = pick(
        "status",
        &[
            "reported", "accepted", "running", "passed", "failed", "blocked",
        ],
    )?;
    let title = text(candidate.get("title"))?;
    let created_at = text(candidate.get("createdAt"))?;
    let git = candidate.get("git").and_then(object).and_then(evidence_git);
    let mut record = Map::new();
    record.insert("id".into(), json!(id));
    record.insert("childThreadId".into(), json!(child_thread_id));
    record.insert("kind".into(), json!(kind));
    record.insert("source".into(), json!(source));
    record.insert("status".into(), json!(status));
    record.insert("title".into(), json!(title));
    for key in ["detail", "command", "toolName"] {
        if let Some(value) = text(candidate.get(key)) {
            record.insert(key.into(), json!(value));
        }
    }
    if let Some(severity) = pick("severity", &["P0", "P1", "P2", "P3"]) {
        record.insert("severity".into(), json!(severity));
    }
    for key in ["parentSessionId", "childSessionId"] {
        if let Some(value) = text(candidate.get(key)) {
            record.insert(key.into(), json!(value));
        }
    }
    if let Some(git) = git {
        record.insert("git".into(), git);
    }
    record.insert("createdAt".into(), json!(created_at));
    if let Some(updated_at) = text(candidate.get("updatedAt")) {
        record.insert("updatedAt".into(), json!(updated_at));
    }
    Some(Value::Object(record))
}

fn evidence_git(value: &Map<String, Value>) -> Option<Value> {
    let mut git = Map::new();
    git.insert("workspaceId".into(), json!(text(value.get("workspaceId"))?));
    for key in ["branchName", "headSha"] {
        if let Some(text) = text(value.get(key)) {
            git.insert(key.into(), json!(text));
        }
    }
    Some(Value::Object(git))
}

fn supervision_loop(value: &Value, last_child_status: &str) -> Option<Value> {
    let candidate = object(value)?;
    let pick = |key: &str, options: &[&str]| {
        candidate
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| options.contains(value))
    };
    let finite = |key: &str| {
        candidate
            .get(key)
            .filter(|value| value.as_f64().is_some_and(f64::is_finite))
    };
    let id = text(candidate.get("id"))?;
    let status = pick("status", &["monitoring", "attention", "stopped"])?;
    let gate = pick("gate", &["continue", "stop", "wake"])?;
    let interval_ms = finite("intervalMs").filter(|value| value.as_f64() != Some(0.0))?;
    let iteration_count = finite("iterationCount")?;
    let last_checked_at = text(candidate.get("lastCheckedAt"))?;
    let reason = text(candidate.get("reason"))?;
    let mut supervision = Map::new();
    supervision.insert("id".into(), json!(id));
    supervision.insert("status".into(), json!(status));
    supervision.insert("gate".into(), json!(gate));
    supervision.insert("intervalMs".into(), interval_ms.clone());
    supervision.insert("iterationCount".into(), iteration_count.clone());
    supervision.insert("lastCheckedAt".into(), json!(last_checked_at));
    if let Some(next) = text(candidate.get("nextRunAt")) {
        supervision.insert("nextRunAt".into(), json!(next));
    }
    supervision.insert("reason".into(), json!(reason));
    let child_status = optional_orchestration_status(candidate.get("lastChildStatus"))
        .unwrap_or_else(|| last_child_status.to_owned());
    supervision.insert("lastChildStatus".into(), json!(child_status));
    if let Some(stopped) = text(candidate.get("stoppedAt")) {
        supervision.insert("stoppedAt".into(), json!(stopped));
    }
    Some(Value::Object(supervision))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn missing_file_reads_as_empty_and_writes_version_19_last() {
        let dir = crate::test_support::temp_dir("ui-state");
        let path = dir.join("ui-state.json");
        assert_eq!(read(&path).unwrap(), json!({}));
        let state = json!({ "composerDraft": "hi", "themeMode": "dark" });
        write(&path, state.as_object().unwrap().clone()).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"composerDraft\": \"hi\",\n  \"themeMode\": \"dark\",\n  \"version\": 19\n}\n"
        );
        assert_eq!(read(&path).unwrap()["version"], 19);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn older_versions_are_copied_once_before_the_first_v19_write() {
        let dir = crate::test_support::temp_dir("ui-state-migrate");
        let path = dir.join("ui-state.json");
        let original = "{ \"version\": 17, \"composerDraft\": \"keep\" }\r\n";
        fs::write(&path, original).unwrap();
        for _ in 0..2 {
            write(&path, Map::new()).unwrap();
        }
        let copies: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("ui-state.pre-workbench-v17."))
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(fs::read_to_string(dir.join(&copies[0])).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reports_the_first_invalid_field() {
        let cases = [
            (json!([]), "Invalid ui-state: expected an object; original data was retained."),
            (
                json!({ "future": 1 }),
                "Invalid ui-state field ui-state.future (unsupported field); original data was retained.",
            ),
            (
                json!({ "version": 17, "taskWorkbenchTemplatesBySession": {} }),
                "Invalid ui-state field workbench templates before v18; original data was retained.",
            ),
            (
                json!({ "extensionFlagsBySession": { "b": { "x": 1 }, "1": { "y": 2 } } }),
                "Invalid ui-state field extensionFlagsBySession.1; original data was retained.",
            ),
            (
                json!({ "orchestrationChildren": [{ "id": "c" }] }),
                "Invalid ui-state field orchestrationChildren[0]; original data was retained.",
            ),
        ];
        for (value, message) in cases {
            assert_eq!(decode(&value).unwrap_err().message, message, "{value}");
        }
    }

    #[test]
    fn drops_one_bad_layout_and_keeps_the_rest() {
        let good = json!({
            "visibility": "visible",
            "tools": [{ "kind": "files" }, { "kind": "worktrees" }],
            "selection": { "kind": "tool", "toolId": "worktrees" },
            "files": { "workspaceId": "w", "tabs": { "tabs": [], "active": null, "line": null,
                       "lineNonce": 0, "retained": [] } },
            "changes": { "workspaceId": "w", "selectedPath": null },
        });
        let decoded = decode(&json!({
            "version": 19,
            "taskWorkbenchTemplatesBySession": { "a": null, "b": good },
        }))
        .unwrap();
        let kept = &decoded["taskWorkbenchTemplatesBySession"];
        assert_eq!(kept.as_object().unwrap().len(), 1);
        assert_eq!(kept["b"]["tools"], json!([{ "kind": "files" }]));
        assert_eq!(
            kept["b"]["selection"],
            json!({ "kind": "tool", "toolId": "files" })
        );
        assert_eq!(
            kept["b"]["changes"]["scope"],
            json!({ "kind": "uncommitted" })
        );
        assert_eq!(decoded["composerDraft"], "");
    }
}
