//! pi-gui's app logic in Rust. Under Electron it runs as the `pi-gui-core` child process and
//! answers JSON-RPC calls from Electron main; under Tauri the same `Core::dispatch` will be
//! called in process. Parts move over from Electron main one at a time.

pub mod error;
pub mod persistence;
pub mod rpc;

use error::{CoreError, CoreResult};
use persistence::catalog::CatalogStore;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

/// Every method the app can call. Kept in step with `apps/desktop/core-process/protocol.ts`.
pub mod methods {
    pub const INITIALIZE: &str = "core.initialize";
    pub const SHUTDOWN: &str = "core.shutdown";
    pub const CATALOG_CALL: &str = "catalog.call";
    pub const ALL: &[&str] = &[INITIALIZE, SHUTDOWN, CATALOG_CALL];
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    /// The app's profile folder; saved data lives here under the same names as before.
    user_data_dir: PathBuf,
}

#[derive(Default)]
pub struct Core {
    catalog: Option<CatalogStore>,
    shutting_down: bool,
}

impl Core {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn shutting_down(&self) -> bool {
        self.shutting_down
    }

    pub fn dispatch(&mut self, method: &str, params: Value) -> CoreResult<Value> {
        match method {
            methods::INITIALIZE => {
                let params: InitializeParams = parse(params)?;
                self.catalog = Some(CatalogStore::new(
                    params.user_data_dir.join("catalogs.json"),
                ));
                Ok(Value::Null)
            }
            methods::SHUTDOWN => {
                self.shutting_down = true;
                Ok(Value::Null)
            }
            methods::CATALOG_CALL => {
                let catalog = self
                    .catalog
                    .as_mut()
                    .ok_or_else(|| CoreError::new("pi-gui core is not initialized"))?;
                persistence::catalog_calls::call(catalog, parse(params)?)
            }
            other => Err(CoreError::new(format!("Unknown RPC method: {other}"))),
        }
    }
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> CoreResult<T> {
    serde_json::from_value(params)
        .map_err(|error| CoreError::new(format!("Invalid parameters: {error}")))
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
