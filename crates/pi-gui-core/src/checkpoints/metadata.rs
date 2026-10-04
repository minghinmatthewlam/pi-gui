//! `turn-checkpoints/checkpoints.json`: one record per turn interval. Same shape and the same
//! strict checks as `decodeMetadata` in the TypeScript store this replaces, so an existing
//! user's file loads unchanged and a file this version does not understand is never rewritten.

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub workspace_id: String,
    pub session_id: String,
}

impl Target {
    /// One task's key for the in-memory maps.
    pub fn key(&self) -> (String, String) {
        (self.workspace_id.clone(), self.session_id.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Coverage {
    /// `complete` or `partial`.
    pub state: String,
    pub notes: Vec<String>,
}

impl Coverage {
    pub fn complete() -> Self {
        Self {
            state: "complete".into(),
            notes: Vec::new(),
        }
    }

    pub fn partial(notes: Vec<String>) -> Self {
        Self {
            state: "partial".into(),
            notes,
        }
    }
}

/// One snapshot of a checkout, or why there is none. Field order matches the TypeScript
/// objects, so a rewritten file reads the same.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Capture {
    #[serde(rename_all = "camelCase")]
    Available {
        tree_oid: String,
        captured_at: String,
        coverage: Coverage,
        file_count: u64,
        byte_count: u64,
        duration_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Unavailable {
        code: String,
        message: String,
        captured_at: String,
        coverage: Coverage,
        file_count: u64,
        byte_count: u64,
        duration_ms: u64,
    },
}

impl Capture {
    /// A capture that did not happen, stamped now.
    pub fn unavailable(code: &str, message: &str) -> Self {
        Capture::Unavailable {
            code: code.into(),
            message: message.into(),
            captured_at: super::iso_now(),
            coverage: Coverage::partial(vec![message.into()]),
            file_count: 0,
            byte_count: 0,
            duration_ms: 0,
        }
    }

    pub fn tree_oid(&self) -> Option<&str> {
        match self {
            Capture::Available { tree_oid, .. } => Some(tree_oid),
            Capture::Unavailable { .. } => None,
        }
    }

    pub fn is_aborted(&self) -> bool {
        matches!(self, Capture::Unavailable { code, .. } if code == "capture-aborted")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Open,
    Completed,
    Stopped,
    Failed,
    Interrupted,
}

impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Open => "open",
            Outcome::Completed => "completed",
            Outcome::Stopped => "stopped",
            Outcome::Failed => "failed",
            Outcome::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub checkpoint_id: String,
    pub target: Target,
    pub checkout_id: String,
    pub checkout_path: String,
    pub runtime_generation: String,
    pub run_id: String,
    pub started_at: String,
    pub updated_at: String,
    pub before_entry_id: Option<String>,
    pub user_entry_ids: Vec<String>,
    pub assistant_entry_ids: Vec<String>,
    pub last_entry_id: Option<String>,
    pub outcome: Outcome,
    pub before: Capture,
    pub after: Option<Capture>,
    pub overlaps: Vec<String>,
}

#[derive(Serialize)]
struct Metadata<'a> {
    version: u8,
    records: Vec<&'a Record>,
}

/// The file's text: compact JSON and a newline, like `JSON.stringify(metadata)` + "\n".
/// Checked with the same rules as a read first, so the app never writes a file it would
/// refuse to load.
pub fn encode<'a>(records: impl Iterator<Item = &'a Record>) -> CoreResult<String> {
    let metadata = Metadata {
        version: 1,
        records: records.collect(),
    };
    let value = serde_json::to_value(&metadata)
        .map_err(|error| CoreError::new(format!("Could not encode checkpoints: {error}")))?;
    decode(&value)?;
    let mut text = value.to_string();
    text.push('\n');
    Ok(text)
}

const INVALID: &str = "Invalid checkpoint metadata; original data retained.";

pub fn decode(value: &Value) -> CoreResult<Vec<Record>> {
    let root = object(value, &["version", "records"])?;
    let records = match (root.get("version"), root.get("records")) {
        (Some(version), Some(Value::Array(records))) if version.as_f64() == Some(1.0) => records,
        _ => {
            return Err(CoreError::new(
                "Unsupported checkpoint metadata; original data retained.",
            ))
        }
    };
    let records = records
        .iter()
        .map(decode_record)
        .collect::<CoreResult<Vec<_>>>()?;
    let mut ids = std::collections::HashSet::new();
    if !records
        .iter()
        .all(|record| ids.insert(&record.checkpoint_id))
    {
        return Err(CoreError::new("Duplicate checkpoint identity."));
    }
    Ok(records)
}

fn decode_record(value: &Value) -> CoreResult<Record> {
    let record = object(
        value,
        &[
            "checkpointId",
            "target",
            "checkoutId",
            "checkoutPath",
            "runtimeGeneration",
            "runId",
            "startedAt",
            "updatedAt",
            "beforeEntryId",
            "userEntryIds",
            "assistantEntryIds",
            "lastEntryId",
            "outcome",
            "before",
            "after",
            "overlaps",
        ],
    )?;
    let field = |name: &str| record.get(name).unwrap_or(&Value::Null);
    let target = object(field("target"), &["workspaceId", "sessionId"])?;
    let outcome = match field("outcome").as_str() {
        Some("open") => Outcome::Open,
        Some("completed") => Outcome::Completed,
        Some("stopped") => Outcome::Stopped,
        Some("failed") => Outcome::Failed,
        Some("interrupted") => Outcome::Interrupted,
        _ => return Err(CoreError::new("Invalid checkpoint outcome.")),
    };
    // Checked in the TypeScript order, so a file with several problems reports the same one.
    let checkpoint_id = text(Some(field("checkpointId")))?;
    let target = Target {
        workspace_id: text(target.get("workspaceId"))?,
        session_id: text(target.get("sessionId"))?,
    };
    let checkout_id = text(Some(field("checkoutId")))?;
    let checkout_path = text(Some(field("checkoutPath")))?;
    let runtime_generation = text(Some(field("runtimeGeneration")))?;
    let run_id = text(Some(field("runId")))?;
    let started_at = text(Some(field("startedAt")))?;
    let updated_at = text(Some(field("updatedAt")))?;
    let before_entry_id = nullable_text(record.get("beforeEntryId"))?;
    let last_entry_id = nullable_text(record.get("lastEntryId"))?;
    Ok(Record {
        checkpoint_id,
        target,
        checkout_id,
        checkout_path,
        runtime_generation,
        run_id,
        started_at,
        updated_at,
        before_entry_id,
        user_entry_ids: texts(field("userEntryIds"))?,
        assistant_entry_ids: texts(field("assistantEntryIds"))?,
        overlaps: texts(field("overlaps"))?,
        last_entry_id,
        outcome,
        before: decode_capture(field("before"))?,
        after: match record.get("after") {
            Some(Value::Null) => None,
            other => Some(decode_capture(other.unwrap_or(&Value::Null))?),
        },
    })
}

fn decode_capture(value: &Value) -> CoreResult<Capture> {
    let record = object(
        value,
        &[
            "state",
            "treeOid",
            "capturedAt",
            "coverage",
            "fileCount",
            "byteCount",
            "durationMs",
            "code",
            "message",
        ],
    )?;
    let field = |name: &str| record.get(name).unwrap_or(&Value::Null);
    let coverage = object(field("coverage"), &["state", "notes"])?;
    let state = match coverage.get("state").and_then(Value::as_str) {
        Some(state @ ("complete" | "partial")) => state.to_owned(),
        _ => return Err(CoreError::new("Invalid checkpoint coverage.")),
    };
    let coverage = Coverage {
        state,
        notes: texts(coverage.get("notes").unwrap_or(&Value::Null))?,
    };
    let captured_at = text(Some(field("capturedAt")))?;
    let file_count = number(field("fileCount"))?;
    let byte_count = number(field("byteCount"))?;
    let duration_ms = number(field("durationMs"))?;
    if field("state") == "unavailable" {
        return Ok(Capture::Unavailable {
            code: text(Some(field("code")))?,
            message: text(Some(field("message")))?,
            captured_at,
            coverage,
            file_count,
            byte_count,
            duration_ms,
        });
    }
    match field("state").as_str().zip(field("treeOid").as_str()) {
        Some(("available", tree_oid)) if is_object_id(tree_oid) => Ok(Capture::Available {
            tree_oid: tree_oid.to_owned(),
            captured_at,
            coverage,
            file_count,
            byte_count,
            duration_ms,
        }),
        _ => Err(CoreError::new("Invalid checkpoint capture.")),
    }
}

/// A 40-character lowercase SHA-1 object id.
pub fn is_object_id(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn object<'a>(value: &'a Value, keys: &[&str]) -> CoreResult<&'a Map<String, Value>> {
    match value {
        Value::Object(map) if map.keys().all(|key| keys.contains(&key.as_str())) => Ok(map),
        _ => Err(CoreError::new(INVALID)),
    }
}

fn text(value: Option<&Value>) -> CoreResult<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() && !text.contains('\0') => Ok(text.clone()),
        _ => Err(CoreError::new("Invalid checkpoint reference.")),
    }
}

/// `null` stays `null`; a missing field is invalid, as `record.x === null` is false for it.
fn nullable_text(value: Option<&Value>) -> CoreResult<Option<String>> {
    match value {
        Some(Value::Null) => Ok(None),
        other => text(other).map(Some),
    }
}

fn texts(value: &Value) -> CoreResult<Vec<String>> {
    match value {
        Value::Array(items) => items.iter().map(|item| text(Some(item))).collect(),
        _ => Err(CoreError::new("Invalid checkpoint references.")),
    }
}

/// A non-negative safe integer, as `Number.isSafeInteger`; `3.0` counts as `3`.
fn number(value: &Value) -> CoreResult<u64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let invalid = || CoreError::new("Invalid checkpoint metric.");
    match value {
        Value::Number(number) => match number.as_u64() {
            Some(whole) if whole as f64 <= MAX_SAFE => Ok(whole),
            Some(_) => Err(invalid()),
            None => match number.as_f64() {
                Some(float) if float.fract() == 0.0 && (0.0..=MAX_SAFE).contains(&float) => {
                    Ok(float as u64)
                }
                _ => Err(invalid()),
            },
        },
        _ => Err(invalid()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn capture() -> Value {
        json!({
            "state": "available",
            "treeOid": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "capturedAt": "2026-09-22T12:00:00.000Z",
            "coverage": { "state": "complete", "notes": [] },
            "fileCount": 1, "byteCount": 2, "durationMs": 3
        })
    }

    fn record() -> Value {
        json!({
            "checkpointId": "one",
            "target": { "workspaceId": "w", "sessionId": "s" },
            "checkoutId": "w", "checkoutPath": "/repo",
            "runtimeGeneration": "g", "runId": "r",
            "startedAt": "2026-09-22T12:00:00.000Z", "updatedAt": "2026-09-22T12:00:01.000Z",
            "beforeEntryId": null, "userEntryIds": ["u"], "assistantEntryIds": [],
            "lastEntryId": null, "outcome": "completed",
            "before": capture(), "after": capture(), "overlaps": []
        })
    }

    #[test]
    fn a_saved_file_round_trips_to_the_same_json() {
        let file = json!({ "version": 1, "records": [record()] });
        let records = decode(&file).unwrap();
        let text = encode(records.iter()).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), file);
        assert!(text.ends_with("}\n") && !text.contains("\n "));
    }

    #[test]
    fn rejects_what_the_typescript_store_rejected() {
        let cases = [
            (json!({ "version": 2, "records": [] }), "Unsupported"),
            (
                json!({ "version": 1, "records": [], "x": 1 }),
                "Invalid checkpoint metadata",
            ),
            (
                json!({ "version": 1, "records": [record(), record()] }),
                "Duplicate",
            ),
        ];
        for (file, message) in cases {
            assert!(
                decode(&file).unwrap_err().message.contains(message),
                "{file}"
            );
        }
        let mut bad = record();
        bad["before"]["fileCount"] = json!(-1);
        let error = decode(&json!({ "version": 1, "records": [bad] })).unwrap_err();
        assert_eq!(error.message, "Invalid checkpoint metric.");
        let mut bad = record();
        bad["after"]["treeOid"] = json!("ABC");
        let error = decode(&json!({ "version": 1, "records": [bad] })).unwrap_err();
        assert_eq!(error.message, "Invalid checkpoint capture.");
        let mut bad = record();
        bad["runId"] = json!("");
        let error = decode(&json!({ "version": 1, "records": [bad] })).unwrap_err();
        assert_eq!(error.message, "Invalid checkpoint reference.");
    }
}
