//! Checks on what a renderer sends, with the messages `ipc/request-validation.ts` gives. A
//! renderer argument is `None` when it was `undefined`. Results are the decoded values as JSON,
//! with `undefined` fields left out, so parts can read them with serde.

use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{AppView, ThemeMode, ThemePresetId, ThreadGrouping};
use serde_json::{json, Map, Value};

/// A renderer argument: `None` is `undefined`.
pub type Arg<'a> = Option<&'a Value>;

/// `MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// `MIN_SCHEDULE_INTERVAL_MS` / `MAX_SCHEDULE_INTERVAL_MS`.
pub const MIN_SCHEDULE_INTERVAL_MS: i64 = 60_000;
pub const MAX_SCHEDULE_INTERVAL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// `COMPOSER_IMAGE_MAX_BYTES` and the total across one composer.
pub const COMPOSER_IMAGE_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const COMPOSER_IMAGE_MAX_BYTES_TOTAL: u64 = 3 * COMPOSER_IMAGE_MAX_BYTES;
pub const COMPOSER_IMAGE_MAX_DIMENSION: u32 = 8_192;

pub fn type_error(message: impl Into<String>) -> CoreError {
    CoreError::named("TypeError", message)
}

/// `ComposerAttachmentLimitError`, with its `code`.
pub fn attachment_limit_error(code: &str, message: String) -> CoreError {
    let mut error = CoreError::named("ComposerAttachmentLimitError", message);
    let mut data = Map::new();
    data.insert("code".into(), json!(code));
    error.data = Some(data);
    error
}

pub fn is_attachment_limit_error(error: &CoreError) -> bool {
    error.name == "ComposerAttachmentLimitError"
}

fn safe_integer(value: Arg) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number as i64)
}

pub fn expect_string(value: Arg, name: &str) -> CoreResult<String> {
    match value {
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Err(type_error(format!("{name} must be a string"))),
    }
}

pub fn expect_non_empty_string(value: Arg, name: &str) -> CoreResult<String> {
    let parsed = crate::js::trim(&expect_string(value, name)?).to_owned();
    if parsed.is_empty() {
        return Err(type_error(format!("{name} must not be empty")));
    }
    Ok(parsed)
}

pub fn expect_optional_string(value: Arg, name: &str) -> CoreResult<Option<String>> {
    value
        .map(|value| expect_string(Some(value), name))
        .transpose()
}

pub fn expect_boolean(value: Arg, name: &str) -> CoreResult<bool> {
    match value {
        Some(Value::Bool(flag)) => Ok(*flag),
        _ => Err(type_error(format!("{name} must be a boolean"))),
    }
}

fn expect_optional_boolean(value: Arg, name: &str) -> CoreResult<Option<bool>> {
    value
        .map(|value| expect_boolean(Some(value), name))
        .transpose()
}

fn expect_optional_non_empty_string(value: Arg, name: &str) -> CoreResult<Option<String>> {
    value
        .map(|value| expect_non_empty_string(Some(value), name))
        .transpose()
}

fn expect_optional_non_negative_integer(value: Arg, name: &str) -> CoreResult<Option<i64>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    match safe_integer(Some(raw)) {
        Some(number) if number >= 0 => Ok(Some(number)),
        _ => Err(type_error(format!("{name} must be a non-negative integer"))),
    }
}

pub fn expect_string_array(value: Arg, name: &str) -> CoreResult<Vec<String>> {
    match value {
        Some(Value::Array(entries)) if entries.iter().all(Value::is_string) => Ok(entries
            .iter()
            .filter_map(|entry| entry.as_str().map(str::to_owned))
            .collect()),
        _ => Err(type_error(format!("{name} must be an array of strings"))),
    }
}

pub fn expect_record<'a>(value: Arg<'a>, name: &str) -> CoreResult<&'a Map<String, Value>> {
    match value {
        Some(Value::Object(record)) => Ok(record),
        _ => Err(type_error(format!("{name} must be an object"))),
    }
}

/// `expectSessionTarget`, as a `SessionRef`.
pub fn expect_session_target(
    value: Arg,
    name: &str,
) -> CoreResult<crate::state::driver::SessionRef> {
    let record = expect_record(value, name)?;
    let workspace_id =
        expect_non_empty_string(record.get("workspaceId"), &format!("{name}.workspaceId"))?;
    let session_id =
        expect_non_empty_string(record.get("sessionId"), &format!("{name}.sessionId"))?;
    Ok(crate::state::driver::session_ref(
        &workspace_id,
        &session_id,
    ))
}

pub fn expect_app_view(value: Arg) -> CoreResult<AppView> {
    const VIEWS: [&str; 6] = [
        "threads",
        "new-thread",
        "scheduled",
        "skills",
        "extensions",
        "settings",
    ];
    match value {
        Some(Value::String(view)) if VIEWS.contains(&view.as_str()) => {
            serde_json::from_value(json!(view))
                .map_err(|_| type_error("view must be a supported app view"))
        }
        _ => Err(type_error("view must be a supported app view")),
    }
}

pub fn expect_thread_grouping(value: Arg) -> CoreResult<ThreadGrouping> {
    match value.and_then(Value::as_str) {
        Some("time") => Ok(ThreadGrouping::Time),
        Some("workspace") => Ok(ThreadGrouping::Workspace),
        _ => Err(type_error("grouping must be time or workspace")),
    }
}

pub fn expect_theme_mode(value: Arg) -> CoreResult<ThemeMode> {
    match value.and_then(Value::as_str) {
        Some("system" | "light" | "dark") => {
            serde_json::from_value(value.cloned().unwrap_or_default())
                .map_err(|_| type_error("mode must be system, light, or dark"))
        }
        _ => Err(type_error("mode must be system, light, or dark")),
    }
}

pub fn expect_theme_preset_id(value: Arg) -> CoreResult<ThemePresetId> {
    match value {
        Some(Value::String(_)) => serde_json::from_value(value.cloned().unwrap_or_default())
            .map_err(|_| type_error("presetId must be a supported theme preset")),
        _ => Err(type_error("presetId must be a supported theme preset")),
    }
}

pub fn expect_model_settings_scope_mode(value: Arg) -> CoreResult<String> {
    match value.and_then(Value::as_str) {
        Some(mode @ ("app-global" | "per-repo")) => Ok(mode.to_owned()),
        _ => Err(type_error("mode must be app-global or per-repo")),
    }
}

pub fn expect_thinking_level(value: Arg) -> CoreResult<String> {
    match value.and_then(Value::as_str) {
        Some(level @ ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")) => {
            Ok(level.to_owned())
        }
        _ => Err(type_error(
            "thinkingLevel must be a supported thinking level",
        )),
    }
}

pub fn expect_optional_thinking_level(value: Arg) -> CoreResult<Option<String>> {
    value
        .map(|value| expect_thinking_level(Some(value)))
        .transpose()
}

/// Builds an object from `(key, value)` pairs, leaving out `undefined` ones.
fn object(entries: impl IntoIterator<Item = (&'static str, Option<Value>)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value)))
            .collect(),
    )
}

pub fn expect_create_worktree_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    Ok(object([
        (
            "workspaceId",
            Some(json!(expect_non_empty_string(
                record.get("workspaceId"),
                "input.workspaceId"
            )?)),
        ),
        (
            "fromSessionWorkspaceId",
            expect_optional_non_empty_string(
                record.get("fromSessionWorkspaceId"),
                "input.fromSessionWorkspaceId",
            )?
            .map(Value::String),
        ),
        (
            "fromSessionId",
            expect_optional_non_empty_string(record.get("fromSessionId"), "input.fromSessionId")?
                .map(Value::String),
        ),
    ]))
}

pub fn expect_remove_worktree_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    Ok(json!({
        "workspaceId": expect_non_empty_string(record.get("workspaceId"), "input.workspaceId")?,
        "worktreeId": expect_non_empty_string(record.get("worktreeId"), "input.worktreeId")?,
    }))
}

pub fn expect_create_session_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    Ok(object([
        (
            "workspaceId",
            Some(json!(expect_non_empty_string(
                record.get("workspaceId"),
                "input.workspaceId"
            )?)),
        ),
        (
            "title",
            expect_optional_string(record.get("title"), "input.title")?.map(Value::String),
        ),
    ]))
}

fn expect_environment(record: &Map<String, Value>) -> CoreResult<Value> {
    match record.get("environment").and_then(Value::as_str) {
        Some(environment @ ("local" | "worktree")) => Ok(json!(environment)),
        _ => Err(type_error("input.environment must be local or worktree")),
    }
}

pub fn expect_start_thread_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    let environment = expect_environment(record)?;
    Ok(object([
        (
            "rootWorkspaceId",
            Some(json!(expect_non_empty_string(
                record.get("rootWorkspaceId"),
                "input.rootWorkspaceId"
            )?)),
        ),
        ("environment", Some(environment)),
        (
            "prompt",
            expect_optional_string(record.get("prompt"), "input.prompt")?.map(Value::String),
        ),
        (
            "attachments",
            record
                .get("attachments")
                .map(|attachments| {
                    expect_composer_attachments(Some(attachments), "input.attachments")
                })
                .transpose()?,
        ),
        (
            "provider",
            expect_optional_non_empty_string(record.get("provider"), "input.provider")?
                .map(Value::String),
        ),
        (
            "modelId",
            expect_optional_non_empty_string(record.get("modelId"), "input.modelId")?
                .map(Value::String),
        ),
        (
            "thinkingLevel",
            expect_optional_string(record.get("thinkingLevel"), "input.thinkingLevel")?
                .map(Value::String),
        ),
        (
            "extensionFlags",
            record
                .get("extensionFlags")
                .map(|flags| expect_extension_flags(Some(flags), "input.extensionFlags"))
                .transpose()?,
        ),
    ]))
}

/// `expectExtensionFlags`: names and types are checked against the runtime later.
fn expect_extension_flags(value: Arg, label: &str) -> CoreResult<Value> {
    let mut flags = Map::new();
    for (name, flag) in expect_record(value, label)? {
        if crate::js::trim(name).is_empty() {
            return Err(type_error(format!("{label} flag names must be non-empty")));
        }
        if !flag.is_boolean() && !flag.is_string() {
            return Err(type_error(format!(
                "{label}.{name} must be a boolean or string"
            )));
        }
        flags.insert(name.clone(), flag.clone());
    }
    Ok(Value::Object(flags))
}

pub fn expect_fork_thread_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    let environment = expect_environment(record)?;
    let position = match record.get("position") {
        None => None,
        Some(Value::String(position)) if ["before", "at", "after"].contains(&position.as_str()) => {
            Some(json!(position))
        }
        Some(_) => return Err(type_error("input.position must be before, at, or after")),
    };
    Ok(object([
        (
            "sourceWorkspaceId",
            Some(json!(expect_non_empty_string(
                record.get("sourceWorkspaceId"),
                "input.sourceWorkspaceId"
            )?)),
        ),
        (
            "sourceSessionId",
            Some(json!(expect_non_empty_string(
                record.get("sourceSessionId"),
                "input.sourceSessionId"
            )?)),
        ),
        (
            "rootWorkspaceId",
            Some(json!(expect_non_empty_string(
                record.get("rootWorkspaceId"),
                "input.rootWorkspaceId"
            )?)),
        ),
        ("environment", Some(environment)),
        (
            "sourceMessageId",
            expect_optional_non_empty_string(
                record.get("sourceMessageId"),
                "input.sourceMessageId",
            )?
            .map(Value::String),
        ),
        (
            "sourceMessageIndex",
            expect_optional_non_negative_integer(
                record.get("sourceMessageIndex"),
                "input.sourceMessageIndex",
            )?
            .map(|index| json!(index)),
        ),
        (
            "userMessageIndex",
            expect_optional_non_negative_integer(
                record.get("userMessageIndex"),
                "input.userMessageIndex",
            )?
            .map(|index| json!(index)),
        ),
        ("position", position),
    ]))
}

pub fn expect_send_child_thread_follow_up_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    Ok(json!({
        "childThreadId": expect_non_empty_string(record.get("childThreadId"), "input.childThreadId")?,
        "text": expect_string(record.get("text"), "input.text")?,
    }))
}

pub fn expect_set_child_supervision_loop_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    let gate = match record.get("gate").and_then(Value::as_str) {
        Some(gate @ ("continue" | "stop")) => gate.to_owned(),
        _ => return Err(type_error("input.gate must be continue or stop")),
    };
    Ok(json!({
        "childThreadId": expect_non_empty_string(record.get("childThreadId"), "input.childThreadId")?,
        "gate": gate,
    }))
}

pub fn expect_notification_preferences(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "preferences")?;
    let mut preferences = Map::new();
    for key in [
        "backgroundCompletion",
        "backgroundFailure",
        "attentionNeeded",
    ] {
        if let Some(flag) = record.get(key) {
            preferences.insert(
                key.into(),
                json!(expect_boolean(Some(flag), &format!("preferences.{key}"))?),
            );
        }
    }
    Ok(Value::Object(preferences))
}

pub fn expect_custom_provider_config(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "config")?;
    let Some(Value::Array(models)) = record.get("models") else {
        return Err(type_error("config.models must be an array"));
    };
    let provider_id = expect_non_empty_string(record.get("providerId"), "config.providerId")?;
    let base_url = expect_non_empty_string(record.get("baseUrl"), "config.baseUrl")?;
    let api_key = expect_optional_string(record.get("apiKey"), "config.apiKey")?;
    let models = models
        .iter()
        .enumerate()
        .map(|(index, model)| {
            let entry = expect_record(Some(model), &format!("config.models[{index}]"))?;
            let context_window = entry.get("contextWindow");
            if let Some(window) = context_window {
                if !safe_integer(Some(window)).is_some_and(|window| window > 0) {
                    return Err(type_error(format!(
                        "config.models[{index}].contextWindow must be a positive integer"
                    )));
                }
            }
            Ok(object([
                (
                    "id",
                    Some(json!(expect_non_empty_string(
                        entry.get("id"),
                        &format!("config.models[{index}].id")
                    )?)),
                ),
                ("contextWindow", context_window.cloned()),
            ]))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    Ok(object([
        ("providerId", Some(json!(provider_id))),
        ("baseUrl", Some(json!(base_url))),
        ("apiKey", api_key.map(Value::String)),
        ("models", Some(Value::Array(models))),
    ]))
}

pub fn expect_mcp_server_scope(value: Arg) -> CoreResult<String> {
    match value.and_then(Value::as_str) {
        Some(scope @ ("global" | "project")) => Ok(scope.to_owned()),
        _ => Err(type_error("scope must be global or project")),
    }
}

pub fn expect_new_mcp_server_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "server")?;
    let name = expect_non_empty_string(record.get("name"), "server.name")?;
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
    {
        return Err(type_error(
            "server.name may only use letters, digits, \"_\" and \"-\"",
        ));
    }
    let description = expect_optional_string(record.get("description"), "server.description")?;
    let mut server = Map::new();
    server.insert("name".into(), json!(name));
    if let Some(description) = description {
        server.insert("description".into(), json!(description));
    }
    if let Some(url) = record.get("url") {
        if record.contains_key("command") || record.contains_key("args") {
            return Err(type_error(
                "server needs either a url or a command, not both",
            ));
        }
        server.insert(
            "url".into(),
            json!(expect_non_empty_string(Some(url), "server.url")?),
        );
        return Ok(Value::Object(server));
    }
    server.insert(
        "command".into(),
        json!(expect_non_empty_string(
            record.get("command"),
            "server.command"
        )?),
    );
    let args = match record.get("args") {
        None => Vec::new(),
        Some(args) => expect_string_array(Some(args), "server.args")?,
    };
    server.insert("args".into(), json!(args));
    Ok(Value::Object(server))
}

pub fn expect_custom_provider_probe_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    Ok(object([
        (
            "baseUrl",
            Some(json!(expect_non_empty_string(
                record.get("baseUrl"),
                "input.baseUrl"
            )?)),
        ),
        (
            "apiKey",
            expect_optional_string(record.get("apiKey"), "input.apiKey")?.map(Value::String),
        ),
    ]))
}

pub fn expect_host_ui_response(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "response")?;
    let request_id = expect_non_empty_string(record.get("requestId"), "response.requestId")?;
    let text = record.get("value").and_then(Value::as_str);
    let confirmed = record.get("confirmed").and_then(Value::as_bool);
    let cancelled = record.get("cancelled") == Some(&Value::Bool(true));
    let variants = [text.is_some(), confirmed.is_some(), cancelled]
        .iter()
        .filter(|present| **present)
        .count();
    if variants != 1 {
        return Err(type_error(
            "response must contain exactly one of value, confirmed, or cancelled",
        ));
    }
    Ok(match (text, confirmed) {
        (Some(text), _) => json!({ "requestId": request_id, "value": text }),
        (_, Some(confirmed)) => json!({ "requestId": request_id, "confirmed": confirmed }),
        _ => json!({ "requestId": request_id, "cancelled": true }),
    })
}

pub fn expect_navigate_session_tree_options(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "options")?;
    Ok(object([
        (
            "summarize",
            expect_optional_boolean(record.get("summarize"), "options.summarize")?.map(Value::Bool),
        ),
        (
            "customInstructions",
            expect_optional_string(
                record.get("customInstructions"),
                "options.customInstructions",
            )?
            .map(Value::String),
        ),
    ]))
}

pub fn expect_terminal_size(value: Arg, name: &str) -> CoreResult<Value> {
    let record = expect_record(value, name)?;
    let cols = safe_integer(record.get("cols")).filter(|cols| *cols > 0);
    let Some(cols) = cols else {
        return Err(type_error(format!(
            "{name}.cols must be a positive integer"
        )));
    };
    let rows = safe_integer(record.get("rows")).filter(|rows| *rows > 0);
    let Some(rows) = rows else {
        return Err(type_error(format!(
            "{name}.rows must be a positive integer"
        )));
    };
    Ok(json!({ "cols": cols, "rows": rows }))
}

pub fn expect_workspace_file_list_options(value: Arg) -> CoreResult<Option<Value>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let record = expect_record(Some(raw), "options")?;
    Ok(Some(object([(
        "force",
        expect_optional_boolean(record.get("force"), "options.force")?.map(Value::Bool),
    )])))
}

/// `expectComposerAttachments`, then the byte limits (`assertComposerAttachmentsAccepted`).
pub fn expect_composer_attachments(value: Arg, name: &str) -> CoreResult<Value> {
    let Some(Value::Array(entries)) = value else {
        return Err(type_error(format!("{name} must be an array")));
    };
    let attachments = entries
        .iter()
        .enumerate()
        .map(|(index, attachment)| {
            let item = format!("{name}[{index}]");
            let record = expect_record(Some(attachment), &item)?;
            let id = expect_non_empty_string(record.get("id"), &format!("{item}.id"))?;
            let file_name = expect_non_empty_string(record.get("name"), &format!("{item}.name"))?;
            let mime_type =
                expect_non_empty_string(record.get("mimeType"), &format!("{item}.mimeType"))?;
            match record.get("kind").and_then(Value::as_str) {
                Some("image") => Ok(json!({
                    "id": id, "name": file_name, "mimeType": mime_type, "kind": "image",
                    "data": expect_non_empty_string(record.get("data"), &format!("{item}.data"))?,
                })),
                Some("file") => {
                    let size = expect_optional_non_negative_integer(
                        record.get("sizeBytes"),
                        &format!("{item}.sizeBytes"),
                    )?;
                    let fs_path =
                        expect_non_empty_string(record.get("fsPath"), &format!("{item}.fsPath"))?;
                    Ok(object([
                        ("id", Some(json!(id))),
                        ("name", Some(json!(file_name))),
                        ("mimeType", Some(json!(mime_type))),
                        ("kind", Some(json!("file"))),
                        ("fsPath", Some(json!(fs_path))),
                        ("sizeBytes", size.map(|size| json!(size))),
                    ]))
                }
                _ => Err(type_error(format!("{item}.kind must be image or file"))),
            }
        })
        .collect::<CoreResult<Vec<_>>>()?;
    assert_composer_attachments_accepted(&[], &attachments)?;
    Ok(Value::Array(attachments))
}

/// `decodedImageByteLength`.
pub fn decoded_image_byte_length(base64: &str) -> u64 {
    let trimmed = crate::js::trim(base64);
    if trimmed.is_empty() {
        return 0;
    }
    let padding = if trimmed.ends_with("==") {
        2
    } else if trimmed.ends_with('=') {
        1
    } else {
        0
    };
    let length = crate::js::length(trimmed) as u64;
    (length * 3 / 4).saturating_sub(padding)
}

fn image_bytes(attachment: &Value) -> Option<u64> {
    (attachment.get("kind").and_then(Value::as_str) == Some("image")).then(|| {
        decoded_image_byte_length(attachment.get("data").and_then(Value::as_str).unwrap_or(""))
    })
}

pub fn composer_image_bytes_limit_message() -> String {
    format!(
        "Image is larger than {} MB.",
        COMPOSER_IMAGE_MAX_BYTES / (1024 * 1024)
    )
}

pub fn composer_image_aggregate_limit_message() -> String {
    format!(
        "Images together are larger than {} MB.",
        COMPOSER_IMAGE_MAX_BYTES_TOTAL / (1024 * 1024)
    )
}

pub fn composer_image_pixels_limit_message() -> String {
    format!("Image is larger than {COMPOSER_IMAGE_MAX_DIMENSION} pixels.")
}

/// `assertComposerAttachmentsAccepted`: each image and all of them together stay in bounds.
pub fn assert_composer_attachments_accepted(
    existing: &[Value],
    incoming: &[Value],
) -> CoreResult<()> {
    let existing_bytes: u64 = existing.iter().filter_map(image_bytes).sum();
    let mut incoming_bytes = 0;
    for bytes in incoming.iter().filter_map(image_bytes) {
        if bytes > COMPOSER_IMAGE_MAX_BYTES {
            return Err(attachment_limit_error(
                "bytes",
                composer_image_bytes_limit_message(),
            ));
        }
        incoming_bytes += bytes;
    }
    if existing_bytes + incoming_bytes > COMPOSER_IMAGE_MAX_BYTES_TOTAL {
        return Err(attachment_limit_error(
            "aggregate",
            composer_image_aggregate_limit_message(),
        ));
    }
    Ok(())
}

pub fn expect_optional_deliver_options(value: Arg) -> CoreResult<Option<Value>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let record = expect_record(Some(raw), "options")?;
    match record.get("deliverAs") {
        None => Ok(Some(json!({}))),
        Some(Value::String(mode)) if mode == "steer" || mode == "followUp" => {
            Ok(Some(json!({ "deliverAs": mode })))
        }
        Some(_) => Err(type_error("options.deliverAs must be steer or followUp")),
    }
}

pub fn expect_create_scheduled_task_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "input")?;
    Ok(object([
        (
            "title",
            Some(json!(expect_non_empty_string(
                record.get("title"),
                "input.title"
            )?)),
        ),
        (
            "instruction",
            Some(json!(expect_non_empty_string(
                record.get("instruction"),
                "input.instruction"
            )?)),
        ),
        (
            "schedule",
            Some(assert_scheduled_task_schedule(
                record.get("schedule"),
                "input.schedule",
            )?),
        ),
        (
            "target",
            Some(assert_scheduled_task_target(
                record.get("target"),
                "input.target",
            )?),
        ),
        (
            "originSessionId",
            expect_optional_non_empty_string(
                record.get("originSessionId"),
                "input.originSessionId",
            )?
            .map(Value::String),
        ),
    ]))
}

pub fn expect_update_scheduled_task_input(value: Arg) -> CoreResult<Value> {
    let record = expect_record(value, "patch")?;
    let status = match record.get("status") {
        None => None,
        Some(Value::String(status))
            if ["active", "paused", "completed"].contains(&status.as_str()) =>
        {
            Some(json!(status))
        }
        Some(_) => {
            return Err(type_error(
                "patch.status must be active, paused, or completed",
            ))
        }
    };
    Ok(object([
        (
            "title",
            expect_optional_non_empty_string(record.get("title"), "patch.title")?
                .map(Value::String),
        ),
        (
            "instruction",
            expect_optional_non_empty_string(record.get("instruction"), "patch.instruction")?
                .map(Value::String),
        ),
        (
            "schedule",
            record
                .get("schedule")
                .map(|schedule| assert_scheduled_task_schedule(Some(schedule), "patch.schedule"))
                .transpose()?,
        ),
        (
            "target",
            record
                .get("target")
                .map(|target| assert_scheduled_task_target(Some(target), "patch.target"))
                .transpose()?,
        ),
        ("status", status),
    ]))
}

/// `parseWeekday`.
fn parse_weekday(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_f64() {
        return (number.fract() == 0.0 && (0.0..=6.0).contains(&number)).then_some(number as i64);
    }
    let alias = crate::js::trim(value.as_str()?).to_lowercase();
    Some(match alias.as_str() {
        "sun" | "sunday" | "0" => 0,
        "mon" | "monday" | "1" => 1,
        "tue" | "tues" | "tuesday" | "2" => 2,
        "wed" | "wednesday" | "3" => 3,
        "thu" | "thur" | "thurs" | "thursday" | "4" => 4,
        "fri" | "friday" | "5" => 5,
        "sat" | "saturday" | "6" => 6,
        _ => return None,
    })
}

fn integer_in(value: Option<&Value>, low: f64, high: f64) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number >= low && number <= high).then_some(number)
}

/// `assertScheduledTaskSchedule`.
pub fn assert_scheduled_task_schedule(value: Arg, name: &str) -> CoreResult<Value> {
    let record = expect_record(value, name)?;
    match record.get("kind").and_then(Value::as_str) {
        Some("once") => {
            let at = record
                .get("at")
                .and_then(Value::as_str)
                .map(crate::js::trim)
                .unwrap_or("");
            let parsed = crate::js::date_parse(at, &crate::time_zone::host());
            match parsed.and_then(crate::js::to_iso_string) {
                Some(iso) if !at.is_empty() => Ok(json!({ "kind": "once", "at": iso })),
                _ => Err(type_error(format!("{name}.at must be an ISO timestamp"))),
            }
        }
        Some(kind @ ("daily" | "weekly")) => {
            let time_zone = match record
                .get("timeZone")
                .and_then(Value::as_str)
                .map(crate::js::trim)
                .filter(|zone| !zone.is_empty())
            {
                Some(zone) if crate::time_zone::is_time_zone(zone) => zone.to_owned(),
                Some(_) => {
                    return Err(type_error(format!(
                        "{name}.timeZone must be an IANA time zone"
                    )))
                }
                None => crate::time_zone::host_time_zone(),
            };
            let Some(hour) = integer_in(record.get("hour"), 0.0, 23.0) else {
                return Err(type_error(format!("{name}.hour must be an integer 0-23")));
            };
            let Some(minute) = integer_in(record.get("minute"), 0.0, 59.0) else {
                return Err(type_error(format!("{name}.minute must be an integer 0-59")));
            };
            if kind == "daily" {
                return Ok(json!({
                    "kind": "daily", "hour": hour as i64, "minute": minute as i64, "timeZone": time_zone,
                }));
            }
            let entries = match record.get("days") {
                Some(Value::Array(entries)) if !entries.is_empty() => entries,
                _ => {
                    return Err(type_error(format!(
                        "{name}.days must be a non-empty weekday list"
                    )))
                }
            };
            let mut days = Vec::new();
            for entry in entries {
                let Some(day) = parse_weekday(entry) else {
                    return Err(type_error(format!("{name}.days must contain weekdays")));
                };
                if !days.contains(&day) {
                    days.push(day);
                }
            }
            days.sort_unstable();
            Ok(json!({
                "kind": "weekly", "days": days, "hour": hour as i64, "minute": minute as i64,
                "timeZone": time_zone,
            }))
        }
        Some("interval") => {
            match integer_in(
                record.get("everyMs"),
                MIN_SCHEDULE_INTERVAL_MS as f64,
                MAX_SCHEDULE_INTERVAL_MS as f64,
            ) {
                Some(every) => Ok(json!({ "kind": "interval", "everyMs": every as i64 })),
                None => Err(type_error(format!(
                    "{name}.everyMs must be an integer between {MIN_SCHEDULE_INTERVAL_MS} and {MAX_SCHEDULE_INTERVAL_MS}"
                ))),
            }
        }
        _ => Err(type_error(format!(
            "{name}.kind must be once, daily, weekly, or interval"
        ))),
    }
}

/// `assertScheduledTaskTarget`.
pub fn assert_scheduled_task_target(value: Arg, name: &str) -> CoreResult<Value> {
    let record = expect_record(value, name)?;
    let trimmed = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .map(crate::js::trim)
            .unwrap_or("")
            .to_owned()
    };
    let workspace_id = trimmed("workspaceId");
    if workspace_id.is_empty() {
        return Err(type_error(format!("{name}.workspaceId must not be empty")));
    }
    match record.get("kind").and_then(Value::as_str) {
        Some("new-thread") => Ok(json!({ "kind": "new-thread", "workspaceId": workspace_id })),
        Some("existing-thread") => {
            let session_id = trimmed("sessionId");
            if session_id.is_empty() {
                return Err(type_error(format!("{name}.sessionId must not be empty")));
            }
            Ok(
                json!({ "kind": "existing-thread", "workspaceId": workspace_id, "sessionId": session_id }),
            )
        }
        _ => Err(type_error(format!(
            "{name}.kind must be new-thread or existing-thread"
        ))),
    }
}

/// `expectSaveTaskWorkbenchTemplateInput`.
pub fn expect_save_task_workbench_template_input(value: Arg) -> CoreResult<Value> {
    let input = expect_record(value, "workbench save")?;
    if input
        .keys()
        .any(|key| !["target", "template", "sequence"].contains(&key.as_str()))
    {
        return Err(type_error("workbench save contains an unsupported field"));
    }
    if !safe_integer(input.get("sequence")).is_some_and(|sequence| sequence >= 1) {
        return Err(type_error(
            "workbench sequence must be a positive safe integer",
        ));
    }
    let target = expect_session_target(input.get("target"), "target")?;
    let template = super::review::decode_task_workbench_template(input.get("template"))?;
    Ok(json!({ "target": target, "template": template, "sequence": input["sequence"] }))
}

/// `expectExtensionActionRequest`: the action is extension-authored data.
pub fn expect_extension_action_request(value: Arg) -> CoreResult<Value> {
    let input = expect_record(value, "extension action request")?;
    let Some(action) = super::extensions::parse_extension_action(input.get("action")) else {
        return Err(CoreError::new(
            "pi-gui does not support this button's action",
        ));
    };
    let target = expect_session_target(input.get("target"), "target")?;
    Ok(json!({ "target": target, "action": action }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(result: CoreResult<impl std::fmt::Debug>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}", error.name, error.message)
    }

    #[test]
    fn strings_and_targets_fail_like_the_typescript() {
        assert_eq!(
            message(expect_non_empty_string(Some(&json!("  ")), "workspaceId")),
            "TypeError: workspaceId must not be empty"
        );
        assert_eq!(
            expect_non_empty_string(Some(&json!(" a ")), "x").unwrap(),
            "a"
        );
        assert_eq!(
            message(expect_session_target(
                Some(&json!({ "workspaceId": "w" })),
                "target"
            )),
            "TypeError: target.sessionId must be a string"
        );
        assert_eq!(
            message(expect_string_array(Some(&json!([1])), "order")),
            "TypeError: order must be an array of strings"
        );
        assert_eq!(
            message(expect_app_view(Some(&json!("elsewhere")))),
            "TypeError: view must be a supported app view"
        );
    }

    #[test]
    fn host_ui_responses_carry_exactly_one_answer() {
        assert_eq!(
            expect_host_ui_response(Some(&json!({ "requestId": "r", "confirmed": false })))
                .unwrap(),
            json!({ "requestId": "r", "confirmed": false })
        );
        assert_eq!(
            message(expect_host_ui_response(Some(
                &json!({ "requestId": "r", "value": "a", "cancelled": true })
            ))),
            "TypeError: response must contain exactly one of value, confirmed, or cancelled"
        );
    }

    #[test]
    fn schedules_normalize_and_reject_like_the_typescript() {
        assert_eq!(
            assert_scheduled_task_schedule(
                Some(&json!({ "kind": "weekly", "days": ["fri", 1, "mon"], "hour": 9, "minute": 0, "timeZone": "UTC" })),
                "schedule"
            )
            .unwrap(),
            json!({ "kind": "weekly", "days": [1, 5], "hour": 9, "minute": 0, "timeZone": "UTC" })
        );
        assert_eq!(
            message(assert_scheduled_task_schedule(
                Some(&json!({ "kind": "interval", "everyMs": 5 })),
                "input.schedule"
            )),
            "TypeError: input.schedule.everyMs must be an integer between 60000 and 604800000"
        );
        assert_eq!(
            assert_scheduled_task_schedule(
                Some(&json!({ "kind": "once", "at": "2026-01-02T03:04:05Z" })),
                "s"
            )
            .unwrap(),
            json!({ "kind": "once", "at": "2026-01-02T03:04:05.000Z" })
        );
    }

    #[test]
    fn oversized_images_are_refused_with_their_limit() {
        let big = "A".repeat((COMPOSER_IMAGE_MAX_BYTES as usize / 3) * 4 + 8);
        let error = expect_composer_attachments(
            Some(&json!([{ "id": "1", "name": "a.png", "mimeType": "image/png", "kind": "image", "data": big }])),
            "attachments",
        )
        .unwrap_err();
        assert!(is_attachment_limit_error(&error));
        assert_eq!(error.message, "Image is larger than 10 MB.");
    }
}
