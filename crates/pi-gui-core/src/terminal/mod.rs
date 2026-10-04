//! The integrated terminal: shells per window, folder and thread, with the output each one
//! keeps for redrawing. Moved from Electron main's `TerminalService` (node-pty) with the same
//! ids, limits, snapshots and messages; main forwards `terminal.data`, `terminal.exit` and
//! `terminal.error` to the window that owns the shell.

mod pty;

use crate::error::{CoreError, CoreResult};
use crate::js;
use crate::methods;
use crate::parse;
use crate::rpc::Peer;
use pty::{Pty, PtyEvent, Size};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::{Rc, Weak};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

/// Notifications to the app. Kept in step with `coreNotifications` in
/// `apps/desktop/core-process/protocol.ts`.
pub mod notifications {
    pub const DATA: &str = "terminal.data";
    pub const EXIT: &str = "terminal.exit";
    pub const ERROR: &str = "terminal.error";
}

const DEFAULT_SIZE: Size = Size { cols: 80, rows: 24 };
const MAX_SESSIONS_PER_ROOT: usize = 8;
/// In UTF-16 code units, as `TERMINAL_REPLAY_BUFFER_LENGTH` in `contracts/terminal-model.ts`
/// counts them, so the renderer's copy and this one cut at the same place.
const REPLAY_LIMIT: usize = 1_000_000;
/// Output sent in one notification at most; more waiting output goes in the next one.
const MAX_BATCH_BYTES: usize = 256 * 1024;
/// How long an exited shell's last output may take to arrive, as node-pty waited.
const EXIT_OUTPUT_GRACE: Duration = Duration::from_millis(200);

pub struct Terminals {
    peer: Peer,
    state: RefCell<State>,
}

#[derive(Default)]
struct State {
    roots: HashMap<String, Root>,
    sessions: HashMap<String, Session>,
    next_session_number: u64,
}

struct Root {
    owner_id: u64,
    workspace_root_key: String,
    workspace_id: String,
    terminal_scope_id: String,
    cwd: String,
    active_session_id: Option<String>,
    session_ids: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Running,
    Exited,
    Error,
}

struct Session {
    id: String,
    workspace_id: String,
    terminal_scope_id: String,
    root_key: String,
    cwd: String,
    owner_id: u64,
    shell: String,
    title: String,
    status: Status,
    replay: Replay,
    exit_code: Option<i64>,
    signal: Option<i64>,
    size: Size,
    pty: Option<LivePty>,
}

/// A running shell and the task that forwards its output. Dropping it hangs up the shell.
struct LivePty {
    pty: Pty,
    pump: AbortHandle,
}

impl Drop for LivePty {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelParams {
    owner_id: u64,
    workspace_id: String,
    workspace_path: Option<String>,
    terminal_scope_id: String,
    size: Option<SizeParams>,
    /// The integrated terminal shell setting; empty uses `$SHELL` or the platform default.
    shell: Option<String>,
}

#[derive(Deserialize, Default, Clone, Copy)]
struct SizeParams {
    cols: Option<f64>,
    rows: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetActiveParams {
    owner_id: u64,
    workspace_id: String,
    terminal_scope_id: String,
    terminal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    owner_id: u64,
    terminal_id: String,
    data: Option<String>,
    size: Option<SizeParams>,
    title: Option<String>,
    shell: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetainParams {
    workspace_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerParams {
    owner_id: u64,
}

impl Terminals {
    pub fn new(peer: Peer) -> Rc<Self> {
        Rc::new(Self {
            peer,
            state: RefCell::new(State {
                next_session_number: 1,
                ..State::default()
            }),
        })
    }

    /// Answers a `terminal.*` call; none of them wait.
    pub fn call(self: &Rc<Self>, method: &str, params: Value) -> CoreResult<Value> {
        match method {
            methods::TERMINAL_ENSURE_PANEL => self.ensure_panel(parse(params)?, false),
            methods::TERMINAL_CREATE_SESSION => self.ensure_panel(parse(params)?, true),
            methods::TERMINAL_SET_ACTIVE_SESSION => self.set_active_session(parse(params)?),
            methods::TERMINAL_WRITE => {
                let params: SessionParams = parse(params)?;
                let state = self.state.borrow();
                let session = state.owned_session(params.owner_id, &params.terminal_id)?;
                if let (Some(live), Some(data)) = (&session.pty, params.data) {
                    if !data.is_empty() {
                        live.pty.write(data.as_bytes());
                    }
                }
                Ok(Value::Null)
            }
            methods::TERMINAL_RESIZE => {
                let params: SessionParams = parse(params)?;
                let mut state = self.state.borrow_mut();
                let session = state.owned_session_mut(params.owner_id, &params.terminal_id)?;
                session.size = normalize_size(params.size.unwrap_or_default());
                if let Some(live) = &session.pty {
                    live.pty.resize(session.size).map_err(CoreError::new)?;
                }
                Ok(Value::Null)
            }
            methods::TERMINAL_RESTART => self.restart(parse(params)?),
            methods::TERMINAL_CLOSE => self.close(parse(params)?),
            methods::TERMINAL_SET_TITLE => {
                let params: SessionParams = parse(params)?;
                let mut state = self.state.borrow_mut();
                let session = state.owned_session_mut(params.owner_id, &params.terminal_id)?;
                let title = js::trim(params.title.as_deref().unwrap_or_default());
                session.title = if title.is_empty() {
                    default_title(&session.id)
                } else {
                    take_utf16(title, 80)
                };
                Ok(Value::Null)
            }
            methods::TERMINAL_RETAIN_WORKSPACE_PATHS => {
                let params: RetainParams = parse(params)?;
                let retained: Vec<String> = params
                    .workspace_paths
                    .iter()
                    .map(|path| normalize_root_key(path))
                    .collect();
                self.remove_roots(|root| !retained.contains(&root.workspace_root_key));
                Ok(Value::Null)
            }
            methods::TERMINAL_DISPOSE_OWNER => {
                let params: OwnerParams = parse(params)?;
                self.remove_roots(|root| root.owner_id == params.owner_id);
                Ok(Value::Null)
            }
            methods::TERMINAL_DISPOSE_ALL => {
                self.dispose_all();
                Ok(Value::Null)
            }
            _ => Err(CoreError::new(format!("Unknown RPC method: {method}"))),
        }
    }

    /// Hangs up every shell, for when the app quits.
    pub fn dispose_all(&self) {
        let sessions = {
            let mut state = self.state.borrow_mut();
            state.roots.clear();
            // A fresh start numbers tabs from 1 again, as a new service did.
            state.next_session_number = 1;
            std::mem::take(&mut state.sessions)
        };
        drop(sessions);
    }

    fn ensure_panel(
        self: &Rc<Self>,
        params: PanelParams,
        always_create: bool,
    ) -> CoreResult<Value> {
        let root_key = self.ensure_root(&params)?;
        let needs_session = {
            let state = self.state.borrow();
            let root = &state.roots[&root_key];
            if always_create && root.session_ids.len() >= MAX_SESSIONS_PER_ROOT {
                return Err(CoreError::new(format!(
                    "A workspace can have up to {MAX_SESSIONS_PER_ROOT} terminal tabs."
                )));
            }
            always_create || root.active_session_id.is_none() || root.session_ids.is_empty()
        };
        if needs_session {
            let size = normalize_size(params.size.unwrap_or_default());
            let id = self.create_session(&root_key, params.owner_id, params.shell, size)?;
            let mut state = self.state.borrow_mut();
            let root = state.roots.get_mut(&root_key).expect("root exists");
            root.session_ids.push(id.clone());
            root.active_session_id = Some(id);
        }
        self.state.borrow().snapshot_root(&root_key)
    }

    fn ensure_root(&self, params: &PanelParams) -> CoreResult<String> {
        let scope_id = js::trim(&params.terminal_scope_id);
        if scope_id.is_empty() {
            return Err(CoreError::new("Terminal scope is required"));
        }
        let workspace_path = params
            .workspace_path
            .as_deref()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| CoreError::new(format!("Unknown workspace: {}", params.workspace_id)))?;
        ensure_directory(workspace_path)?;
        let workspace_root_key = normalize_root_key(workspace_path);
        let root_key = format!("{}\0{workspace_root_key}\0{scope_id}", params.owner_id);
        let mut state = self.state.borrow_mut();
        state.roots.entry(root_key.clone()).or_insert_with(|| Root {
            owner_id: params.owner_id,
            workspace_root_key: workspace_root_key.clone(),
            workspace_id: params.workspace_id.clone(),
            terminal_scope_id: scope_id.to_owned(),
            cwd: workspace_root_key,
            active_session_id: None,
            session_ids: Vec::new(),
        });
        Ok(root_key)
    }

    fn create_session(
        self: &Rc<Self>,
        root_key: &str,
        owner_id: u64,
        configured_shell: Option<String>,
        size: Size,
    ) -> CoreResult<String> {
        let mut session = {
            let mut state = self.state.borrow_mut();
            let number = state.next_session_number;
            state.next_session_number += 1;
            let root = &state.roots[root_key];
            let id = format!("terminal-{}-{number}", base36(now_millis()));
            Session {
                title: default_title(&id),
                id,
                workspace_id: root.workspace_id.clone(),
                terminal_scope_id: root.terminal_scope_id.clone(),
                root_key: root_key.to_owned(),
                cwd: root.cwd.clone(),
                owner_id,
                shell: resolve_shell(configured_shell.as_deref())?,
                status: Status::Running,
                replay: Replay::default(),
                exit_code: None,
                signal: None,
                size,
                pty: None,
            }
        };
        self.spawn_pty(&mut session);
        let id = session.id.clone();
        self.state.borrow_mut().sessions.insert(id.clone(), session);
        Ok(id)
    }

    /// Starts the session's shell. A failure leaves the session showing the error.
    fn spawn_pty(self: &Rc<Self>, session: &mut Session) {
        match pty::spawn(&session.shell, &session.cwd, session.size) {
            Ok((pty, events)) => {
                let pump =
                    tokio::task::spawn_local(pump(Rc::downgrade(self), session.id.clone(), events));
                session.pty = Some(LivePty {
                    pty,
                    pump: pump.abort_handle(),
                });
            }
            Err(message) => {
                session.status = Status::Error;
                session.replay.append(&format!("{message}\r\n"));
                self.peer.notify(
                    notifications::ERROR,
                    json!({ "ownerId": session.owner_id, "terminalId": session.id, "message": message }),
                );
            }
        }
    }

    fn set_active_session(&self, params: SetActiveParams) -> CoreResult<Value> {
        let mut state = self.state.borrow_mut();
        let session = state.owned_session(params.owner_id, &params.terminal_id)?;
        if session.workspace_id != params.workspace_id
            || session.terminal_scope_id != params.terminal_scope_id
        {
            return Err(CoreError::new(format!(
                "Terminal session {} does not belong to this thread",
                params.terminal_id
            )));
        }
        let root_key = session.root_key.clone();
        let root = state.root_mut(&root_key)?;
        if !root.session_ids.contains(&params.terminal_id) {
            return Err(unknown_session(&params.terminal_id));
        }
        root.active_session_id = Some(params.terminal_id);
        state.snapshot_root(&root_key)
    }

    fn restart(self: &Rc<Self>, params: SessionParams) -> CoreResult<Value> {
        let old_pty = self
            .state
            .borrow_mut()
            .owned_session_mut(params.owner_id, &params.terminal_id)?
            .pty
            .take();
        drop(old_pty);
        let shell = resolve_shell(params.shell.as_deref());
        let mut state = self.state.borrow_mut();
        let session = state.owned_session_mut(params.owner_id, &params.terminal_id)?;
        session.shell = shell?;
        session.title = default_title(&session.id);
        session.status = Status::Running;
        session.replay = Replay::default();
        session.exit_code = None;
        session.signal = None;
        session.size = normalize_size(params.size.unwrap_or(SizeParams {
            cols: Some(f64::from(session.size.cols)),
            rows: Some(f64::from(session.size.rows)),
        }));
        self.spawn_pty(session);
        let root_key = session.root_key.clone();
        state.snapshot_root(&root_key)
    }

    fn close(&self, params: SessionParams) -> CoreResult<Value> {
        let (session, snapshot) = {
            let mut state = self.state.borrow_mut();
            let root_key = state
                .owned_session(params.owner_id, &params.terminal_id)?
                .root_key
                .clone();
            state.root_mut(&root_key)?;
            let session = state
                .sessions
                .remove(&params.terminal_id)
                .expect("session exists");
            let root = state.roots.get_mut(&root_key).expect("root exists");
            let index = root.session_ids.iter().position(|id| *id == session.id);
            if let Some(index) = index {
                root.session_ids.remove(index);
            }
            if root.session_ids.is_empty() {
                state.roots.remove(&root_key);
                (session, Value::Null)
            } else {
                if root.active_session_id.as_deref() == Some(session.id.as_str()) {
                    // JS `indexOf` gives -1 for a missing id, which `Math.min` keeps at 0 or
                    // below; an `undefined` active id then falls back to the first tab.
                    root.active_session_id = index
                        .map(|index| index.min(root.session_ids.len() - 1))
                        .map(|index| root.session_ids[index].clone());
                }
                let snapshot = state.snapshot_root(&root_key)?;
                (session, snapshot)
            }
        };
        drop(session);
        Ok(snapshot)
    }

    /// Drops whole panels, hanging up their shells.
    fn remove_roots(&self, remove: impl Fn(&Root) -> bool) {
        let removed = {
            let mut state = self.state.borrow_mut();
            let keys: Vec<String> = state
                .roots
                .iter()
                .filter(|(_, root)| remove(root))
                .map(|(key, _)| key.clone())
                .collect();
            let mut removed = Vec::new();
            for key in keys {
                let root = state.roots.remove(&key).expect("root exists");
                for id in root.session_ids {
                    removed.extend(state.sessions.remove(&id));
                }
            }
            removed
        };
        drop(removed);
    }

    /// Output arrived for a session's current shell.
    fn on_output(&self, terminal_id: &str, data: String) {
        let owner_id = {
            let mut state = self.state.borrow_mut();
            let Some(session) = state.sessions.get_mut(terminal_id) else {
                return;
            };
            session.replay.append(&data);
            session.owner_id
        };
        self.peer.notify(
            notifications::DATA,
            json!({ "ownerId": owner_id, "terminalId": terminal_id, "data": data }),
        );
    }

    /// The shell exited on its own. Its handle goes, so a restart can never signal a
    /// recycled process id.
    fn on_exit(&self, terminal_id: &str, exit_code: i64, signal: Option<i64>) {
        let (owner_id, live) = {
            let mut state = self.state.borrow_mut();
            let Some(session) = state.sessions.get_mut(terminal_id) else {
                return;
            };
            session.status = Status::Exited;
            session.exit_code = Some(exit_code);
            session.signal = signal;
            (session.owner_id, session.pty.take())
        };
        let mut params =
            json!({ "ownerId": owner_id, "terminalId": terminal_id, "exitCode": exit_code });
        if let Some(signal) = signal {
            params["signal"] = json!(signal);
        }
        self.peer.notify(notifications::EXIT, params);
        // Last: this ends the task that is running now.
        drop(live);
    }
}

/// Forwards one shell's output and exit to the core. Output read together goes out as one
/// notification; once the shell exits, output still on its way gets a short grace period.
async fn pump(
    terminals: Weak<Terminals>,
    terminal_id: String,
    mut events: mpsc::UnboundedReceiver<PtyEvent>,
) {
    let mut decoder = Utf8Stream::default();
    let mut exit = None;
    let mut closed = false;
    let mut grace_deadline = None;
    loop {
        let first = match grace_deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, events.recv())
                .await
                .unwrap_or(None),
            None => events.recv().await,
        };
        // Every thread is done, or the grace period ran out.
        let ended = first.is_none();
        let mut text = String::new();
        let mut batch_bytes = 0;
        let mut next = first;
        while let Some(event) = next.take() {
            match event {
                PtyEvent::Output(bytes) => {
                    batch_bytes += bytes.len();
                    text.push_str(&decoder.decode(&bytes));
                }
                PtyEvent::Closed => closed = true,
                PtyEvent::Exited { exit_code, signal } => {
                    exit = Some((exit_code, signal));
                    grace_deadline = Some(tokio::time::Instant::now() + EXIT_OUTPUT_GRACE);
                }
            }
            if batch_bytes < MAX_BATCH_BYTES {
                next = events.try_recv().ok();
            }
        }
        let Some(terminals) = terminals.upgrade() else {
            return;
        };
        if !text.is_empty() {
            terminals.on_output(&terminal_id, text);
        }
        if let Some((exit_code, signal)) = exit.filter(|_| closed || ended) {
            terminals.on_exit(&terminal_id, exit_code, signal);
            return;
        }
        if ended {
            return;
        }
    }
}

impl State {
    fn owned_session(&self, owner_id: u64, terminal_id: &str) -> CoreResult<&Session> {
        self.sessions
            .get(terminal_id)
            .filter(|session| session.owner_id == owner_id)
            .ok_or_else(|| unknown_session(terminal_id))
    }

    fn owned_session_mut(&mut self, owner_id: u64, terminal_id: &str) -> CoreResult<&mut Session> {
        self.sessions
            .get_mut(terminal_id)
            .filter(|session| session.owner_id == owner_id)
            .ok_or_else(|| unknown_session(terminal_id))
    }

    fn root_mut(&mut self, root_key: &str) -> CoreResult<&mut Root> {
        self.roots
            .get_mut(root_key)
            .ok_or_else(|| CoreError::new(format!("Unknown terminal root: {root_key}")))
    }

    fn snapshot_root(&self, root_key: &str) -> CoreResult<Value> {
        let root = self
            .roots
            .get(root_key)
            .ok_or_else(|| CoreError::new(format!("Unknown terminal root: {root_key}")))?;
        let sessions: Vec<&Session> = root
            .session_ids
            .iter()
            .filter_map(|id| self.sessions.get(id))
            .collect();
        let active_session_id = root
            .active_session_id
            .as_ref()
            .filter(|active| sessions.iter().any(|session| session.id == **active))
            .or_else(|| sessions.first().map(|session| &session.id))
            .cloned()
            .unwrap_or_default();
        Ok(json!({
            "workspaceId": root.workspace_id,
            "rootKey": root_key,
            "activeSessionId": active_session_id,
            "sessions": sessions.iter().map(|session| session.snapshot()).collect::<Vec<_>>(),
        }))
    }
}

impl Session {
    fn snapshot(&self) -> Value {
        let mut snapshot = json!({
            "id": self.id,
            "workspaceId": self.workspace_id,
            "cwd": self.cwd,
            "shell": self.shell,
            "title": self.title,
            "status": match self.status {
                Status::Running => "running",
                Status::Exited => "exited",
                Status::Error => "error",
            },
            "replay": self.replay.text,
            "truncated": self.replay.truncated,
        });
        if let Some(exit_code) = self.exit_code {
            snapshot["exitCode"] = json!(exit_code);
        }
        if let Some(signal) = self.signal {
            snapshot["signal"] = json!(signal);
        }
        snapshot
    }
}

fn unknown_session(terminal_id: &str) -> CoreError {
    CoreError::new(format!("Unknown terminal session: {terminal_id}"))
}

/// The last output a session keeps for redrawing, cut from the front like
/// `appendTerminalReplay`.
#[derive(Default)]
struct Replay {
    text: String,
    utf16_len: usize,
    truncated: bool,
}

impl Replay {
    fn append(&mut self, data: &str) {
        self.text.push_str(data);
        self.utf16_len += data.encode_utf16().count();
        if self.utf16_len <= REPLAY_LIMIT {
            return;
        }
        let mut excess = self.utf16_len - REPLAY_LIMIT;
        let mut cut = 0;
        for character in self.text.chars() {
            if excess == 0 {
                break;
            }
            // Half of a surrogate pair cannot stay behind in a Rust string, so a cut through
            // one drops the whole character.
            let units = character.len_utf16();
            excess = excess.saturating_sub(units);
            self.utf16_len -= units;
            cut += character.len_utf8();
        }
        self.text.drain(..cut);
        self.truncated = true;
    }
}

/// Decodes UTF-8 output that may split a character across reads, replacing invalid bytes
/// with U+FFFD as Node's decoder did.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn decode(&mut self, bytes: &[u8]) -> String {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(bytes);
        let mut text = String::with_capacity(input.len());
        let mut rest = input.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    return text;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    text.push_str(std::str::from_utf8(valid).expect("checked as valid"));
                    match error.error_len() {
                        Some(invalid) => {
                            text.push('\u{FFFD}');
                            rest = &after[invalid..];
                        }
                        None => {
                            self.pending = after.to_vec();
                            return text;
                        }
                    }
                }
            }
        }
    }
}

fn normalize_size(size: SizeParams) -> Size {
    Size {
        cols: clamp(size.cols, DEFAULT_SIZE.cols, 10, 500),
        rows: clamp(size.rows, DEFAULT_SIZE.rows, 4, 200),
    }
}

fn clamp(value: Option<f64>, fallback: u16, min: u16, max: u16) -> u16 {
    match value {
        Some(value) if value.is_finite() => {
            value.floor().clamp(f64::from(min), f64::from(max)) as u16
        }
        _ => fallback,
    }
}

fn default_title(id: &str) -> String {
    format!("Terminal {}", id.rsplit('-').next().unwrap_or_default())
        .trim()
        .to_owned()
}

/// The first `limit` UTF-16 code units, as `slice(0, limit)`, never splitting a character.
fn take_utf16(text: &str, limit: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= limit
        })
        .collect()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    loop {
        digits.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.reverse();
    String::from_utf8(digits).expect("ASCII digits")
}

/// The real path of a workspace folder, as `realpathSync.native` gave it, or the resolved
/// path when it cannot be resolved.
fn normalize_root_key(workspace_path: &str) -> String {
    crate::paths::display(&crate::paths::canonical(workspace_path))
}

fn ensure_directory(directory: &str) -> CoreResult<()> {
    let metadata =
        std::fs::metadata(directory).map_err(|error| node_error(&error, "stat", directory))?;
    if !metadata.is_dir() {
        return Err(CoreError::new(format!(
            "Workspace is not a directory: {directory}"
        )));
    }
    Ok(())
}

/// The setting, then `$SHELL`, then the platform's usual shell. Off Windows it must be an
/// absolute path to an executable file.
fn resolve_shell(configured: Option<&str>) -> CoreResult<String> {
    let shell = configured
        .map(js::trim)
        .filter(|shell| !shell.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            std::env::var("SHELL")
                .ok()
                .filter(|shell| !shell.is_empty())
        })
        .unwrap_or_else(default_shell);
    if cfg!(windows) {
        return Ok(shell);
    }
    if !Path::new(&shell).is_absolute() {
        return Err(CoreError::new(format!(
            "Integrated terminal shell must be an absolute path: {shell}"
        )));
    }
    ensure_executable(&shell)?;
    Ok(shell)
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("ComSpec")
            .ok()
            .filter(|shell| !shell.is_empty())
            .unwrap_or_else(|| "cmd.exe".into())
    } else if cfg!(target_os = "macos") {
        "/bin/zsh".into()
    } else {
        "/bin/bash".into()
    }
}

#[cfg(unix)]
fn ensure_executable(shell: &str) -> CoreResult<()> {
    let path = std::ffi::CString::new(shell).map_err(|_| {
        CoreError::new(format!(
            "Integrated terminal shell is not a valid path: {shell}"
        ))
    })?;
    if unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0 {
        return Ok(());
    }
    Err(node_error(
        &std::io::Error::last_os_error(),
        "access",
        shell,
    ))
}

#[cfg(not(unix))]
fn ensure_executable(_shell: &str) -> CoreResult<()> {
    Ok(())
}

/// A file system error worded the way Node words it, such as
/// `ENOENT: no such file or directory, access '/bin/zsh'`.
fn node_error(error: &std::io::Error, syscall: &str, path: &str) -> CoreError {
    let (code, description) = match error.kind() {
        std::io::ErrorKind::NotFound => ("ENOENT", "no such file or directory".to_owned()),
        std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied".to_owned()),
        std::io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory".to_owned()),
        _ => ("EIO", error.to_string()),
    };
    let mut error = CoreError::new(format!("{code}: {description}, {syscall} '{path}'"));
    let mut data = serde_json::Map::new();
    data.insert("code".into(), json!(code));
    data.insert("syscall".into(), json!(syscall));
    data.insert("path".into(), json!(path));
    error.data = Some(data);
    error
}

#[cfg(all(test, unix))]
mod tests;
