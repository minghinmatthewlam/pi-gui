//! A task's saved workbench layout inside ui-state. Same checks and result as
//! `decodeTaskWorkbenchTemplate` in `contracts/workbench.ts` (which the IPC boundary still uses).

use crate::js;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const MAX_FILE_TABS: usize = 100;
const MAX_TOOLS: usize = 32;
const BUILTIN_TOOLS: [&str; 3] = ["files", "changes", "terminal"];
/// Removed tools: a layout that lists one loses that tab, not the whole layout.
const RETIRED_TOOLS: [&str; 1] = ["worktrees"];

type Decoded<T> = Result<T, String>;

fn fail<T>(field: &str) -> Decoded<T> {
    Err(format!("Invalid workbench template: {field}"))
}

/// Decodes one layout or says why it is invalid.
pub fn decode(value: &Value) -> Decoded<Value> {
    let root = record(
        value,
        &["visibility", "tools", "selection", "files", "changes"],
    )?;
    let visibility = match root.get("visibility") {
        Some(Value::String(text)) if text == "visible" || text == "hidden" => text.clone(),
        _ => return fail("visibility"),
    };
    let tool_values = match root.get("tools") {
        Some(Value::Array(items)) if items.len() <= MAX_TOOLS => items,
        _ => return fail("tools"),
    };
    let mut retired = HashSet::new();
    let mut tools = Vec::new();
    for value in tool_values {
        let tool = record(value, &["kind", "extensionId", "viewId"])?;
        let kind = tool.get("kind");
        if kind == Some(&json!("extension")) {
            let extension_id = text(tool.get("extensionId"), 256)?;
            let view_id = text(tool.get("viewId"), 256)?;
            tools.push(
                json!({ "kind": "extension", "extensionId": extension_id, "viewId": view_id }),
            );
            continue;
        }
        if tool.contains_key("extensionId") || tool.contains_key("viewId") {
            return fail("builtin tool fields");
        }
        match kind.and_then(Value::as_str) {
            Some(name) if RETIRED_TOOLS.contains(&name) => {
                retired.insert(name.to_owned());
            }
            Some(name) if BUILTIN_TOOLS.contains(&name) => tools.push(json!({ "kind": name })),
            _ => return fail("tool kind"),
        }
    }
    let identities: Vec<String> = tools.iter().map(tool_ref_id).collect();
    if identities.iter().collect::<HashSet<_>>().len() != identities.len() {
        return fail("duplicate tool");
    }
    let selected = record(
        root.get("selection").unwrap_or(&Value::Null),
        &["kind", "toolId"],
    )?;
    let selection = match (
        selected.get("kind").and_then(Value::as_str),
        selected.get("toolId"),
    ) {
        (Some("chooser"), None) => json!({ "kind": "chooser" }),
        (Some("tool"), Some(Value::String(id))) if identities.contains(id) => {
            json!({ "kind": "tool", "toolId": id })
        }
        (Some("tool"), Some(Value::String(id))) if retired.contains(id) => match identities.first()
        {
            Some(first) => json!({ "kind": "tool", "toolId": first }),
            None => json!({ "kind": "chooser" }),
        },
        _ => return fail("selection"),
    };
    let files = record(
        root.get("files").unwrap_or(&Value::Null),
        &["workspaceId", "tabs"],
    )?;
    let tabs = record(
        files.get("tabs").unwrap_or(&Value::Null),
        &["tabs", "active", "line", "lineNonce", "retained"],
    )?;
    let paths = paths_list(tabs.get("tabs"))?;
    let retained = paths_list(tabs.get("retained"))?;
    let active = match tabs.get("active") {
        Some(Value::Null) => None,
        other => Some(text(other, 4096)?),
    };
    if active
        .as_ref()
        .is_some_and(|active| !paths.contains(active))
    {
        return fail("active file");
    }
    if retained.iter().any(|path| !paths.contains(path)) {
        return fail("retained file");
    }
    let line = match tabs.get("line") {
        Some(Value::Null) => Value::Null,
        other => {
            let mark = record(other.unwrap_or(&Value::Null), &["start", "end"])?;
            let start = integer(mark.get("start"), 1)?;
            let end = integer(mark.get("end"), start)?;
            if active.is_none() {
                return fail("line without active file");
            }
            json!({ "start": start, "end": end })
        }
    };
    let changes = record(
        root.get("changes").unwrap_or(&Value::Null),
        &["workspaceId", "selectedPath", "scope"],
    )?;
    let files_workspace = text(files.get("workspaceId"), 4096)?;
    let line_nonce = integer(tabs.get("lineNonce"), 0)?;
    let changes_workspace = text(changes.get("workspaceId"), 4096)?;
    let selected_path = match changes.get("selectedPath") {
        Some(Value::Null) => Value::Null,
        other => Value::String(text(other, 4096)?),
    };
    let scope = match changes.get("scope") {
        None => json!({ "kind": "uncommitted" }),
        Some(scope) => decode_review_scope(scope)?,
    };
    Ok(json!({
        "visibility": visibility,
        "tools": tools,
        "selection": selection,
        "files": {
            "workspaceId": files_workspace,
            "tabs": {
                "tabs": paths,
                "active": active,
                "line": line,
                "lineNonce": line_nonce,
                "retained": retained,
            },
        },
        "changes": {
            "workspaceId": changes_workspace,
            "selectedPath": selected_path,
            "scope": scope,
        },
    }))
}

/// `toolRefId`: an extension view's id is its JSON triple.
fn tool_ref_id(tool: &Value) -> String {
    match tool["kind"].as_str() {
        Some("extension") => {
            js::stringify(&json!(["extension", tool["extensionId"], tool["viewId"]]))
        }
        Some(kind) => kind.to_owned(),
        None => String::new(),
    }
}

/// `decodeReviewScope` in `contracts/review.ts`, with its own messages.
fn decode_review_scope(value: &Value) -> Decoded<Value> {
    let review_fail = |label: &str| Err(format!("Invalid review request: {label}"));
    let scope = match value {
        Value::Object(map)
            if map
                .keys()
                .all(|key| ["kind", "baseRef", "checkpointId"].contains(&key.as_str())) =>
        {
            map
        }
        _ => return review_fail("object fields"),
    };
    let review_text = |value: &Value, label: &str| match value {
        Value::String(text)
            if !js::trim(text).is_empty() && js::length(text) <= 4096 && !text.contains('\0') =>
        {
            Ok(text.clone())
        }
        _ => Err(format!("Invalid review request: {label}")),
    };
    match scope.get("kind").and_then(Value::as_str) {
        Some(kind @ ("uncommitted" | "staged" | "unstaged")) => {
            if scope.contains_key("baseRef") || scope.contains_key("checkpointId") {
                return review_fail("scope fields");
            }
            Ok(json!({ "kind": kind }))
        }
        Some("branch") => {
            if scope.contains_key("checkpointId") {
                return review_fail("branch checkpoint");
            }
            match scope.get("baseRef") {
                None => Ok(json!({ "kind": "branch" })),
                Some(base) => {
                    Ok(json!({ "kind": "branch", "baseRef": review_text(base, "baseRef")? }))
                }
            }
        }
        Some("turn") => {
            if scope.contains_key("baseRef") {
                return review_fail("turn base");
            }
            match scope.get("checkpointId") {
                None => Ok(json!({ "kind": "turn" })),
                Some(id) => {
                    Ok(json!({ "kind": "turn", "checkpointId": review_text(id, "checkpointId")? }))
                }
            }
        }
        _ => review_fail("scope kind"),
    }
}

fn record<'a>(value: &'a Value, keys: &[&str]) -> Decoded<&'a Map<String, Value>> {
    let Value::Object(map) = value else {
        return fail("expected object");
    };
    if map.keys().any(|key| !keys.contains(&key.as_str())) {
        return fail("unsupported field");
    }
    Ok(map)
}

fn text(value: Option<&Value>, limit: usize) -> Decoded<String> {
    match value {
        Some(Value::String(text))
            if !js::trim(text).is_empty() && js::length(text) <= limit && !text.contains('\0') =>
        {
            Ok(text.clone())
        }
        _ => fail("invalid or oversized reference"),
    }
}

/// A safe integer of at least `minimum`, as a whole number.
fn integer(value: Option<&Value>, minimum: i64) -> Decoded<i64> {
    const SAFE: f64 = 9_007_199_254_740_991.0;
    match value.and_then(Value::as_f64) {
        Some(number)
            if number.fract() == 0.0 && number.abs() <= SAFE && number >= minimum as f64 =>
        {
            Ok(number as i64)
        }
        _ => fail("integer"),
    }
}

fn paths_list(value: Option<&Value>) -> Decoded<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return fail("file references");
    };
    if items.len() > MAX_FILE_TABS {
        return fail("file references");
    }
    let paths = items
        .iter()
        .map(|item| text(Some(item), 4096))
        .collect::<Decoded<Vec<_>>>()?;
    if paths.iter().collect::<HashSet<_>>().len() != paths.len() {
        return fail("duplicate file reference");
    }
    Ok(paths)
}
