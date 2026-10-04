//! Twin of `apps/desktop/contracts/tool-labels.ts`: what a tool row is called.

use indexmap::IndexMap;
use serde_json::Value;

use super::driver::RuntimeSnapshot;
use super::js;

/// Tool name → the label its extension registered, for one folder's loaded extensions.
pub type ExtensionToolLabels = IndexMap<String, String>;

/// `extensionToolLabels`: labels of the tools a folder's own extensions registered. A tool
/// keeps pi-gui's wording when it replaces one of pi's tools, comes from pi-gui's built-in
/// extensions, or is registered by more than one enabled extension.
pub fn extension_tool_labels(runtime: Option<&RuntimeSnapshot>) -> ExtensionToolLabels {
    let Some(runtime) = runtime else {
        return IndexMap::new();
    };
    let registrations: Vec<_> = runtime
        .extensions
        .iter()
        .filter(|extension| extension.enabled)
        .flat_map(|extension| {
            let builtin = extension.source_info.source == "builtin";
            extension.tools.iter().map(move |tool| (tool, builtin))
        })
        .collect();
    let mut counts: IndexMap<&str, usize> = IndexMap::new();
    for (tool, _) in &registrations {
        *counts.entry(tool.name.as_str()).or_default() += 1;
    }
    let mut labels = IndexMap::new();
    for (tool, builtin) in registrations {
        let label = js::js_trim(&tool.label);
        if !label.is_empty()
            && !builtin
            && !tool.replaces_pi_tool
            && counts.get(tool.name.as_str()) == Some(&1)
        {
            labels.insert(tool.name.clone(), label.to_string());
        }
    }
    labels
}

/// `extensionToolRowLabel`: the extension's label, then the call's main argument, or else
/// its plain values in order.
pub fn extension_tool_row_label(label: &str, input: Option<&Value>) -> String {
    match tool_input_summary(input).or_else(|| scalar_values(input)) {
        Some(detail) if !detail.is_empty() => format!("{label}: {detail}"),
        _ => label.to_string(),
    }
}

fn scalar_values(input: Option<&Value>) -> Option<String> {
    let Some(Value::Object(record)) = input else {
        return None;
    };
    let values: Vec<String> = js::object_keys_in_js_order(record)
        .into_iter()
        .filter_map(|(_, value)| match value {
            Value::String(text) if !js::js_trim(text).is_empty() => Some(text.clone()),
            Value::Number(number) => {
                Some(js::number_to_string(number.as_f64().unwrap_or(f64::NAN)))
            }
            Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        })
        .collect();
    (!values.is_empty()).then(|| truncate(&values.join(" "), 80))
}

/// `toolInputSummary`: the argument a person recognizes the call by, shortened.
pub fn tool_input_summary(input: Option<&Value>) -> Option<String> {
    match input? {
        Value::String(text) => Some(truncate(text, 80)),
        Value::Object(record) => INPUT_SUMMARY_KEYS
            .iter()
            .find_map(|key| match record.get(*key) {
                Some(Value::String(text)) if !js::js_trim(text).is_empty() => {
                    Some(truncate(text, 80))
                }
                _ => None,
            }),
        _ => None,
    }
}

const INPUT_SUMMARY_KEYS: [&str; 10] = [
    "path", "filePath", "query", "q", "url", "command", "text", "prompt", "title", "app",
];

/// `truncate(value, limit)`: white space collapsed, then cut to `limit` UTF-16 units with `…`.
pub fn truncate(value: &str, limit: usize) -> String {
    let collapsed = js::collapse_whitespace(value);
    let normalized = js::js_trim(&collapsed);
    if js::utf16_len(normalized) <= limit {
        return normalized.to_string();
    }
    format!("{}…", js::utf16_prefix(normalized, limit.saturating_sub(1)))
}

/// `truncate(value)` with its default limit.
pub fn truncate_default(value: &str) -> String {
    truncate(value, 160)
}
