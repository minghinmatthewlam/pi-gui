//! `scheduled-tasks.json` (version 1). Same checks, messages and normalised records as the old
//! `scheduled-task-store.ts`, including `assertScheduledTaskSchedule` and
//! `assertScheduledTaskTarget` from `contracts/scheduled-tasks.ts`.

use super::backup_json::{read_json_with_backup, write_with_backup};
use crate::error::{CoreError, CoreResult};
use crate::js;
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
            let ms = js::date_parse(at).filter(|_| !at.is_empty())?;
            Some(json!({ "kind": "once", "at": js::to_iso_string(ms) }))
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

/// Whether `Intl.DateTimeFormat` accepts `name` as a time zone: an IANA name or link in any
/// letter case, one of the older ids ICU still knows, or a fixed offset such as `+05:30`.
pub fn is_time_zone(name: &str) -> bool {
    chrono_tz::Tz::from_str_insensitive(name).is_ok()
        || ICU_ONLY_ZONES
            .iter()
            .any(|zone| zone.eq_ignore_ascii_case(name))
        || is_offset_zone(name)
}

/// Ids ICU (and so V8) accepts that the IANA database no longer lists.
const ICU_ONLY_ZONES: [&str; 40] = [
    "ACT",
    "AET",
    "AGT",
    "ART",
    "AST",
    "BET",
    "BST",
    "CAT",
    "CNT",
    "CST",
    "CTT",
    "EAT",
    "ECT",
    "IET",
    "IST",
    "JST",
    "MIT",
    "NET",
    "NST",
    "PLT",
    "PNT",
    "PRT",
    "PST",
    "SST",
    "VST",
    "SystemV/AST4",
    "SystemV/AST4ADT",
    "SystemV/CST6",
    "SystemV/CST6CDT",
    "SystemV/EST5",
    "SystemV/EST5EDT",
    "SystemV/HST10",
    "SystemV/MST7",
    "SystemV/MST7MDT",
    "SystemV/PST8",
    "SystemV/PST8PDT",
    "SystemV/YST9",
    "SystemV/YST9YDT",
    "Canada/East-Saskatchewan",
    "US/Pacific-New",
];

/// `+05`, `+0530`, `+05:30` or `−05:30` (with a minus sign), up to 23:59 either way.
fn is_offset_zone(name: &str) -> bool {
    let Some(rest) = ["+", "-", "\u{2212}"]
        .iter()
        .find_map(|sign| name.strip_prefix(sign))
    else {
        return false;
    };
    let digits: Vec<u8> = rest.bytes().collect();
    let two = |at: usize, max: u8| {
        digits.get(at..at + 2).is_some_and(|pair| {
            pair.iter().all(u8::is_ascii_digit) && (pair[0] - b'0') * 10 + (pair[1] - b'0') <= max
        })
    };
    match digits.len() {
        2 => two(0, 23),
        4 => two(0, 23) && two(2, 59),
        5 => two(0, 23) && digits[2] == b':' && two(3, 59),
        _ => false,
    }
}

/// `hostTimeZone()`: the computer's zone (from `TZ` or the system setting), else UTC, spelled
/// the way Intl reports it: ICU still prefers some older names (`Asia/Calcutta` for
/// `Asia/Kolkata`). A system zone set through an alias such as `US/Eastern` keeps that name.
fn host_time_zone() -> String {
    let zone = std::env::var("TZ")
        .ok()
        .map(|zone| zone.trim_start_matches(':').to_owned())
        .filter(|zone| chrono_tz::Tz::from_str_insensitive(zone).is_ok())
        .or_else(|| iana_time_zone::get_timezone().ok())
        .filter(|zone| is_time_zone(zone))
        .unwrap_or_else(|| "UTC".into());
    ICU_PREFERRED_NAMES
        .iter()
        .find(|(name, _)| *name == zone)
        .map_or(zone, |(_, preferred)| (*preferred).to_owned())
}

/// IANA zones whose name ICU reports differently.
const ICU_PREFERRED_NAMES: [(&str, &str); 36] = [
    ("Africa/Asmara", "Africa/Asmera"),
    ("America/Argentina/Buenos_Aires", "America/Buenos_Aires"),
    ("America/Argentina/Catamarca", "America/Catamarca"),
    ("America/Argentina/Cordoba", "America/Cordoba"),
    ("America/Argentina/Jujuy", "America/Jujuy"),
    ("America/Argentina/Mendoza", "America/Mendoza"),
    ("America/Atikokan", "America/Coral_Harbour"),
    ("America/Indiana/Indianapolis", "America/Indianapolis"),
    ("America/Kentucky/Louisville", "America/Louisville"),
    ("America/Nuuk", "America/Godthab"),
    ("Asia/Ho_Chi_Minh", "Asia/Saigon"),
    ("Asia/Kathmandu", "Asia/Katmandu"),
    ("Asia/Kolkata", "Asia/Calcutta"),
    ("Asia/Yangon", "Asia/Rangoon"),
    ("Atlantic/Faroe", "Atlantic/Faeroe"),
    ("CET", "Europe/Brussels"),
    ("CST6CDT", "America/Chicago"),
    ("EET", "Europe/Athens"),
    ("EST", "America/Panama"),
    ("EST5EDT", "America/New_York"),
    ("Etc/GMT", "UTC"),
    ("Etc/Greenwich", "UTC"),
    ("Etc/UCT", "UTC"),
    ("Etc/UTC", "UTC"),
    ("Etc/Universal", "UTC"),
    ("Etc/Zulu", "UTC"),
    ("Europe/Kyiv", "Europe/Kiev"),
    ("HST", "Pacific/Honolulu"),
    ("MET", "Europe/Brussels"),
    ("MST", "America/Phoenix"),
    ("MST7MDT", "America/Denver"),
    ("PST8PDT", "America/Los_Angeles"),
    ("Pacific/Chuuk", "Pacific/Truk"),
    ("Pacific/Kanton", "Pacific/Enderbury"),
    ("Pacific/Pohnpei", "Pacific/Ponape"),
    ("WET", "Europe/Lisbon"),
];

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

    #[test]
    fn accepts_the_time_zones_intl_does() {
        for zone in [
            "UTC",
            "utc",
            "Etc/GMT+5",
            "US/Eastern",
            "Asia/Calcutta",
            "PST",
            "+05:30",
        ] {
            assert!(is_time_zone(zone), "{zone}");
        }
        for zone in [
            "Not/A_Zone",
            "GMT+5",
            "Etc/GMT+13",
            "+24:00",
            "+5:00",
            "",
            "Factory",
        ] {
            assert!(!is_time_zone(zone), "{zone}");
        }
    }
}
