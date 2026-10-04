//! pi-gui's app logic in Rust. Under Electron it runs as the `pi-gui-core` child process and
//! answers JSON-RPC calls from Electron main (`rpc::serve`); under Tauri the same `Core` runs
//! in process. Parts move over from Electron main one at a time.
//!
//! The core runs on one thread with a local async executor, like Node: state lives in
//! `RefCell`s, and a call runs until its first `.await`.

pub mod error;
pub mod json_text;
pub mod persistence;
pub mod rpc;

use error::{CoreError, CoreResult};
use persistence::catalog::CatalogStore;
use rpc::{LocalFuture, Peer, Service};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use std::cell::{Cell, OnceCell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;

/// Every method the app can call. Kept in step with `apps/desktop/core-process/protocol.ts`;
/// a unit test there checks the two lists match.
pub mod methods {
    pub const INITIALIZE: &str = "core.initialize";
    pub const SHUTDOWN: &str = "core.shutdown";
    pub const CATALOG_CALL: &str = "catalog.call";
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    /// The app's profile folder; saved data lives here under the same names as before.
    user_data_dir: PathBuf,
}

/// Parts that exist once the app has said where its profile folder is.
struct Parts {
    catalog: RefCell<CatalogStore>,
}

pub struct Core {
    /// Calls and notifications to the app.
    #[allow(dead_code)]
    peer: Peer,
    parts: OnceCell<Parts>,
    stopping: Cell<bool>,
}

impl Core {
    pub fn new(peer: Peer) -> Rc<Self> {
        Rc::new(Self {
            peer,
            parts: OnceCell::new(),
            stopping: Cell::new(false),
        })
    }

    fn parts(&self) -> CoreResult<&Parts> {
        self.parts
            .get()
            .ok_or_else(|| CoreError::new("pi-gui core is not initialized"))
    }

    /// Calls whose answer is ready at once. They run the moment they arrive, so a change is
    /// visible to every call after it.
    fn call_now(&self, method: &str, params: Value) -> Option<CoreResult<Value>> {
        Some(match method {
            methods::INITIALIZE => (|| {
                let params: InitializeParams = parse(params)?;
                let parts = Parts {
                    catalog: RefCell::new(CatalogStore::new(
                        params.user_data_dir.join("catalogs.json"),
                    )),
                };
                self.parts
                    .set(parts)
                    .map_err(|_| CoreError::new("pi-gui core is already initialized"))?;
                Ok(Value::Null)
            })(),
            methods::SHUTDOWN => {
                self.stopping.set(true);
                Ok(Value::Null)
            }
            methods::CATALOG_CALL => self.parts().and_then(|parts| {
                persistence::catalog_calls::call(&mut parts.catalog.borrow_mut(), parse(params)?)
            }),
            _ => return None,
        })
    }
}

impl Service for Core {
    fn call(self: Rc<Self>, method: String, params: Value) -> LocalFuture<CoreResult<Value>> {
        let result = self
            .call_now(&method, params)
            .unwrap_or_else(|| Err(CoreError::new(format!("Unknown RPC method: {method}"))));
        Box::pin(std::future::ready(result))
    }

    fn notification(self: Rc<Self>, method: String, _params: Value) {
        eprintln!("[pi-gui-core] no handler for notification {method}");
    }

    fn stopping(&self) -> bool {
        self.stopping.get()
    }
}

pub(crate) fn parse<T: DeserializeOwned>(params: Value) -> CoreResult<T> {
    serde_json::from_value(params)
        .map_err(|error| CoreError::new(format!("Invalid parameters: {error}")))
}

/// Runs the core over a pair of streams until the input closes or the app asks it to stop.
pub fn run_process(
    input: impl tokio::io::AsyncBufRead + Unpin,
    output: impl tokio::io::AsyncWrite + Unpin + 'static,
) -> std::io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let local = tokio::task::LocalSet::new();
    local.block_on(&runtime, async move {
        let (peer, lines) = Peer::new();
        let core = Core::new(peer.clone());
        let writer = tokio::task::spawn_local(rpc::write_lines(lines, output));
        let served = rpc::serve(peer, core, input).await;
        // The core and peer are dropped now, which lets the writer finish what is queued.
        let written = writer.await.unwrap_or(Ok(()));
        served.and(written)
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pi-gui-core-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initializes_answers_catalog_calls_and_stops_on_shutdown() {
        let dir = test_support::temp_dir("core");
        let input = [
            json!({ "id": 1, "method": "catalog.call", "params": { "path": "getSessionFile" } }),
            json!({ "id": 2, "method": "core.initialize", "params": { "userDataDir": dir } }),
            json!({ "id": 3, "method": "catalog.call",
                    "params": { "path": "sessions.listSessions", "args": [] } }),
            json!({ "id": 4, "method": "nope" }),
            json!({ "id": 5, "method": "core.shutdown" }),
            json!({ "id": 6, "method": "core.shutdown" }),
        ]
        .map(|message| message.to_string())
        .join("\n");
        let replies = rpc::testing::run_lines(Core::new, input + "\n");
        assert_eq!(
            replies[0]["error"]["message"],
            "pi-gui core is not initialized"
        );
        assert_eq!(replies[1], json!({ "id": 2, "result": null }));
        assert_eq!(
            replies[2],
            json!({ "id": 3, "result": { "value": { "sessions": [] } } })
        );
        assert_eq!(replies[3]["error"]["message"], "Unknown RPC method: nope");
        assert_eq!(replies[4], json!({ "id": 5, "result": null }));
        assert_eq!(replies.len(), 5);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
