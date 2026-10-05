//! The kernel's view of pi: the `PiDriver` port and `HostPiDriver`, which runs pi in the pi
//! host process (`apps/desktop/pi-host`) and speaks `pi-host/protocol.ts` over a private
//! socket, as `pi-host/launch.ts` and `pi-host/remote-driver.ts` do for Electron.

use crate::error::{CoreError, CoreResult};
use crate::rpc::{self, LocalFuture, Peer, Service};
use crate::state::driver::{SessionRef, WorkspaceRef};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::{Rc, Weak};
use std::time::Duration;
use tokio::sync::oneshot;

/// `PI_DRIVER_METHODS` in `pi-host/protocol.ts`; a unit test there checks the two match.
pub const PI_DRIVER_METHODS: &[&str] = &[
    "createSession",
    "validateForkSession",
    "forkSession",
    "openSession",
    "archiveSession",
    "unarchiveSession",
    "sendUserMessage",
    "replaceQueuedMessages",
    "cancelCurrentRun",
    "setSessionModel",
    "setSessionThinkingLevel",
    "renameSession",
    "compactSession",
    "reloadSession",
    "reloadSessionWhenIdle",
    "getSessionTree",
    "navigateSessionTree",
    "getSessionCommands",
    "respondToHostUiRequest",
    "closeSession",
    "listWorkspaces",
    "listSessions",
    "syncWorkspace",
    "reconcileWorkspace",
    "getSessionFilePath",
    "renameWorkspace",
    "removeWorkspace",
    "getTranscript",
    "getSessionSchemaInfo",
];

/// `PI_RUNTIME_METHODS` in `pi-host/protocol.ts`.
pub const PI_RUNTIME_METHODS: &[&str] = &[
    "getRuntimeSnapshot",
    "refreshRuntime",
    "logout",
    "setProviderApiKey",
    "listCustomProviders",
    "setCustomProvider",
    "deleteCustomProvider",
    "setDefaultModel",
    "setProjectDefaultModel",
    "setDefaultThinkingLevel",
    "setProjectDefaultThinkingLevel",
    "setEnableSkillCommands",
    "getCodemodeAlwaysOn",
    "setCodemodeAlwaysOn",
    "listMcpServers",
    "addMcpServer",
    "removeMcpServer",
    "setMcpServerEnabled",
    "setScopedModelPatterns",
    "setProjectScopedModelPatterns",
    "getGlobalModelSettings",
    "getCurrentModelSettings",
    "setSkillEnabled",
    "setExtensionEnabled",
    "builtinExtensionName",
];

/// Turn capture is bounded by the kernel; this only stops a stuck boundary
/// (`TURN_CAPTURE_BACKSTOP_MS` in `electron/main.ts`).
pub const TURN_CAPTURE_BACKSTOP_MS: u64 = 10_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// An argument list as pi sees it: `None` is `undefined`, which JSON cannot carry.
pub type Args = Vec<Option<Value>>;
/// Ends a session subscription.
pub type Unsubscribe = Box<dyn Fn()>;
/// Told about each value as it arrives.
pub type Listener = Rc<dyn Fn(Value)>;

/// Every argument present.
pub fn args<const N: usize>(values: [Value; N]) -> Args {
    values.into_iter().map(Some).collect()
}

/// What pi reads synchronously while it builds a session; pushed whenever it changes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiHostConfig {
    pub disabled_builtin_extensions: Vec<String>,
    /// By session key.
    pub extension_flags: Map<String, Value>,
}

/// The callbacks a sign-in calls back into the app for (`RuntimeLoginCallbacks`).
pub trait LoginCallbacks {
    fn on_auth(&self, info: Value) -> LocalFuture<CoreResult<()>>;
    fn on_prompt(&self, prompt: Value) -> LocalFuture<CoreResult<Value>>;
    fn on_progress(&self, message: String) -> Option<LocalFuture<CoreResult<()>>>;
    fn on_manual_code(&self) -> Option<LocalFuture<CoreResult<Value>>>;
}

/// The app's answers to the host's own calls (`app.catalog`, `app.captureBoundary`, `app.tool`)
/// and notifications (`app.openUrl`, `views.*`, `host.diagnostic`).
pub trait HostCalls {
    fn call(&self, method: String, params: Value) -> LocalFuture<CoreResult<Value>>;
    fn notification(&self, method: String, params: Value);
}

/// The kernel's port to pi. Every call is asynchronous because pi runs in another process.
pub trait PiDriver {
    /// One of `PI_DRIVER_METHODS`. `Ok(None)` is an `undefined` result.
    fn call(&self, method: &'static str, args: Args) -> LocalFuture<CoreResult<Option<Value>>>;
    /// One of `PI_RUNTIME_METHODS`.
    fn runtime(&self, method: &'static str, args: Args) -> LocalFuture<CoreResult<Option<Value>>>;
    /// Resolves once the host is listening; the session's state is replayed to `listener`
    /// first. Rejects for an unknown session.
    fn subscribe(
        &self,
        session_ref: &SessionRef,
        listener: Rc<dyn Fn(Value)>,
    ) -> LocalFuture<CoreResult<Unsubscribe>>;
    /// Dropping the future cancels the request.
    fn generate_thread_title(
        &self,
        workspace: &WorkspaceRef,
        options: Value,
    ) -> LocalFuture<CoreResult<Option<String>>>;
    fn login(
        &self,
        workspace: &WorkspaceRef,
        provider_id: &str,
        callbacks: Rc<dyn LoginCallbacks>,
    ) -> LocalFuture<CoreResult<Value>>;
    /// Where the host config comes from; read before every call and pushed when it changed.
    fn set_config_source(&self, source: Box<dyn Fn() -> PiHostConfig>);
    /// Test hooks: holds calls to these methods until a test completes them.
    fn interceptor(&self) -> &DriverInterceptor;
}

// ---- Test interception ----

/// How a test completes an intercepted call.
pub enum InterceptOutcome {
    Result(Option<Value>),
    Error(CoreError),
    /// Run the real call after all.
    Passthrough,
}

struct PendingIntercept {
    method: String,
    args: Value,
    reply: oneshot::Sender<InterceptOutcome>,
}

/// `test.driver.intercept(method)` / `test.driver.complete(id, …)`: replaces the specs that
/// patched `piDriver()` methods in Electron main.
#[derive(Default)]
pub struct DriverInterceptor {
    methods: RefCell<HashSet<String>>,
    next_id: Cell<u64>,
    pending: RefCell<Vec<(u64, PendingIntercept)>>,
    /// Told about each held call, so a test can wait for one without polling.
    on_held: RefCell<Option<Listener>>,
}

impl DriverInterceptor {
    pub fn intercept(&self, method: &str) {
        self.methods.borrow_mut().insert(method.to_owned());
    }

    pub fn release(&self, method: &str) {
        self.methods.borrow_mut().remove(method);
    }

    pub fn set_on_held(&self, listener: Option<Rc<dyn Fn(Value)>>) {
        *self.on_held.borrow_mut() = listener;
    }

    /// Calls waiting for a test, oldest first.
    pub fn pending(&self) -> Value {
        Value::Array(
            self.pending
                .borrow()
                .iter()
                .map(|(id, call)| json!({ "id": id, "method": call.method, "args": call.args }))
                .collect(),
        )
    }

    pub fn complete(&self, id: u64, outcome: InterceptOutcome) -> CoreResult<()> {
        let mut pending = self.pending.borrow_mut();
        let index = pending
            .iter()
            .position(|(entry, _)| *entry == id)
            .ok_or_else(|| CoreError::new(format!("No intercepted driver call {id}")))?;
        let (_, call) = pending.remove(index);
        let _ = call.reply.send(outcome);
        Ok(())
    }

    /// `Some` when `method` is held: resolves with the test's answer.
    fn hold(&self, method: &str, args: Value) -> Option<oneshot::Receiver<InterceptOutcome>> {
        if !self.methods.borrow().contains(method) {
            return None;
        }
        let id = self.next_id.get() + 1;
        self.next_id.set(id);
        let (reply, answer) = oneshot::channel();
        let notice = json!({ "id": id, "method": method, "args": args });
        self.pending.borrow_mut().push((
            id,
            PendingIntercept {
                method: method.to_owned(),
                args,
                reply,
            },
        ));
        let listener = self.on_held.borrow().clone();
        if let Some(listener) = listener {
            listener(notice);
        }
        Some(answer)
    }
}

/// Runs `real` unless a test holds `method`, in which case the test's answer wins.
async fn intercepted<F>(
    interceptor: Option<oneshot::Receiver<InterceptOutcome>>,
    real: F,
) -> CoreResult<Option<Value>>
where
    F: std::future::Future<Output = CoreResult<Option<Value>>>,
{
    let Some(answer) = interceptor else {
        return real.await;
    };
    match answer.await {
        Ok(InterceptOutcome::Result(value)) => Ok(value),
        Ok(InterceptOutcome::Error(error)) => Err(error),
        Ok(InterceptOutcome::Passthrough) => real.await,
        Err(_) => Err(CoreError::new(
            "The test released the call without an answer",
        )),
    }
}

// ---- Wire encoding (`encodeArgs` / `decodeResult`) ----

/// `encodeArgs`: trailing `undefined`s dropped, the rest listed in `undefinedAt`.
pub fn encode_args(args: &Args) -> Map<String, Value> {
    let end = args
        .iter()
        .rposition(Option::is_some)
        .map_or(0, |last| last + 1);
    let kept = &args[..end];
    let undefined_at: Vec<usize> = kept
        .iter()
        .enumerate()
        .filter(|(_, value)| value.is_none())
        .map(|(index, _)| index)
        .collect();
    let mut encoded = Map::new();
    encoded.insert(
        "args".into(),
        Value::Array(
            kept.iter()
                .map(|value| value.clone().unwrap_or(Value::Null))
                .collect(),
        ),
    );
    if !undefined_at.is_empty() {
        encoded.insert("undefinedAt".into(), json!(undefined_at));
    }
    encoded
}

/// `decodeArgs`.
pub fn decode_args(encoded: &Value) -> Args {
    let mut args: Args = encoded
        .get("args")
        .and_then(Value::as_array)
        .map(|values| values.iter().cloned().map(Some).collect())
        .unwrap_or_default();
    for index in encoded
        .get("undefinedAt")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
    {
        if let Some(slot) = args.get_mut(index as usize) {
            *slot = None;
        }
    }
    args
}

/// `decodeResult`: `{}` is `undefined`.
pub fn decode_result(encoded: Value) -> Option<Value> {
    match encoded {
        Value::Object(mut map) => map.remove("value"),
        _ => None,
    }
}

/// `encodeResult`.
pub fn encode_result(value: Option<Value>) -> Value {
    match value {
        Some(value) => json!({ "value": value }),
        None => json!({}),
    }
}

/// Args as JSON for test listings: `undefined` shows as null.
fn args_json(args: &Args) -> Value {
    Value::Array(
        args.iter()
            .map(|value| value.clone().unwrap_or(Value::Null))
            .collect(),
    )
}

// ---- HostPiDriver ----

/// How to start the pi host.
pub struct HostLaunch {
    /// Plain Node, or Electron with `ELECTRON_RUN_AS_NODE`.
    pub node: PathBuf,
    /// The built `out/main/pi-host.js`.
    pub script: PathBuf,
    /// The host's whole environment.
    pub env: Vec<(String, String)>,
}

/// pi in the pi host process.
pub struct HostPiDriver {
    /// For futures that outlive the borrow of `self`.
    this: Weak<Self>,
    peer: Peer,
    listeners: RefCell<HashMap<String, Listener>>,
    logins: RefCell<HashMap<String, Rc<dyn LoginCallbacks>>>,
    sent_config: RefCell<String>,
    config_source: RefCell<Option<Box<dyn Fn() -> PiHostConfig>>>,
    host_calls: RefCell<Option<Rc<dyn HostCalls>>>,
    interceptor: DriverInterceptor,
    pid: Option<u32>,
    stopping: Cell<bool>,
    /// Ends the host process now.
    kill: RefCell<Option<oneshot::Sender<()>>>,
    exited: RefCell<Option<tokio::sync::watch::Receiver<bool>>>,
}

impl HostPiDriver {
    /// Starts the host, waits for it to connect and sends its startup settings. Must run
    /// inside a `LocalSet`.
    pub async fn start(launch: HostLaunch) -> CoreResult<Rc<Self>> {
        let (peer, lines) = Peer::new();
        let (socket, pid, kill, exited) = transport::spawn(launch).await?;
        let driver = Rc::new_cyclic(|this| Self {
            this: this.clone(),
            peer: peer.clone(),
            listeners: RefCell::new(HashMap::new()),
            logins: RefCell::new(HashMap::new()),
            sent_config: RefCell::new(String::new()),
            config_source: RefCell::new(None),
            host_calls: RefCell::new(None),
            interceptor: DriverInterceptor::default(),
            pid,
            stopping: Cell::new(false),
            kill: RefCell::new(Some(kill)),
            exited: RefCell::new(Some(exited.clone())),
        });
        let (reader, writer) = socket.into_split();
        tokio::task::spawn_local(rpc::write_lines(lines, writer));
        let service = Rc::new(HostService {
            driver: Rc::downgrade(&driver),
        });
        let serve_peer = peer.clone();
        tokio::task::spawn_local(async move {
            let reader = tokio::io::BufReader::new(reader);
            if let Err(error) = rpc::serve(serve_peer.clone(), service, reader).await {
                eprintln!("[pi-host] pipe failed: {error}");
            }
            serve_peer.close("pi host closed the pipe");
        });
        let mut watch_exit = exited;
        let exit_peer = peer.clone();
        let weak = Rc::downgrade(&driver);
        tokio::task::spawn_local(async move {
            let _ = watch_exit.wait_for(|exited| *exited).await;
            exit_peer.close("pi host exited");
            if weak.upgrade().is_some_and(|driver| !driver.stopping.get()) {
                eprintln!("[pi-host] the pi host exited unexpectedly");
            }
        });
        peer.request(
            "host.initialize",
            json!({
                "config": { "disabledBuiltinExtensions": [], "extensionFlags": {} },
                "turnCaptureTimeoutMs": TURN_CAPTURE_BACKSTOP_MS,
            }),
        )
        .await?;
        *driver.sent_config.borrow_mut() =
            r#"{"disabledBuiltinExtensions":[],"extensionFlags":{}}"#.to_owned();
        Ok(driver)
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// `views.asset`: an extension view's file for a `pi-extension://` request, as
    /// `{ status, headers, bodyBase64 }`.
    pub async fn view_asset(&self, url: &str) -> CoreResult<Value> {
        self.peer
            .request("views.asset", json!({ "url": url }))
            .await
    }

    /// Who answers `app.*` calls; set once the kernel exists.
    pub fn set_host_calls(&self, calls: Rc<dyn HostCalls>) {
        *self.host_calls.borrow_mut() = Some(calls);
    }

    /// Lets the host dispose extension views, then ends it; kills it after `timeout`.
    pub async fn stop(&self, timeout: Duration) {
        if self.stopping.replace(true) {
            return;
        }
        let exited = self.exited.borrow_mut().take();
        let kill = self.kill.borrow_mut().take();
        let shutdown = self.peer.request("host.shutdown", Value::Null);
        let wait_exit = async {
            if let Some(mut exited) = exited {
                let _ = exited.wait_for(|exited| *exited).await;
            }
        };
        tokio::pin!(wait_exit);
        let finished = tokio::time::timeout(timeout, async {
            tokio::select! {
                _ = shutdown => {}
                _ = &mut wait_exit => {}
            }
        })
        .await;
        self.peer.close("app is quitting");
        if finished.is_err() {
            if let Some(kill) = kill {
                let _ = kill.send(());
            }
        }
        let _ = tokio::time::timeout(timeout, wait_exit).await;
    }

    fn push_config(&self) {
        let Some(config) = self.config_source.borrow().as_ref().map(|source| source()) else {
            return;
        };
        let next = serde_json::to_string(&config).unwrap_or_default();
        if *self.sent_config.borrow() == next {
            return;
        }
        self.peer.notify(
            "config.update",
            serde_json::to_value(&config).unwrap_or_default(),
        );
        *self.sent_config.borrow_mut() = next;
    }

    fn request(&self, method: &'static str, params: Value) -> LocalFuture<CoreResult<Value>> {
        self.push_config();
        let peer = self.peer.clone();
        Box::pin(async move { peer.request(method, params).await })
    }

    fn login_callbacks(&self, params: &Value) -> CoreResult<Rc<dyn LoginCallbacks>> {
        let login_id = params.get("loginId").and_then(Value::as_str).unwrap_or("");
        self.logins
            .borrow()
            .get(login_id)
            .cloned()
            .ok_or_else(|| CoreError::new("Sign-in is no longer in progress"))
    }
}

impl PiDriver for HostPiDriver {
    fn call(&self, method: &'static str, args: Args) -> LocalFuture<CoreResult<Option<Value>>> {
        let held = self.interceptor.hold(method, args_json(&args));
        let mut params = encode_args(&args);
        params.insert("method".into(), json!(method));
        let request = self.request("driver.call", Value::Object(params));
        Box::pin(intercepted(held, async move {
            Ok(decode_result(request.await?))
        }))
    }

    fn runtime(&self, method: &'static str, args: Args) -> LocalFuture<CoreResult<Option<Value>>> {
        let held = self.interceptor.hold(method, args_json(&args));
        let mut params = encode_args(&args);
        params.insert("method".into(), json!(method));
        let request = self.request("runtime.call", Value::Object(params));
        Box::pin(intercepted(held, async move {
            Ok(decode_result(request.await?))
        }))
    }

    fn subscribe(
        &self,
        session_ref: &SessionRef,
        listener: Rc<dyn Fn(Value)>,
    ) -> LocalFuture<CoreResult<Unsubscribe>> {
        let subscription_id = uuid::Uuid::new_v4().to_string();
        // Registered first: the host replays the session's state before it replies.
        self.listeners
            .borrow_mut()
            .insert(subscription_id.clone(), listener);
        let request = self.request(
            "driver.subscribe",
            json!({ "subscriptionId": subscription_id, "sessionRef": session_ref }),
        );
        let driver = self.this.clone();
        Box::pin(async move {
            if let Err(error) = request.await {
                if let Some(driver) = driver.upgrade() {
                    driver.listeners.borrow_mut().remove(&subscription_id);
                }
                return Err(error);
            }
            let unsubscribe: Unsubscribe = Box::new(move || {
                let Some(driver) = driver.upgrade() else {
                    return;
                };
                if driver
                    .listeners
                    .borrow_mut()
                    .remove(&subscription_id)
                    .is_none()
                {
                    return;
                }
                driver.peer.notify(
                    "driver.unsubscribe",
                    json!({ "subscriptionId": subscription_id }),
                );
            });
            Ok(unsubscribe)
        })
    }

    fn generate_thread_title(
        &self,
        workspace: &WorkspaceRef,
        options: Value,
    ) -> LocalFuture<CoreResult<Option<String>>> {
        let held = self
            .interceptor
            .hold("generateThreadTitle", json!([workspace, options]));
        let request = self.request(
            "driver.generateThreadTitle",
            json!({ "workspace": workspace, "options": options }),
        );
        Box::pin(async move {
            let value = intercepted(held, async move { Ok(decode_result(request.await?)) }).await?;
            Ok(value.and_then(|value| value.as_str().map(str::to_owned)))
        })
    }

    fn login(
        &self,
        workspace: &WorkspaceRef,
        provider_id: &str,
        callbacks: Rc<dyn LoginCallbacks>,
    ) -> LocalFuture<CoreResult<Value>> {
        let login_id = uuid::Uuid::new_v4().to_string();
        let params = json!({
            "loginId": login_id,
            "workspace": workspace,
            "providerId": provider_id,
            // The host asks for these only when the app can answer them.
            "hasProgress": true,
            "hasManualCodeInput": true,
        });
        self.logins.borrow_mut().insert(login_id.clone(), callbacks);
        let request = self.request("runtime.login", params);
        let driver = self.this.clone();
        Box::pin(async move {
            let result = request.await;
            if let Some(driver) = driver.upgrade() {
                driver.logins.borrow_mut().remove(&login_id);
            }
            result
        })
    }

    fn set_config_source(&self, source: Box<dyn Fn() -> PiHostConfig>) {
        *self.config_source.borrow_mut() = Some(source);
    }

    fn interceptor(&self) -> &DriverInterceptor {
        &self.interceptor
    }
}

/// Answers the host's calls to the app.
struct HostService {
    driver: Weak<HostPiDriver>,
}

impl Service for HostService {
    fn call(self: Rc<Self>, method: String, params: Value) -> LocalFuture<CoreResult<Value>> {
        let Some(driver) = self.driver.upgrade() else {
            return Box::pin(std::future::ready(Err(CoreError::new(
                "pi-gui is shutting down",
            ))));
        };
        match method.as_str() {
            "app.login.auth" => Box::pin(async move {
                let callbacks = driver.login_callbacks(&params)?;
                callbacks
                    .on_auth(params.get("info").cloned().unwrap_or_default())
                    .await?;
                Ok(Value::Null)
            }),
            "app.login.prompt" => Box::pin(async move {
                let callbacks = driver.login_callbacks(&params)?;
                callbacks
                    .on_prompt(params.get("prompt").cloned().unwrap_or_default())
                    .await
            }),
            "app.login.progress" => Box::pin(async move {
                let callbacks = driver.login_callbacks(&params)?;
                let message = params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if let Some(progress) = callbacks.on_progress(message) {
                    progress.await?;
                }
                Ok(Value::Null)
            }),
            "app.login.manualCode" => Box::pin(async move {
                let callbacks = driver.login_callbacks(&params)?;
                match callbacks.on_manual_code() {
                    Some(code) => code.await,
                    None => Err(CoreError::new("This sign-in does not take a typed code")),
                }
            }),
            _ => {
                let calls = driver.host_calls.borrow().clone();
                match calls {
                    Some(calls) => calls.call(method, params),
                    None => Box::pin(std::future::ready(Err(CoreError::new(format!(
                        "Unknown RPC method: {method}"
                    ))))),
                }
            }
        }
    }

    fn notification(self: Rc<Self>, method: String, params: Value) {
        let Some(driver) = self.driver.upgrade() else {
            return;
        };
        if method == "session.event" {
            let subscription_id = params
                .get("subscriptionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let listener = driver.listeners.borrow().get(subscription_id).cloned();
            if let Some(listener) = listener {
                listener(params.get("event").cloned().unwrap_or_default());
            }
            return;
        }
        let calls = driver.host_calls.borrow().clone();
        match calls {
            Some(calls) => calls.notification(method, params),
            None => eprintln!("[pi-host] no handler for notification {method}"),
        }
    }

    fn stopping(&self) -> bool {
        false
    }
}

/// The socket to the host process and the process itself.
#[cfg(unix)]
mod transport {
    use super::{HostLaunch, CONNECT_TIMEOUT};
    use crate::error::{CoreError, CoreResult};
    use std::os::unix::fs::DirBuilderExt;
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    use tokio::net::{UnixListener, UnixStream};
    use tokio::sync::{oneshot, watch};

    pub type Exited = watch::Receiver<bool>;

    /// Starts the host and waits for it to connect with its token.
    pub async fn spawn(
        launch: HostLaunch,
    ) -> CoreResult<(UnixStream, Option<u32>, oneshot::Sender<()>, Exited)> {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        // A private folder: only this user can reach the socket inside it.
        let directory = std::env::temp_dir().join(format!(
            "pi-gui-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|error| CoreError::io(&error, &directory))?;
        let address = directory.join("host.sock");
        let cleanup = || {
            let _ = std::fs::remove_dir_all(&directory);
        };
        let listener = match UnixListener::bind(&address) {
            Ok(listener) => listener,
            Err(error) => {
                cleanup();
                return Err(CoreError::io(&error, &address));
            }
        };
        let mut command = tokio::process::Command::new(&launch.node);
        command
            .arg(&launch.script)
            .env_clear()
            .envs(launch.env.iter().map(|(key, value)| (key, value)))
            .env(
                crate::app::pi::PI_HOST_SOCKET_ENV,
                address.to_string_lossy().as_ref(),
            )
            .env(crate::app::pi::PI_HOST_TOKEN_ENV, &token)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                cleanup();
                return Err(CoreError::new(format!(
                    "Could not start the pi host ({}): {error}",
                    launch.node.display()
                )));
            }
        };
        let pid = child.id();
        let (exited_tx, exited) = watch::channel(false);
        let (kill, kill_rx) = oneshot::channel::<()>();
        let mut exited_early = exited.clone();
        tokio::task::spawn_local(async move {
            tokio::select! {
                status = child.wait() => {
                    if let Ok(status) = status {
                        if !status.success() {
                            eprintln!("[pi-host] exited: {status}");
                        }
                    }
                }
                _ = kill_rx => {
                    let _ = child.kill().await;
                }
            }
            let _ = exited_tx.send(true);
        });
        let accepted = tokio::time::timeout(CONNECT_TIMEOUT, async {
            tokio::select! {
                stream = accept_host(&listener, &token) => stream,
                _ = exited_early.wait_for(|exited| *exited) => {
                    Err(CoreError::new("pi host exited before it connected"))
                }
            }
        })
        .await;
        cleanup();
        let stream = match accepted {
            Ok(stream) => stream?,
            Err(_) => {
                let _ = kill.send(());
                return Err(CoreError::new("pi host did not connect in time"));
            }
        };
        Ok((stream, pid, kill, exited))
    }

    /// The first connection that presents the token; others are dropped.
    async fn accept_host(listener: &UnixListener, token: &str) -> CoreResult<UnixStream> {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|error| CoreError::new(format!("pi host socket failed: {error}")))?;
            let mut greeting = Vec::with_capacity(token.len() + 1);
            let mut byte = [0u8; 1];
            let mut valid = false;
            // Read byte by byte so nothing after the token is consumed here.
            while greeting.len() <= token.len() + 1 {
                match stream.read(&mut byte).await {
                    Ok(1) if byte[0] == b'\n' => {
                        valid = greeting == token.as_bytes();
                        break;
                    }
                    Ok(1) => greeting.push(byte[0]),
                    _ => break,
                }
            }
            if valid {
                return Ok(stream);
            }
        }
    }
}

#[cfg(not(unix))]
mod transport {
    use super::HostLaunch;
    use crate::error::{CoreError, CoreResult};
    use tokio::sync::{oneshot, watch};

    pub type Exited = watch::Receiver<bool>;

    pub struct Unsupported;

    impl Unsupported {
        pub fn into_split(self) -> (tokio::io::Empty, tokio::io::Sink) {
            (tokio::io::empty(), tokio::io::sink())
        }
    }

    pub async fn spawn(
        _launch: HostLaunch,
    ) -> CoreResult<(Unsupported, Option<u32>, oneshot::Sender<()>, Exited)> {
        Err(CoreError::new(
            "The pi host pipe is only built for Unix so far",
        ))
    }
}

/// `PI_HOST_SOCKET_ENV` / `PI_HOST_TOKEN_ENV` in `pi-host/host-env.ts`.
pub const PI_HOST_SOCKET_ENV: &str = "PI_GUI_HOST_SOCKET";
pub const PI_HOST_TOKEN_ENV: &str = "PI_GUI_HOST_TOKEN";

// ---- Typed calls ----

/// Typed wrappers over the driver calls the kernel makes most.
pub async fn driver_call<T: serde::de::DeserializeOwned>(
    driver: &dyn PiDriver,
    method: &'static str,
    args: Args,
) -> CoreResult<T> {
    let value = driver.call(method, args).await?.unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|error| {
        CoreError::new(format!(
            "pi returned an unexpected {method} result: {error}"
        ))
    })
}

pub async fn runtime_call<T: serde::de::DeserializeOwned>(
    driver: &dyn PiDriver,
    method: &'static str,
    args: Args,
) -> CoreResult<T> {
    let value = driver.runtime(method, args).await?.unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|error| {
        CoreError::new(format!(
            "pi returned an unexpected {method} result: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_encode_like_encode_args() {
        let encoded = encode_args(&vec![Some(json!("a")), None, Some(json!(1)), None]);
        assert_eq!(
            Value::Object(encoded),
            json!({ "args": ["a", null, 1], "undefinedAt": [1] })
        );
        let encoded = encode_args(&vec![None]);
        assert_eq!(Value::Object(encoded), json!({ "args": [] }));
        assert_eq!(
            decode_args(&json!({ "args": ["a", null], "undefinedAt": [1] })),
            vec![Some(json!("a")), None]
        );
        assert_eq!(decode_result(json!({})), None);
        assert_eq!(decode_result(json!({ "value": null })), Some(Value::Null));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_held_call_waits_for_the_test() {
        let interceptor = DriverInterceptor::default();
        interceptor.intercept("listSessions");
        let held = interceptor.hold("listSessions", json!([]));
        assert!(interceptor.hold("listWorkspaces", json!([])).is_none());
        assert_eq!(interceptor.pending()[0]["method"], "listSessions");
        interceptor
            .complete(1, InterceptOutcome::Result(Some(json!({ "sessions": [] }))))
            .unwrap();
        let result = intercepted(held, async { Ok(None) }).await.unwrap();
        assert_eq!(result, Some(json!({ "sessions": [] })));
        assert!(interceptor
            .complete(1, InterceptOutcome::Passthrough)
            .is_err());
    }
}
