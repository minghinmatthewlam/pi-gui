//! What specs reach in test mode: the session-visibility override
//! (`__PI_APP_TEST_SESSION_VISIBILITY__`) and the invoke controls the Electron helpers install
//! over `ipcMain` handlers (`installIpcInvokeControl`), keyed by channel the same way: a
//! controlled channel can also hold its requests, delay them, or run them one at a time with
//! other channels in a named queue.

use super::dispatch::Reply;
use super::methods::{self, Kind};
use crate::error::{CoreError, CoreResult};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex, Notify};

/// `HYDRATE_TEST_SENTINEL` in `tests/helpers/electron-app.ts`.
pub const DEFAULT_SENTINEL: &str = "hydrate-test-sentinel-token=/private/secret-path";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlMode {
    Passthrough,
    Reject,
    Replace,
    Record,
    /// Waits for `release`, then runs the real handler.
    Hold,
}

impl ControlMode {
    pub fn parse(text: &str) -> CoreResult<Self> {
        Ok(match text {
            "passthrough" => Self::Passthrough,
            "reject" => Self::Reject,
            "replace" => Self::Replace,
            "record" => Self::Record,
            "hold" => Self::Hold,
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
            Self::Hold => "hold",
        }
    }
}

struct InvokeControl {
    mode: ControlMode,
    invoke_count: u64,
    reject_count: u64,
    /// Each request's arguments, `undefined` as null, in arrival order.
    args: Vec<Value>,
    sentinel: String,
    /// `None` is `undefined`.
    replacement: Option<Value>,
    delay_ms: Option<u64>,
    queue: Option<String>,
    held: Vec<oneshot::Sender<()>>,
    /// Requests taken and not yet answered, and who waits for none to be left.
    in_flight: u64,
    settled: Rc<Notify>,
}

#[derive(Default)]
pub struct TestControls {
    /// `Some(true)` is "active", `Some(false)` "inactive".
    session_visibility: Cell<Option<bool>>,
    controls: RefCell<HashMap<&'static str, InvokeControl>>,
    /// Named queues: requests on channels sharing one run one at a time, in arrival order.
    queues: RefCell<HashMap<String, Rc<Mutex<()>>>>,
}

/// How `install` sets a channel up.
pub struct ControlOptions {
    pub mode: ControlMode,
    pub sentinel: Option<String>,
    pub replacement: Option<Value>,
    pub delay_ms: Option<u64>,
    pub queue: Option<String>,
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
    pub fn install(&self, channel: &str, options: ControlOptions) -> CoreResult<()> {
        let ControlOptions {
            mode,
            sentinel,
            replacement,
            delay_ms,
            queue,
        } = options;
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
                existing.delay_ms = delay_ms;
                existing.queue = queue;
            }
            None => {
                controls.insert(
                    method.channel,
                    InvokeControl {
                        mode,
                        invoke_count: 0,
                        args: Vec::new(),
                        reject_count: 0,
                        sentinel,
                        replacement,
                        delay_ms,
                        queue,
                        held: Vec::new(),
                        in_flight: 0,
                        settled: Rc::default(),
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
            "args": control.args,
            "sentinel": control.sentinel,
        }))
    }

    /// `release`: held requests run, and new ones are no longer held.
    pub fn release(&self, channel: &str) -> CoreResult<()> {
        let held = {
            let mut controls = self.controls.borrow_mut();
            let control = controls
                .get_mut(channel)
                .ok_or_else(|| not_installed(channel))?;
            control.mode = ControlMode::Passthrough;
            std::mem::take(&mut control.held)
        };
        for release in held {
            let _ = release.send(());
        }
        Ok(())
    }

    /// `settled`: waits until every request the channel has taken has been answered.
    pub async fn settled(&self, channel: &str) -> CoreResult<()> {
        loop {
            let settled = {
                let controls = self.controls.borrow();
                let control = controls
                    .get(channel)
                    .ok_or_else(|| not_installed(channel))?;
                if control.in_flight == 0 {
                    return Ok(());
                }
                control.settled.clone()
            };
            settled.notified().await;
        }
    }

    /// Answers a call on `channel`: through the real `handler` unless a control installed
    /// there says otherwise.
    pub async fn run_controlled(
        &self,
        channel: &str,
        args: &[Option<Value>],
        handler: impl Future<Output = CoreResult<Reply>>,
    ) -> CoreResult<Reply> {
        let queue = {
            let mut controls = self.controls.borrow_mut();
            controls.get_mut(channel).map(|control| {
                control.invoke_count += 1;
                control.args.push(Value::Array(
                    args.iter()
                        .map(|arg| arg.clone().unwrap_or(Value::Null))
                        .collect(),
                ));
                control.in_flight += 1;
                control.queue.clone()
            })
        };
        let Some(queue) = queue else {
            return handler.await;
        };
        let result = self.controlled(channel, queue, handler).await;
        if let Some(control) = self.controls.borrow_mut().get_mut(channel) {
            control.in_flight -= 1;
            if control.in_flight == 0 {
                control.settled.notify_waiters();
            }
        }
        result
    }

    async fn controlled(
        &self,
        channel: &str,
        queue: Option<String>,
        handler: impl Future<Output = CoreResult<Reply>>,
    ) -> CoreResult<Reply> {
        let lock = queue.map(|name| self.queues.borrow_mut().entry(name).or_default().clone());
        let _turn = match &lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        let held = {
            let mut controls = self.controls.borrow_mut();
            controls
                .get_mut(channel)
                .filter(|control| control.mode == ControlMode::Hold)
                .map(|control| {
                    let (release, held) = oneshot::channel();
                    control.held.push(release);
                    held
                })
        };
        if let Some(held) = held {
            let _ = held.await;
        }
        let delay = self
            .controls
            .borrow()
            .get(channel)
            .and_then(|control| control.delay_ms);
        if let Some(delay) = delay {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        let answer = {
            let mut controls = self.controls.borrow_mut();
            match controls.get_mut(channel) {
                Some(control) if control.mode == ControlMode::Reject => {
                    control.reject_count += 1;
                    Some(Err(CoreError::new(control.sentinel.clone())))
                }
                Some(control) if control.mode == ControlMode::Replace => {
                    Some(Ok(match &control.replacement {
                        Some(value) => Reply::Value(value.clone()),
                        None => Reply::Undefined,
                    }))
                }
                Some(control) if control.mode == ControlMode::Record => Some(Ok(Reply::Undefined)),
                _ => None,
            }
        };
        match answer {
            Some(answer) => answer,
            None => handler.await,
        }
    }
}

fn is_invoked(kind: Kind) -> bool {
    kind != Kind::Send
}

fn not_installed(channel: &str) -> CoreError {
    CoreError::new(format!("No IPC invoke control installed for {channel}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(mode: ControlMode) -> ControlOptions {
        ControlOptions {
            mode,
            sentinel: None,
            replacement: None,
            delay_ms: None,
            queue: None,
        }
    }

    async fn real() -> CoreResult<Reply> {
        Ok(Reply::Value(json!("real")))
    }

    #[tokio::test(flavor = "current_thread")]
    async fn controls_count_and_answer_like_the_electron_helper() {
        let controls = TestControls::default();
        assert_eq!(
            controls
                .install("pi-gui:no-such", options(ControlMode::Reject))
                .unwrap_err()
                .message,
            "No IPC handler registered for pi-gui:no-such"
        );
        let channel = methods::by_api("selectSession").unwrap().channel;
        assert!(controls.read(channel).is_err());
        controls
            .install(channel, options(ControlMode::Reject))
            .unwrap();
        let error = controls
            .run_controlled(channel, &[Some(json!(1))], real())
            .await
            .unwrap_err();
        assert_eq!(error.message, DEFAULT_SENTINEL);
        controls
            .set(channel, Some(ControlMode::Replace), Some(json!(7)))
            .unwrap();
        assert!(matches!(
            controls.run_controlled(channel, &[Some(json!(1))], real()).await.unwrap(),
            Reply::Value(value) if value == json!(7)
        ));
        controls
            .set(channel, Some(ControlMode::Passthrough), None)
            .unwrap();
        assert!(matches!(
            controls.run_controlled(channel, &[Some(json!(1))], real()).await.unwrap(),
            Reply::Value(value) if value == json!("real")
        ));
        let read = controls.read(channel).unwrap();
        assert_eq!(read["invokeCount"], 3);
        assert_eq!(read["rejectCount"], 1);
        assert_eq!(read["args"][0], json!([1]));
        assert_eq!(read["mode"], "passthrough");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn held_requests_run_in_their_queue_order_once_released() {
        let controls = Rc::new(TestControls::default());
        let held = methods::by_api("editQueuedComposerMessage")
            .unwrap()
            .channel;
        let after = methods::by_api("updateComposerDraft").unwrap().channel;
        for channel in [held, after] {
            let mut options = options(ControlMode::Passthrough);
            options.queue = Some("edits".into());
            controls.install(channel, options).unwrap();
        }
        controls.set(held, Some(ControlMode::Hold), None).unwrap();
        let order = Rc::new(RefCell::new(Vec::new()));
        let run = |channel: &'static str, name: &'static str| {
            let (controls, order) = (controls.clone(), order.clone());
            tokio::task::spawn_local(async move {
                controls
                    .run_controlled(channel, &[], async {
                        order.borrow_mut().push(name);
                        real().await
                    })
                    .await
            })
        };
        tokio::task::LocalSet::new()
            .run_until(async {
                let first = run(held, "edit");
                let second = run(after, "draft");
                tokio::task::yield_now().await;
                assert!(order.borrow().is_empty());
                controls.release(held).unwrap();
                first.await.unwrap().unwrap();
                second.await.unwrap().unwrap();
                controls.settled(after).await.unwrap();
            })
            .await;
        assert_eq!(*order.borrow(), ["edit", "draft"]);
    }
}
