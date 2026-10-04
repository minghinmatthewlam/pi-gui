//! The wire format shared with `apps/desktop/rpc/rpc-peer.ts`: one JSON message per line.
//! A request is `{ id, method, params? }`, a reply `{ id, result }` or `{ id, error }`, and a
//! notification has no `id`. Both sides can call each other with many calls in flight.
//!
//! Everything runs on one thread, like Node's event loop: a call starts the moment it arrives
//! and runs until its first `.await`, so calls start in arrival order and a notification sent
//! before a call is always handled first. That keeps the interleaving the TypeScript code it
//! replaces relied on.

use crate::error::{CoreError, CoreResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

pub type LocalFuture<T> = Pin<Box<dyn Future<Output = T>>>;

const CANCEL_METHOD: &str = "$/cancel";

/// What the other side can call. Implemented by the core.
pub trait Service: 'static {
    fn call(self: Rc<Self>, method: String, params: Value) -> LocalFuture<CoreResult<Value>>;
    fn notification(self: Rc<Self>, method: String, params: Value);
    /// True once the app asked the core to stop; no more lines are read.
    fn stopping(&self) -> bool;
}

/// This side of the pipe: calls and notifications to the app.
#[derive(Clone)]
pub struct Peer {
    inner: Rc<PeerInner>,
}

struct PeerInner {
    out: mpsc::UnboundedSender<String>,
    next_id: Cell<u64>,
    pending: RefCell<HashMap<u64, oneshot::Sender<CoreResult<Value>>>>,
    running: RefCell<HashMap<u64, AbortHandle>>,
    closed: RefCell<Option<String>>,
}

impl Peer {
    /// A peer whose lines go to the returned receiver; `write_lines` drains it to a stream.
    pub fn new() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (out, lines) = mpsc::unbounded_channel();
        let peer = Self {
            inner: Rc::new(PeerInner {
                out,
                next_id: Cell::new(1),
                pending: RefCell::new(HashMap::new()),
                running: RefCell::new(HashMap::new()),
                closed: RefCell::new(None),
            }),
        };
        (peer, lines)
    }

    pub async fn request(&self, method: &str, params: Value) -> CoreResult<Value> {
        if let Some(reason) = self.inner.closed.borrow().clone() {
            return Err(closed_error(&reason));
        }
        let id = self.inner.next_id.get();
        self.inner.next_id.set(id + 1);
        let (reply, answer) = oneshot::channel();
        self.inner.pending.borrow_mut().insert(id, reply);
        self.send(&json!({ "id": id, "method": method, "params": params }));
        // Dropping this future (the caller gave up) tells the app to stop working on it.
        let mut guard = CancelOnDrop {
            peer: self.clone(),
            id,
            answered: false,
        };
        let result = answer
            .await
            .unwrap_or_else(|_| Err(closed_error("connection closed")));
        guard.answered = true;
        result
    }

    pub fn notify(&self, method: &str, params: Value) {
        if self.inner.closed.borrow().is_some() {
            return;
        }
        self.send(&json!({ "method": method, "params": params }));
    }

    /// Rejects calls still waiting for a reply and stops calls the app made.
    pub fn close(&self, reason: &str) {
        if self.inner.closed.borrow().is_some() {
            return;
        }
        *self.inner.closed.borrow_mut() = Some(reason.to_owned());
        for (_, reply) in self.inner.pending.borrow_mut().drain() {
            let _ = reply.send(Err(closed_error(reason)));
        }
        for (_, running) in self.inner.running.borrow_mut().drain() {
            running.abort();
        }
    }

    fn send(&self, message: &Value) {
        let line = serde_json::to_string(message).unwrap_or_else(|error| {
            serde_json::to_string(&json!({
                "method": "core.diagnostic",
                "params": format!("Could not encode a message: {error}"),
            }))
            .expect("a diagnostic always encodes")
        });
        let _ = self.inner.out.send(line);
    }

    fn reply(&self, id: u64, result: CoreResult<Value>) {
        if self.inner.closed.borrow().is_some() {
            return;
        }
        let message = match result {
            Ok(value) => json!({ "id": id, "result": value }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        self.send(&message);
    }

    fn settle(&self, id: u64, result: CoreResult<Value>) {
        if let Some(reply) = self.inner.pending.borrow_mut().remove(&id) {
            let _ = reply.send(result);
        }
    }
}

struct CancelOnDrop {
    peer: Peer,
    id: u64,
    answered: bool,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.answered {
            return;
        }
        if self
            .peer
            .inner
            .pending
            .borrow_mut()
            .remove(&self.id)
            .is_some()
        {
            self.peer.notify(CANCEL_METHOD, json!({ "id": self.id }));
        }
    }
}

fn closed_error(reason: &str) -> CoreError {
    CoreError::named(
        "RpcConnectionClosedError",
        format!("pi-gui connection closed: {reason}"),
    )
}

#[derive(Deserialize)]
struct Incoming {
    id: Option<u64>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
    result: Option<Value>,
    error: Option<CoreError>,
}

/// Reads messages from `input` until it closes or the service stops, then closes the peer.
/// Must run inside a `tokio::task::LocalSet`.
pub async fn serve<S: Service>(
    peer: Peer,
    service: Rc<S>,
    input: impl AsyncBufRead + Unpin,
) -> std::io::Result<()> {
    let mut lines = input.lines();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message = match serde_json::from_str::<Incoming>(
            &crate::json_text::replace_lone_surrogates(line),
        ) {
            Ok(message) => message,
            Err(error) => {
                // A call the core cannot read still gets an answer, or its caller would wait
                // forever. The app always writes `id` first.
                match leading_id(line) {
                    Some(id) if line.contains("\"method\"") => peer.reply(
                        id,
                        Err(CoreError::new(format!("Could not read the call: {error}"))),
                    ),
                    _ => eprintln!(
                        "[pi-gui-core] ignored a line that is not a message: {}",
                        line.chars().take(200).collect::<String>()
                    ),
                }
                continue;
            }
        };
        match (message.id, message.method) {
            (Some(id), Some(method)) => start_call(&peer, &service, id, method, message.params),
            (None, Some(method)) if method == CANCEL_METHOD => {
                let id = message.params.get("id").and_then(Value::as_u64);
                if let Some(running) = id.and_then(|id| peer.inner.running.borrow_mut().remove(&id))
                {
                    running.abort();
                }
            }
            (None, Some(method)) => service.clone().notification(method, message.params),
            (Some(id), None) => match message.error {
                Some(error) => peer.settle(id, Err(error)),
                None => peer.settle(id, Ok(message.result.unwrap_or(Value::Null))),
            },
            (None, None) => {}
        }
        if service.stopping() {
            break;
        }
        // Let calls that are ready continue before the next message, as a pipe would.
        tokio::task::yield_now().await;
    }
    peer.close("the app closed the pipe");
    Ok(())
}

fn start_call<S: Service>(peer: &Peer, service: &Rc<S>, id: u64, method: String, params: Value) {
    let mut call = service.clone().call(method, params);
    // Run the call now, up to its first wait, so calls start in arrival order.
    let mut context = Context::from_waker(Waker::noop());
    if let Poll::Ready(result) = call.as_mut().poll(&mut context) {
        peer.reply(id, result);
        return;
    }
    let task_peer = peer.clone();
    let task = tokio::task::spawn_local(async move {
        let result = call.await;
        task_peer.inner.running.borrow_mut().remove(&id);
        task_peer.reply(id, result);
    });
    peer.inner
        .running
        .borrow_mut()
        .insert(id, task.abort_handle());
}

/// Writes queued lines to `output` until every `Peer` clone is dropped.
pub async fn write_lines(
    mut lines: mpsc::UnboundedReceiver<String>,
    mut output: impl AsyncWrite + Unpin,
) -> std::io::Result<()> {
    while let Some(line) = lines.recv().await {
        output.write_all(line.as_bytes()).await?;
        output.write_all(b"\n").await?;
        // Batch whatever else is already queued into the same flush.
        while let Ok(line) = lines.try_recv() {
            output.write_all(line.as_bytes()).await?;
            output.write_all(b"\n").await?;
        }
        output.flush().await?;
    }
    Ok(())
}

fn leading_id(line: &str) -> Option<u64> {
    let rest = line.strip_prefix("{\"id\":")?;
    let end = rest.find(|c: char| !c.is_ascii_digit())?;
    rest[..end].parse().ok()
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// Runs `service` over the given input lines and returns every line it wrote.
    pub fn run_lines<S: Service>(make: impl FnOnce(Peer) -> Rc<S>, input: String) -> Vec<Value> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        let output = local.block_on(&runtime, async move {
            let (peer, lines) = Peer::new();
            let service = make(peer.clone());
            let mut written = Vec::new();
            let writer = write_lines(lines, &mut written);
            let reader = async {
                serve(peer, service, input.as_bytes()).await.unwrap();
                // Let spawned calls finish, then release the last peer so the writer ends.
                tokio::task::yield_now().await;
            };
            let (_, written_result) = tokio::join!(reader, writer);
            written_result.unwrap();
            written
        });
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::run_lines;
    use super::*;
    use std::time::Duration;

    struct Echo {
        peer: Peer,
        seen: RefCell<Vec<String>>,
        stop: Cell<bool>,
    }

    impl Service for Echo {
        fn call(self: Rc<Self>, method: String, params: Value) -> LocalFuture<CoreResult<Value>> {
            Box::pin(async move {
                self.seen.borrow_mut().push(format!("start {method}"));
                match method.as_str() {
                    "slow" => {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok(json!("slow done"))
                    }
                    "ask" => self.peer.request("app.question", params).await,
                    "seen" => Ok(json!(*self.seen.borrow())),
                    "stop" => {
                        self.stop.set(true);
                        Ok(Value::Null)
                    }
                    _ => Err(CoreError::new(format!("Unknown RPC method: {method}"))),
                }
            })
        }

        fn notification(self: Rc<Self>, method: String, _params: Value) {
            self.seen.borrow_mut().push(format!("note {method}"));
        }

        fn stopping(&self) -> bool {
            self.stop.get()
        }
    }

    fn echo(peer: Peer) -> Rc<Echo> {
        Rc::new(Echo {
            peer,
            seen: RefCell::new(Vec::new()),
            stop: Cell::new(false),
        })
    }

    #[test]
    fn calls_start_in_arrival_order_and_slow_ones_do_not_block_others() {
        let input = [
            json!({ "id": 1, "method": "slow" }),
            json!({ "method": "config" }),
            json!({ "id": 2, "method": "seen" }),
            json!({ "id": 3, "method": "nope" }),
        ]
        .map(|message| message.to_string())
        .join("\n");
        let replies = run_lines(echo, input + "\n");
        // The fast call answers before the slow one that arrived first.
        assert_eq!(
            replies[0],
            json!({ "id": 2, "result": ["start slow", "note config", "start seen"] })
        );
        assert_eq!(replies[1]["error"]["message"], "Unknown RPC method: nope");
        // Input ended, so the slow call was stopped rather than answered.
        assert_eq!(replies.len(), 2);
    }

    #[test]
    fn the_core_can_call_the_app_and_wait_for_its_answer() {
        let input = [
            json!({ "id": 1, "method": "ask", "params": "why" }),
            json!({ "id": 1, "result": "because" }),
            json!({ "id": 2, "method": "stop" }),
        ]
        .map(|message| message.to_string())
        .join("\n");
        let replies = run_lines(echo, input + "\n");
        assert_eq!(
            replies[0],
            json!({ "id": 1, "method": "app.question", "params": "why" })
        );
        assert_eq!(replies[1], json!({ "id": 1, "result": "because" }));
        assert_eq!(replies[2], json!({ "id": 2, "result": null }));
    }

    #[test]
    fn a_call_that_cannot_be_read_still_gets_an_error_reply() {
        let replies = run_lines(
            echo,
            "noise\n{\"id\":7,\"method\":\"x\",\"params\":{\"bad\n".into(),
        );
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["id"], 7);
        assert!(replies[0]["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Could not read the call"));
    }
}
