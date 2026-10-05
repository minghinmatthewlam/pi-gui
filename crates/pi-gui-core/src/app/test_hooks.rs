//! What specs reach in test mode: the session-visibility override
//! (`__PI_APP_TEST_SESSION_VISIBILITY__`) and the invoke controls the Electron helpers install
//! over `ipcMain` handlers (`installIpcInvokeControl`), keyed by channel the same way.

use super::dispatch::Reply;
use super::methods::{self, Kind};
use crate::error::{CoreError, CoreResult};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

/// `HYDRATE_TEST_SENTINEL` in `tests/helpers/electron-app.ts`.
pub const DEFAULT_SENTINEL: &str = "hydrate-test-sentinel-token=/private/secret-path";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlMode {
    Passthrough,
    Reject,
    Replace,
    Record,
}

impl ControlMode {
    pub fn parse(text: &str) -> CoreResult<Self> {
        Ok(match text {
            "passthrough" => Self::Passthrough,
            "reject" => Self::Reject,
            "replace" => Self::Replace,
            "record" => Self::Record,
            other => {
                return Err(CoreError::new(format!(
                    "Unknown invoke control mode: {other}"
                )))
            }
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Passthrough => "passthrough",
            Self::Reject => "reject",
            Self::Replace => "replace",
            Self::Record => "record",
        }
    }
}

struct InvokeControl {
    mode: ControlMode,
    invoke_count: u64,
    reject_count: u64,
    sentinel: String,
    /// `None` is `undefined`.
    replacement: Option<Value>,
}

#[derive(Default)]
pub struct TestControls {
    /// `Some(true)` is "active", `Some(false)` "inactive".
    session_visibility: Cell<Option<bool>>,
    controls: RefCell<HashMap<&'static str, InvokeControl>>,
}

impl TestControls {
    pub fn session_visibility(&self) -> Option<bool> {
        self.session_visibility.get()
    }

    /// `"active" | "inactive" | undefined`.
    pub fn set_session_visibility(&self, value: Option<&str>) -> CoreResult<()> {
        self.session_visibility.set(match value {
            None => None,
            Some("active") => Some(true),
            Some("inactive") => Some(false),
            Some(other) => {
                return Err(CoreError::new(format!(
                    "Unknown session visibility override: {other}"
                )))
            }
        });
        Ok(())
    }

    /// `installIpcInvokeControl`: only channels answered by `ipcMain.handle` can be controlled.
    pub fn install(
        &self,
        channel: &str,
        mode: ControlMode,
        sentinel: Option<String>,
        replacement: Option<Value>,
    ) -> CoreResult<()> {
        let Some(method) = methods::by_channel(channel).filter(|method| is_invoked(method.kind))
        else {
            return Err(CoreError::new(format!(
                "No IPC handler registered for {channel}"
            )));
        };
        let sentinel = sentinel.unwrap_or_else(|| DEFAULT_SENTINEL.to_owned());
        let mut controls = self.controls.borrow_mut();
        match controls.get_mut(method.channel) {
            Some(existing) => {
                existing.mode = mode;
                existing.sentinel = sentinel;
                existing.replacement = replacement;
            }
            None => {
                controls.insert(
                    method.channel,
                    InvokeControl {
                        mode,
                        invoke_count: 0,
                        reject_count: 0,
                        sentinel,
                        replacement,
                    },
                );
            }
        }
        Ok(())
    }

    /// `setIpcInvokeControl`: fields left out keep their value.
    pub fn set(
        &self,
        channel: &str,
        mode: Option<ControlMode>,
        replacement: Option<Value>,
    ) -> CoreResult<()> {
        let mut controls = self.controls.borrow_mut();
        let control = controls
            .get_mut(channel)
            .ok_or_else(|| not_installed(channel))?;
        if let Some(mode) = mode {
            control.mode = mode;
        }
        if replacement.is_some() {
            control.replacement = replacement;
        }
        Ok(())
    }

    /// `readIpcInvokeControl`.
    pub fn read(&self, channel: &str) -> CoreResult<Value> {
        let controls = self.controls.borrow();
        let control = controls
            .get(channel)
            .ok_or_else(|| not_installed(channel))?;
        Ok(json!({
            "mode": control.mode.name(),
            "invokeCount": control.invoke_count,
            "rejectCount": control.reject_count,
            "sentinel": control.sentinel,
        }))
    }

    /// Runs before a handler: `Some` answers the call in its place.
    pub fn control_invoke(&self, channel: &str) -> CoreResult<Option<Reply>> {
        let mut controls = self.controls.borrow_mut();
        let Some(control) = controls.get_mut(channel) else {
            return Ok(None);
        };
        control.invoke_count += 1;
        match control.mode {
            ControlMode::Passthrough => Ok(None),
            ControlMode::Reject => {
                control.reject_count += 1;
                Err(CoreError::new(control.sentinel.clone()))
            }
            ControlMode::Replace => Ok(Some(match &control.replacement {
                Some(value) => Reply::Value(value.clone()),
                None => Reply::Undefined,
            })),
            ControlMode::Record => Ok(Some(Reply::Undefined)),
        }
    }
}

fn is_invoked(kind: Kind) -> bool {
    !matches!(kind, Kind::Send | Kind::Sync)
}

fn not_installed(channel: &str) -> CoreError {
    CoreError::new(format!("No IPC invoke control installed for {channel}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_count_and_answer_like_the_electron_helper() {
        let controls = TestControls::default();
        assert_eq!(
            controls
                .install("pi-gui:no-such", ControlMode::Reject, None, None)
                .unwrap_err()
                .message,
            "No IPC handler registered for pi-gui:no-such"
        );
        let channel = methods::by_api("selectSession").unwrap().channel;
        assert!(controls.read(channel).is_err());
        controls
            .install(channel, ControlMode::Reject, None, None)
            .unwrap();
        let error = controls.control_invoke(channel).unwrap_err();
        assert_eq!(error.message, DEFAULT_SENTINEL);
        controls
            .set(channel, Some(ControlMode::Replace), Some(json!(7)))
            .unwrap();
        assert!(matches!(
            controls.control_invoke(channel).unwrap(),
            Some(Reply::Value(value)) if value == json!(7)
        ));
        controls
            .set(channel, Some(ControlMode::Passthrough), None)
            .unwrap();
        assert!(controls.control_invoke(channel).unwrap().is_none());
        let read = controls.read(channel).unwrap();
        assert_eq!(read["invokeCount"], 3);
        assert_eq!(read["rejectCount"], 1);
        assert_eq!(read["mode"], "passthrough");
    }
}
