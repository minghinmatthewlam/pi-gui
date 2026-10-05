//! Renderer calls: the handler table, and the dispatch helpers each handler uses the way
//! `register-desktop-ipc.ts` used `run`, `immediate`, `runUnscopedStateAction` and
//! `mainFrameHandler`. Each part registers its own handlers by API name; a method nobody has
//! registered answers "not ported: <method>".

use super::methods::{self, Kind};
use super::validation::Arg;
use super::{Kernel, WindowId};
use crate::error::{CoreError, CoreResult};
use crate::rpc::LocalFuture;
use crate::state::desktop_state::DesktopAppState;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::rc::Rc;

/// One renderer call.
#[derive(Debug, Clone)]
pub struct InvokeCall {
    pub window: WindowId,
    /// Whether the app's own frame sent it, not an extension iframe in the same window.
    pub main_frame: bool,
    /// The arguments; `None` is `undefined`.
    pub args: Vec<Option<Value>>,
}

impl InvokeCall {
    pub fn arg(&self, index: usize) -> Arg<'_> {
        self.args.get(index).and_then(Option::as_ref)
    }
}

/// What a call answers.
#[derive(Debug, Clone)]
pub enum Reply {
    State(Box<DesktopAppState>),
    Value(Value),
    /// JSON already serialized.
    Raw(Rc<str>),
    /// `undefined`.
    Undefined,
}

impl Reply {
    /// The answer as JSON text, or `None` for `undefined`.
    pub fn to_json(&self) -> Option<Rc<str>> {
        match self {
            Self::State(state) => Some(serde_json::to_string(state).unwrap_or_default().into()),
            Self::Value(value) => Some(serde_json::to_string(value).unwrap_or_default().into()),
            Self::Raw(json) => Some(json.clone()),
            Self::Undefined => None,
        }
    }
}

impl From<DesktopAppState> for Reply {
    fn from(state: DesktopAppState) -> Self {
        Self::State(Box::new(state))
    }
}

pub type Handler = fn(Rc<Kernel>, InvokeCall) -> LocalFuture<CoreResult<Reply>>;

/// Handlers by API name.
#[derive(Default)]
pub struct MethodTable {
    handlers: HashMap<&'static str, Handler>,
}

impl MethodTable {
    /// Every part's handlers.
    pub fn build() -> Self {
        let mut table = Self::default();
        super::ui::register(&mut table);
        super::workspace::register(&mut table);
        super::conversation::register(&mut table);
        super::review::register(&mut table);
        super::settings::register(&mut table);
        super::extensions::register(&mut table);
        super::orchestration::register(&mut table);
        super::scheduled::register(&mut table);
        super::notifications::register(&mut table);
        table
    }

    /// Registers the handler for `api`. Each method has one owner.
    pub fn on(&mut self, api: &'static str, handler: Handler) {
        assert!(
            methods::by_api(api).is_some(),
            "{api} is not a renderer method"
        );
        let previous = self.handlers.insert(api, handler);
        assert!(previous.is_none(), "{api} has two handlers");
    }

    pub fn get(&self, api: &str) -> Option<Handler> {
        self.handlers.get(api).copied()
    }

    /// Methods that still answer "not ported", in table order.
    pub fn unported(&self) -> Vec<&'static str> {
        methods::METHODS
            .iter()
            .map(|method| method.api)
            .filter(|api| !self.handlers.contains_key(api))
            .collect()
    }
}

/// Answers a renderer call by API name.
pub async fn invoke(kernel: &Rc<Kernel>, api: &str, call: InvokeCall) -> CoreResult<Reply> {
    let Some(method) = methods::by_api(api) else {
        return Err(CoreError::new(format!("Unknown method: {api}")));
    };
    let args = call.args.clone();
    let handle = async {
        let Some(handler) = kernel.methods.get(api) else {
            return Err(CoreError::new(format!("not ported: {api}")));
        };
        handler(kernel.clone(), call).await
    };
    kernel
        .test
        .run_controlled(method.channel, &args, handle)
        .await
}

/// Whether `api` is a fire-and-forget `send`.
pub fn is_send(api: &str) -> bool {
    methods::by_api(api).is_some_and(|method| method.kind == Kind::Send)
}

// ---- Helpers handlers dispatch through ----

/// `windowForSender`.
pub fn sender(kernel: &Kernel, call: &InvokeCall) -> CoreResult<WindowId> {
    kernel.windows.require(kernel, call.window)
}

/// `mainFrameHandler`'s checks: a live window, and its main frame.
pub fn main_frame(kernel: &Kernel, call: &InvokeCall, channel: &str) -> CoreResult<WindowId> {
    let window = sender(kernel, call)?;
    if !call.main_frame {
        return Err(CoreError::new(format!(
            "{channel} must originate from the window's main frame."
        )));
    }
    Ok(window)
}

/// `run`: `runStateAction` on the sender's window.
pub async fn run<F, Fut>(kernel: &Kernel, call: &InvokeCall, action: F) -> CoreResult<Reply>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = CoreResult<DesktopAppState>>,
{
    let window = sender(kernel, call)?;
    run_for(kernel, window, action).await
}

/// `runStateAction` for a window already checked.
pub async fn run_for<F, Fut>(kernel: &Kernel, window: WindowId, action: F) -> CoreResult<Reply>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = CoreResult<DesktopAppState>>,
{
    kernel
        .windows
        .run_state_action(kernel, Some(window), false, action)
        .await
        .map(Reply::from)
}

/// `immediate`: `runImmediateStateAction` on the sender's window.
pub async fn immediate(
    kernel: &Kernel,
    call: &InvokeCall,
    action: impl Future<Output = CoreResult<DesktopAppState>>,
) -> CoreResult<Reply> {
    let window = sender(kernel, call)?;
    kernel
        .windows
        .run_immediate_state_action(kernel, Some(window), action)
        .await
        .map(Reply::from)
}

/// `runUnscopedStateAction` on the sender's window.
pub async fn unscoped(
    kernel: &Kernel,
    call: &InvokeCall,
    action: impl Future<Output = CoreResult<DesktopAppState>>,
) -> CoreResult<Reply> {
    let window = sender(kernel, call)?;
    kernel
        .windows
        .run_unscoped_state_action(kernel, Some(window), action)
        .await
        .map(Reply::from)
}

/// `runStateResultAction` on the sender's window.
pub async fn run_result<F, Fut>(kernel: &Kernel, call: &InvokeCall, action: F) -> CoreResult<Reply>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = CoreResult<(Value, DesktopAppState)>>,
{
    let window = sender(kernel, call)?;
    kernel
        .windows
        .run_state_result_action(kernel, Some(window), action)
        .await
        .map(Reply::Value)
}

/// Serializes any answer.
pub fn value(value: impl serde::Serialize) -> Reply {
    Reply::Value(serde_json::to_value(value).unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The methods no part answers yet. Parts shrink this list as they port their handlers.
    const UNPORTED: &[&str] = &["sendChildThreadFollowUp", "setChildSupervisionLoop"];

    #[test]
    fn the_remaining_stubs_are_the_listed_ones() {
        assert_eq!(MethodTable::build().unported(), UNPORTED);
    }
}
