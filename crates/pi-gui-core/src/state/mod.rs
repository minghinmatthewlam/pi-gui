//! The app state, moving over from Electron main: serde mirrors of the renderer's contracts
//! and pi's session events, and Rust twins of the pure functions that build the state and
//! transcripts from them. Nothing here is wired to a call yet; the golden tests in
//! `tests/state_fixtures.rs` replay the TypeScript functions' recorded output against it.
//!
//! Function names are the TypeScript names in snake_case, so a later port can map them.

pub mod app_store_utils;
pub mod desktop_state;
pub mod driver;
pub mod env;
pub mod extension_command_compatibility;
pub mod js;
pub mod scheduled_task_schedule;
pub mod session_state;
pub mod session_state_map;
pub mod timeline;
pub mod timeline_types;
pub mod tool_labels;

use serde::{Deserialize, Deserializer};

/// For optional fields that may hold any JSON: absent is `None`, but `null` is kept as
/// `Some(Value::Null)`, because the TypeScript tells `undefined` and `null` apart there.
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
