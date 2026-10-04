//! Twin of `apps/desktop/electron/scheduled-tasks/scheduled-task-schedule.ts`: when a
//! scheduled task runs next. Wall-clock times are found the same way the TypeScript does
//! (guess, read the zone's clock, correct up to four times), so skipped and repeated hours at
//! daylight-saving changes land on the same instant.

use crate::error::{CoreError, CoreResult};

use super::desktop_state::ScheduledTaskSchedule;
use super::env::StateEnv;
use super::js;

struct ZonedParts {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    /// 0 is Sunday.
    weekday: i64,
}

fn time_zone(name: &str) -> CoreResult<jiff::tz::TimeZone> {
    jiff::tz::TimeZone::get(name)
        .map_err(|_| CoreError::named("RangeError", format!("Invalid time zone specified: {name}")))
}

fn invalid_time() -> CoreError {
    CoreError::named("RangeError", "Invalid time value")
}

/// `zonedParts`: the wall clock in `zone` at `ms`, to the minute.
fn zoned_parts(ms: f64, zone: &jiff::tz::TimeZone) -> CoreResult<ZonedParts> {
    let timestamp = jiff::Timestamp::from_millisecond(ms as i64).map_err(|_| invalid_time())?;
    let zoned = timestamp.to_zoned(zone.clone());
    Ok(ZonedParts {
        year: i64::from(zoned.year()),
        month: i64::from(zoned.month()),
        day: i64::from(zoned.day()),
        hour: i64::from(zoned.hour()),
        minute: i64::from(zoned.minute()),
        weekday: i64::from(zoned.weekday().to_sunday_zero_offset()),
    })
}

fn zoned_wall_time_to_utc(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    zone: &jiff::tz::TimeZone,
) -> CoreResult<f64> {
    let wanted = js::date_utc(year, month, day, hour, minute);
    let mut utc = wanted;
    for _ in 0..4 {
        let parts = zoned_parts(utc, zone)?;
        let as_utc = js::date_utc(parts.year, parts.month, parts.day, parts.hour, parts.minute);
        let delta = wanted - as_utc;
        if delta == 0.0 {
            break;
        }
        utc += delta;
    }
    Ok(utc)
}

fn add_days(year: i64, month: i64, day: i64, days: i64) -> (i64, i64, i64) {
    js::civil_from_days(js::days_from_civil(year, month, day) + days)
}

fn next_wall_clock_after(
    from_ms: f64,
    hour: i64,
    minute: i64,
    zone: &jiff::tz::TimeZone,
    allowed_weekdays: Option<&[i64]>,
) -> CoreResult<f64> {
    let parts = zoned_parts(from_ms, zone)?;
    for offset in 0..=14 {
        let (year, month, day) = add_days(parts.year, parts.month, parts.day, offset);
        if let Some(allowed) = allowed_weekdays.filter(|allowed| !allowed.is_empty()) {
            if !allowed.contains(&((parts.weekday + offset) % 7)) {
                continue;
            }
        }
        let instant = zoned_wall_time_to_utc(year, month, day, hour, minute, zone)?;
        if instant > from_ms {
            return Ok(instant);
        }
    }
    let (year, month, day) = add_days(parts.year, parts.month, parts.day, 1);
    zoned_wall_time_to_utc(year, month, day, hour, minute, zone)
}

/// `nextRunAt`: the next run strictly after `from_ms`, or `None` for a one-off whose time has
/// passed. Errors where the TypeScript throws (an unknown time zone, a time out of range).
pub fn next_run_at(
    env: &dyn StateEnv,
    schedule: &ScheduledTaskSchedule,
    from_ms: f64,
) -> CoreResult<Option<String>> {
    let iso = |ms: f64| js::to_iso_string(ms).ok_or_else(invalid_time);
    match schedule {
        ScheduledTaskSchedule::Once { at } => {
            let at = env.date_parse(at);
            if at.is_nan() || at <= from_ms {
                return Ok(None);
            }
            iso(at).map(Some)
        }
        ScheduledTaskSchedule::Interval { every_ms } => iso(from_ms + every_ms.0).map(Some),
        ScheduledTaskSchedule::Daily {
            hour,
            minute,
            time_zone: name,
        } => {
            let zone = time_zone(name)?;
            iso(next_wall_clock_after(
                from_ms,
                hour.0 as i64,
                minute.0 as i64,
                &zone,
                None,
            )?)
            .map(Some)
        }
        ScheduledTaskSchedule::Weekly {
            days,
            hour,
            minute,
            time_zone: name,
        } => {
            let zone = time_zone(name)?;
            let days: Vec<i64> = days.iter().map(|day| day.0 as i64).collect();
            iso(next_wall_clock_after(
                from_ms,
                hour.0 as i64,
                minute.0 as i64,
                &zone,
                Some(&days),
            )?)
            .map(Some)
        }
    }
}

/// The fields `earliestScheduledWakeAt` reads from each task.
pub struct ScheduledWake<'a> {
    pub status: &'a str,
    pub next_run_at: Option<&'a str>,
}

/// `earliestScheduledWakeAt`: when the scheduler should next wake, never earlier than now.
pub fn earliest_scheduled_wake_at(
    env: &dyn StateEnv,
    tasks: &[ScheduledWake<'_>],
    now_ms: f64,
) -> Option<String> {
    let mut earliest: Option<&str> = None;
    for task in tasks {
        let Some(next_run_at) = task.next_run_at.filter(|at| !at.is_empty()) else {
            continue;
        };
        if task.status != "active" {
            continue;
        }
        let at = env.date_parse(next_run_at);
        if at.is_nan() {
            continue;
        }
        if earliest.is_none_or(|earliest| at < env.date_parse(earliest)) {
            earliest = Some(next_run_at);
        }
    }
    let earliest = earliest?;
    if env.date_parse(earliest) < now_ms {
        js::to_iso_string(now_ms)
    } else {
        Some(earliest.to_string())
    }
}
