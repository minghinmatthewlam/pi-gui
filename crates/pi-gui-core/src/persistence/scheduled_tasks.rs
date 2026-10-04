//! `scheduled-tasks.json` (version 1). Same checks, messages and normalised records as the old
//! `scheduled-task-store.ts`, including `assertScheduledTaskSchedule` and
//! `assertScheduledTaskTarget` from `contracts/scheduled-tasks.ts`.

use super::backup_json::{read_json_with_backup, write_with_backup};
use crate::error::{CoreError, CoreResult};
use crate::js;
use crate::time_zone::{self, host_time_zone, is_time_zone};
use serde_json::{json, Map, Value};
use std::path::Path;

const FILE_VERSION: i64 = 1;
const MAX_RUNS: usize = 40;
const MIN_INTERVAL_MS: i64 = 60_000;
const MAX_INTERVAL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// `{ tasks, recovered }`. A missing file is no tasks.
pub fn read(path: &Path) -> CoreResult<Value> {
    let result = read_json_with_backup(path)?;
    if result.value.is_none() && !result.corrupted {
        return Ok(json!({ "tasks": [], "recovered": false }));
    }
    if result.corrupted && !result.recovered {
        return Err(CoreError::new(format!(
            "Invalid scheduled-tasks at {}; original data was retained. Repair or restore the file before continuing.",
            path.display()
        )));
    }
    let decoded = decode_file(&result.value.unwrap_or(Value::Null))?;
    Ok(json!({ "tasks": decoded["tasks"], "recovered": result.recovered }))
}

pub fn write(path: &Path, tasks: Value) -> CoreResult<()> {
    let payload = json!({ "version": FILE_VERSION, "tasks": tasks });
    let contents = format!("{}\n", js::stringify_pretty(&payload));
    decode_file(&payload)?;
    write_with_backup(path, &contents, |existing| decode_file(existing).map(drop))
}

fn fail<T>(field: &str) -> CoreResult<T> {
    Err(CoreError::new(format!(
        "Invalid scheduled-tasks field {field}; original data was retained."
    )))
}

fn known_keys(record: &Map<String, Value>, keys: &[&str], path: &str) -> CoreResult<()> {
    for (key, _) in js::entries(record) {
        if !keys.contains(&key.as_str()) {
            return fail(&format!("{path}.{key} (unsupported field)"));
        }
    }
    Ok(())
}

fn require_string(value: Option<&Value>, field: &str) -> CoreResult<String> {
    match value.and_then(Value::as_str).map(js::trim) {
        Some(text) if !text.is_empty() => Ok(text.to_owned()),
        _ => fail(field),
    }
}

fn optional_string(value: Option<&Value>, field: &str) -> CoreResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(value) => require_string(Some(value), field).map(Some),
    }
}

pub fn decode_file(value: &Value) -> CoreResult<Value> {
    let Some(record) = value.as_object() else {
        return Err(CoreError::new(
            "Invalid scheduled-tasks: expected an object; original data was retained.",
        ));
    };
    known_keys(record, &["version", "tasks"], "scheduled-tasks")?;
    if record.get("version").and_then(Value::as_f64) != Some(FILE_VERSION as f64) {
        return fail("version");
    }
    let Some(tasks) = record.get("tasks").and_then(Value::as_array) else {
        return fail("tasks");
    };
    let tasks = tasks
        .iter()
        .enumerate()
        .map(|(index, entry)| decode_task(entry, &format!("tasks[{index}]")))
        .collect::<CoreResult<Vec<_>>>()?;
    Ok(json!({ "version": FILE_VERSION, "tasks": tasks }))
}

fn decode_task(value: &Value, path: &str) -> CoreResult<Value> {
    let Some(record) = value.as_object() else {
        return fail(path);
    };
    known_keys(
        record,
        &[
            "id",
            "title",
            "instruction",
            "status",
            "schedule",
            "target",
            "createdAt",
            "updatedAt",
            "nextRunAt",
            "lastRunAt",
            "completedAt",
            "originSessionId",
            "lastError",
            "runs",
        ],
        path,
    )?;
    let get = |key: &str| record.get(key);
    let Some(schedule) = get("schedule").and_then(schedule) else {
        return fail(&format!("{path}.schedule"));
    };
    let Some(target) = get("target").and_then(target) else {
        return fail(&format!("{path}.target"));
    };
    let status = match get("status").and_then(Value::as_str) {
        Some(status @ ("active" | "paused" | "completed")) => status,
        _ => return fail(&format!("{path}.status")),
    };
    let next_run_at = optional_string(get("nextRunAt"), &format!("{path}.nextRunAt"))?;
    let completed_at = optional_string(get("completedAt"), &format!("{path}.completedAt"))?;
    if (status == "active") != next_run_at.is_some() {
        return fail(&format!("{path}.nextRunAt"));
    }
    if (status == "completed") != completed_at.is_some() {
        return fail(&format!("{path}.completedAt"));
    }
    let Some(runs) = get("runs").and_then(Value::as_array) else {
        return fail(&format!("{path}.runs"));
    };
    let runs = runs
        .iter()
        .enumerate()
        .map(|(index, entry)| decode_run(entry, &format!("{path}.runs[{index}]")))
        .collect::<CoreResult<Vec<_>>>()?;
    let mut task = Map::new();
    for key in ["id", "title", "instruction"] {
        task.insert(
            key.into(),
            json!(require_string(get(key), &format!("{path}.{key}"))?),
        );
    }
    task.insert("status".into(), json!(status));
    task.insert("schedule".into(), schedule);
    task.insert("target".into(), target);
    for key in ["createdAt", "updatedAt"] {
        task.insert(
            key.into(),
            json!(require_string(get(key), &format!("{path}.{key}"))?),
        );
    }
    if let Some(next_run_at) = next_run_at {
        task.insert("nextRunAt".into(), json!(next_run_at));
    }
    if let Some(last_run_at) = optional_string(get("lastRunAt"), &format!("{path}.lastRunAt"))? {
        task.insert("lastRunAt".into(), json!(last_run_at));
    }
    if let Some(completed_at) = completed_at {
        task.insert("completedAt".into(), json!(completed_at));
    }
    for key in ["originSessionId", "lastError"] {
        if let Some(text) = optional_string(get(key), &format!("{path}.{key}"))? {
            task.insert(key.into(), json!(text));
        }
    }
    let kept = runs[runs.len().saturating_sub(MAX_RUNS)..].to_vec();
    task.insert("runs".into(), Value::Array(kept));
    Ok(Value::Object(task))
}

fn decode_run(value: &Value, path: &str) -> CoreResult<Value> {
    let Some(record) = value.as_object() else {
        return fail(path);
    };
    known_keys(
        record,
        &[
            "id",
            "sessionId",
            "workspaceId",
            "firedAt",
            "instruction",
            "userMessageId",
            "outcome",
            "error",
        ],
        path,
    )?;
    let outcome = match record.get("outcome").and_then(Value::as_str) {
        Some(outcome @ ("started" | "failed")) => outcome,
        _ => return fail(&format!("{path}.outcome")),
    };
    let mut run = Map::new();
    for key in ["id", "sessionId", "workspaceId", "firedAt", "instruction"] {
        let text = require_string(record.get(key), &format!("{path}.{key}"))?;
        run.insert(key.into(), json!(text));
    }
    if let Some(id) = optional_string(
        record.get("userMessageId"),
        &format!("{path}.userMessageId"),
    )? {
        run.insert("userMessageId".into(), json!(id));
    }
    run.insert("outcome".into(), json!(outcome));
    if let Some(error) = optional_string(record.get("error"), &format!("{path}.error"))? {
        run.insert("error".into(), json!(error));
    }
    Ok(Value::Object(run))
}

/// A whole number within `range`, as `Number.isInteger` and a bounds check would accept it.
fn integer_in(value: Option<&Value>, range: std::ops::RangeInclusive<i64>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && (*range.start() as f64..=*range.end() as f64).contains(&number))
        .then_some(number as i64)
}

/// `assertScheduledTaskSchedule`, normalised the same way: `once` times become
/// `toISOString()` text, weekdays are de-duplicated and sorted, and a missing time zone
/// becomes the computer's.
fn schedule(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    match record.get("kind").and_then(Value::as_str)? {
        "once" => {
            let at = js::trim(record.get("at").and_then(Value::as_str).unwrap_or(""));
            let local = time_zone::host();
            let at = js::date_parse(at, &local).and_then(js::to_iso_string)?;
            Some(json!({ "kind": "once", "at": at }))
        }
        kind @ ("daily" | "weekly") => {
            let time_zone = match record.get("timeZone").and_then(Value::as_str).map(js::trim) {
                Some(zone) if !zone.is_empty() => is_time_zone(zone).then(|| zone.to_owned())?,
                _ => host_time_zone(),
            };
            let hour = integer_in(record.get("hour"), 0..=23)?;
            let minute = integer_in(record.get("minute"), 0..=59)?;
            if kind == "daily" {
                return Some(json!({
                    "kind": "daily", "hour": hour, "minute": minute, "timeZone": time_zone,
                }));
            }
            let entries = record.get("days").and_then(Value::as_array)?;
            if entries.is_empty() {
                return None;
            }
            let mut days = Vec::new();
            for entry in entries {
                let day = weekday(entry)?;
                if !days.contains(&day) {
                    days.push(day);
                }
            }
            days.sort_unstable();
            Some(json!({
                "kind": "weekly", "days": days, "hour": hour, "minute": minute,
                "timeZone": time_zone,
            }))
        }
        "interval" => {
            let every_ms = integer_in(record.get("everyMs"), MIN_INTERVAL_MS..=MAX_INTERVAL_MS)?;
            Some(json!({ "kind": "interval", "everyMs": every_ms }))
        }
        _ => None,
    }
}

/// `parseWeekday`: 0-6, or a day name or abbreviation.
fn weekday(value: &Value) -> Option<i64> {
    if let Some(day) = integer_in(Some(value), 0..=6) {
        return Some(day);
    }
    let name = js::trim(value.as_str()?).to_lowercase();
    let day = match name.as_str() {
        "sun" | "sunday" | "0" => 0,
        "mon" | "monday" | "1" => 1,
        "tue" | "tues" | "tuesday" | "2" => 2,
        "wed" | "wednesday" | "3" => 3,
        "thu" | "thur" | "thurs" | "thursday" | "4" => 4,
        "fri" | "friday" | "5" => 5,
        "sat" | "saturday" | "6" => 6,
        _ => return None,
    };
    Some(day)
}

/// `assertScheduledTaskTarget`.
fn target(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let trimmed = |key: &str| {
        let text = js::trim(record.get(key).and_then(Value::as_str).unwrap_or(""));
        (!text.is_empty()).then(|| text.to_owned())
    };
    let workspace_id = trimmed("workspaceId")?;
    match record.get("kind").and_then(Value::as_str)? {
        "new-thread" => Some(json!({ "kind": "new-thread", "workspaceId": workspace_id })),
        "existing-thread" => Some(json!({
            "kind": "existing-thread",
            "workspaceId": workspace_id,
            "sessionId": trimmed("sessionId")?,
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> Value {
        json!({
            "id": " task-1 ", "title": "Ping", "instruction": "Say ping", "status": "active",
            "schedule": { "kind": "weekly", "days": ["fri", 1, "Mon"], "hour": 9, "minute": 0,
                          "timeZone": "america/new_york" },
            "target": { "kind": "existing-thread", "workspaceId": " ws ", "sessionId": "s" },
            "createdAt": "2026-09-21T12:00:00.000Z", "updatedAt": "2026-09-21T12:00:00.000Z",
            "nextRunAt": "2026-09-21T12:01:00.000Z", "runs": [],
        })
    }

    #[test]
    fn normalises_tasks_like_the_typescript_decoder() {
        let decoded = decode_file(&json!({ "version": 1, "tasks": [task()] })).unwrap();
        assert_eq!(decoded["tasks"][0]["id"], "task-1");
        assert_eq!(
            decoded["tasks"][0]["schedule"],
            json!({ "kind": "weekly", "days": [1, 5], "hour": 9, "minute": 0,
                    "timeZone": "america/new_york" })
        );
        assert_eq!(decoded["tasks"][0]["target"]["workspaceId"], "ws");
        let once = schedule(&json!({ "kind": "once", "at": "2026-09-21T14:00:00+02:00" }));
        assert_eq!(once.unwrap()["at"], "2026-09-21T12:00:00.000Z");
    }

    #[test]
    fn reports_the_failing_field() {
        let mut bad = task();
        bad["schedule"]["timeZone"] = json!("Not/A_Zone");
        let error = decode_file(&json!({ "version": 1, "tasks": [bad] })).unwrap_err();
        assert_eq!(
            error.message,
            "Invalid scheduled-tasks field tasks[0].schedule; original data was retained."
        );
        let mut paused = task();
        paused["status"] = json!("paused");
        let error = decode_file(&json!({ "version": 1, "tasks": [paused] })).unwrap_err();
        assert!(error.message.contains("tasks[0].nextRunAt"));
        let error = decode_file(&json!({ "version": 1, "tasks": [], "x": 1 })).unwrap_err();
        assert!(error
            .message
            .contains("scheduled-tasks.x (unsupported field)"));
    }
}
