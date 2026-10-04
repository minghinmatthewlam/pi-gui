//! The clock, ids and time zone the state code reads. The TypeScript twins call
//! `new Date()`, `randomUUID()` and `toLocaleTimeString` directly; here they come from one
//! place so tests can pin them.

use std::cell::Cell;

use crate::js;

pub trait StateEnv {
    /// `Date.now()`.
    fn now_ms(&self) -> f64;
    /// `randomUUID()`.
    fn random_uuid(&self) -> String;
    /// The time zone `toLocaleTimeString` and `Date.parse` use for local times.
    fn time_zone(&self) -> &jiff::tz::TimeZone;

    /// `new Date().toISOString()`.
    fn now_iso(&self) -> String {
        js::to_iso_string(self.now_ms()).unwrap_or_default()
    }

    /// `Date.parse(text)`.
    fn date_parse(&self, text: &str) -> f64 {
        js::date_parse(text, self.time_zone()).unwrap_or(f64::NAN)
    }
}

/// The real clock, random v4 ids and the computer's time zone.
pub struct SystemEnv {
    time_zone: jiff::tz::TimeZone,
}

impl SystemEnv {
    pub fn new() -> Self {
        Self {
            time_zone: jiff::tz::TimeZone::system(),
        }
    }
}

impl Default for SystemEnv {
    fn default() -> Self {
        Self::new()
    }
}

impl StateEnv for SystemEnv {
    fn now_ms(&self) -> f64 {
        jiff::Timestamp::now().as_millisecond() as f64
    }

    fn random_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn time_zone(&self) -> &jiff::tz::TimeZone {
        &self.time_zone
    }
}

/// A clock that stands still until moved, ids numbered from 1, and UTC. For tests and for
/// replaying recorded event streams.
pub struct FixedEnv {
    now_ms: Cell<f64>,
    next_id: Cell<u64>,
    time_zone: jiff::tz::TimeZone,
}

impl FixedEnv {
    pub fn new(now_iso: &str) -> Self {
        let env = Self {
            now_ms: Cell::new(0.0),
            next_id: Cell::new(1),
            time_zone: jiff::tz::TimeZone::UTC,
        };
        env.set_now(now_iso);
        env
    }

    pub fn set_now(&self, now_iso: &str) {
        self.now_ms.set(self.date_parse(now_iso));
    }
}

impl StateEnv for FixedEnv {
    fn now_ms(&self) -> f64 {
        self.now_ms.get()
    }

    fn random_uuid(&self) -> String {
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        format!("00000000-0000-4000-8000-{id:012x}")
    }

    fn time_zone(&self) -> &jiff::tz::TimeZone {
        &self.time_zone
    }
}
