//! Turn checkpoints: a snapshot of the checkout at each turn boundary, so the app can show
//! what one turn changed (the turn changes card and the "Last turn" review scope).
//!
//! pi asks Electron main to capture at every boundary and waits; main forwards the call here.
//! When pi gives up (its deadline passed or the run stopped), main cancels the call with
//! `$/cancel`. That stops the capture, but the boundary still records why it has no snapshot,
//! as the TypeScript store did when its signal aborted.

mod capture;
mod git;
pub mod metadata;
pub mod store;
mod sync;

use crate::error::{CoreError, CoreResult};
use crate::Core;
use metadata::Target;
use serde::Deserialize;
use serde_json::{json, Value};
use std::rc::Rc;
use std::time::Duration;
use store::{Boundary, Limits, Retention, TurnCheckpoints};
use sync::AbortController;

pub use crate::methods::checkpoints as methods;

/// Test and tuning options from `core.initialize`; the app passes none.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default)]
    pub limits: Limits,
    #[serde(default)]
    pub retention: Retention,
}

pub fn open(user_data_dir: &std::path::Path, options: Options) -> CoreResult<Rc<TurnCheckpoints>> {
    TurnCheckpoints::new(user_data_dir, options.limits, options.retention).map(Rc::new)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordParams {
    boundary: Boundary,
    /// The caller had already given up when it asked, like an aborted `AbortSignal`.
    #[serde(default)]
    aborted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureParams {
    workspace_path: String,
    #[serde(default)]
    aborted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetParams {
    target: Target,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveParams {
    target: Target,
    checkout_id: String,
    checkpoint_id: Option<String>,
}

pub async fn call(core: Rc<Core>, method: String, params: Value) -> CoreResult<Value> {
    let store = core.parts()?.checkpoints.clone();
    match method.as_str() {
        methods::RECORD_BOUNDARY => {
            let params: RecordParams = crate::parse(params)?;
            let controller = AbortController::new();
            if params.aborted {
                controller.abort();
            }
            // The boundary runs on its own task: if this call is cancelled, dropping
            // `controller` stops the capture and the boundary still records the outcome.
            let work = store.record_boundary(params.boundary, controller.signal());
            tokio::task::spawn_local(work).await.map_err(stopped)??;
            Ok(Value::Null)
        }
        methods::CAPTURE => {
            let params: CaptureParams = crate::parse(params)?;
            let controller = AbortController::new();
            if params.aborted {
                controller.abort();
            }
            let signal = controller.signal();
            let timeout = Duration::from_millis(store.limits.timeout_ms);
            // On its own task too, so a cancelled capture still removes its scratch files.
            let work = async move {
                store
                    .capture(&params.workspace_path, &signal, timeout)
                    .await
            };
            let capture = tokio::task::spawn_local(work).await.map_err(stopped)?;
            Ok(json!(capture))
        }
        methods::LIST => {
            let params: TargetParams = crate::parse(params)?;
            Ok(json!(store.list(&params.target).await?))
        }
        methods::LIST_TURNS => {
            let params: TargetParams = crate::parse(params)?;
            Ok(json!(store.list_turns(&params.target).await?))
        }
        methods::RESOLVE => {
            let params: ResolveParams = crate::parse(params)?;
            Ok(store
                .resolve(
                    &params.target,
                    &params.checkout_id,
                    params.checkpoint_id.as_deref(),
                )
                .await)
        }
        methods::MAINTAIN => {
            store.maintain().await?;
            Ok(Value::Null)
        }
        _ => Err(CoreError::new(format!("Unknown RPC method: {method}"))),
    }
}

fn stopped(error: tokio::task::JoinError) -> CoreError {
    CoreError::new(format!("Turn checkpoint work stopped: {error}"))
}

/// The current time as JavaScript's `new Date().toISOString()` writes it.
pub fn iso_now() -> String {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_millis(since.as_millis() as i64)
}

fn iso_from_millis(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let rest = millis.rem_euclid(86_400_000);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1_000 % 60,
        rest % 1_000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_dates_like_javascript() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_790_000_000_123),
            "2026-09-21T14:13:20.123Z"
        );
        assert_eq!(iso_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    /// What happens when pi gives up on a boundary: main cancels the call with `$/cancel`,
    /// which drops it. The boundary is still recorded, with an aborted capture.
    #[test]
    fn a_cancelled_boundary_is_still_recorded_as_aborted() {
        use crate::rpc::{Peer, Service};
        let dir = crate::test_support::temp_dir("checkpoints-cancel");
        let checkout = dir.join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "--template=", "--initial-branch=main"])
            .current_dir(&checkout)
            .output()
            .unwrap();
        assert!(init.status.success());
        std::fs::write(checkout.join("file.txt"), "contents").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        let records = local.block_on(&runtime, async {
            let core = Core::new(Peer::new().0);
            let call = |method: &str, params: Value| core.clone().call(method.into(), params);
            call(
                "core.initialize",
                json!({ "userDataDir": dir.join("data") }),
            )
            .await
            .unwrap();
            let target = json!({ "workspaceId": "repo", "sessionId": "task" });
            let boundary = json!({
                "sessionRef": target,
                "workspace": { "workspaceId": "repo", "path": checkout },
                "runtimeGeneration": "generation", "runId": "run",
                "timestamp": "2026-09-22T12:00:00.000Z",
                "opening": {
                    "checkpointId": "one", "beforeEntryId": null,
                    "startedAt": "2026-09-22T12:00:00.000Z"
                },
            });
            let mut recording = call(methods::RECORD_BOUNDARY, json!({ "boundary": boundary }));
            // Start the call, as the RPC layer does, then drop it as `$/cancel` does.
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(recording.as_mut().poll(&mut context).is_pending());
            drop(recording);
            let records = call(methods::LIST, json!({ "target": target }))
                .await
                .unwrap();
            // The aborted boundary starts a background inventory build; let it finish before
            // the folders are removed.
            core.parts().unwrap().checkpoints.captures_idle().await;
            records
        });
        assert_eq!(records[0]["checkpointId"], "one");
        assert_eq!(records[0]["before"]["code"], "capture-aborted");
        let saved = std::fs::read_to_string(dir.join("data/turn-checkpoints/checkpoints.json"));
        assert!(saved.unwrap().contains("capture-aborted"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
