//! The `catalog.call` method: the same `{ path, args, undefinedAt }` calls the pi host
//! already makes for catalog storage (`apps/desktop/pi-host/remote-catalog.ts`), so the app
//! and pi reach the Rust catalog through one shape.

use super::catalog::{CatalogStore, SessionEntry, SessionRef, WorktreeEntry};
use crate::error::{CoreError, CoreResult};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCall {
    path: String,
    #[serde(default)]
    args: Vec<Value>,
    #[serde(default)]
    undefined_at: Vec<usize>,
}

struct Args {
    values: Vec<Option<Value>>,
}

impl Args {
    fn new(call: CatalogCall) -> Self {
        let mut values: Vec<Option<Value>> = call.args.into_iter().map(Some).collect();
        for index in call.undefined_at {
            if let Some(slot) = values.get_mut(index) {
                *slot = None;
            }
        }
        Self { values }
    }

    fn required<T: DeserializeOwned>(&self, index: usize, name: &str) -> CoreResult<T> {
        let value = self
            .values
            .get(index)
            .cloned()
            .flatten()
            .ok_or_else(|| CoreError::new(format!("Missing catalog argument {name}")))?;
        serde_json::from_value(value)
            .map_err(|error| CoreError::new(format!("Invalid catalog argument {name}: {error}")))
    }

    /// An optional folder filter. Like the TypeScript store, an empty id means "all".
    fn workspace_filter(&self, index: usize) -> CoreResult<Option<String>> {
        match self.values.get(index).cloned().flatten() {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(id)) if id.is_empty() => Ok(None),
            Some(Value::String(id)) => Ok(Some(id)),
            Some(_) => Err(CoreError::new("Invalid catalog argument workspaceId")),
        }
    }
}

/// `{}` for undefined, `{ value }` otherwise: the `EncodedResult` shape in `protocol.ts`.
fn value(result: impl Serialize) -> CoreResult<Value> {
    Ok(json!({ "value": result }))
}

fn optional(result: Option<impl Serialize>) -> CoreResult<Value> {
    match result {
        Some(found) => value(found),
        None => Ok(json!({})),
    }
}

fn done() -> CoreResult<Value> {
    Ok(json!({}))
}

pub fn call(store: &mut CatalogStore, call: CatalogCall) -> CoreResult<Value> {
    let path = call.path.clone();
    let args = Args::new(call);
    match path.as_str() {
        "workspaces.listWorkspaces" => value(json!({ "workspaces": store.list_workspaces()? })),
        "workspaces.getWorkspace" => {
            optional(store.get_workspace(&args.required::<String>(0, "workspaceId")?)?)
        }
        "workspaces.upsertWorkspace" => {
            store.upsert_workspace(args.required(0, "entry")?)?;
            done()
        }
        "workspaces.deleteWorkspace" => {
            store.delete_workspace(&args.required::<String>(0, "workspaceId")?)?;
            done()
        }
        "sessions.listSessions" => {
            let filter = args.workspace_filter(0)?;
            value(json!({ "sessions": store.list_sessions(filter.as_deref())? }))
        }
        "sessions.getSession" => {
            optional(store.get_session(&args.required::<SessionRef>(0, "sessionRef")?)?)
        }
        "sessions.upsertSession" => {
            store.upsert_session(args.required::<SessionEntry>(0, "entry")?)?;
            done()
        }
        "sessions.deleteSession" => {
            store.delete_session(&args.required::<SessionRef>(0, "sessionRef")?)?;
            done()
        }
        "worktrees.listWorktrees" => {
            let filter = args.workspace_filter(0)?;
            value(json!({ "worktrees": store.list_worktrees(filter.as_deref())? }))
        }
        "worktrees.getWorktree" => {
            optional(store.get_worktree(&args.required::<String>(0, "worktreeId")?)?)
        }
        "worktrees.upsertWorktree" => {
            store.upsert_worktree(args.required::<WorktreeEntry>(0, "entry")?)?;
            done()
        }
        "worktrees.deleteWorktree" => {
            store.delete_worktree(&args.required::<String>(0, "worktreeId")?)?;
            done()
        }
        "worktrees.replaceWorkspaceWorktrees" => {
            store.replace_workspace_worktrees(
                &args.required::<String>(0, "workspaceId")?,
                args.required(1, "entries")?,
            )?;
            done()
        }
        "getSessionFile" => {
            optional(store.get_session_file(&args.required::<SessionRef>(0, "sessionRef")?)?)
        }
        "setSessionFile" => {
            store.set_session_file(
                &args.required::<SessionRef>(0, "sessionRef")?,
                args.required(1, "sessionFile")?,
            )?;
            done()
        }
        "deleteSessionFile" => {
            store.delete_session_file(&args.required::<SessionRef>(0, "sessionRef")?)?;
            done()
        }
        "replaceWorkspaceSessions" => {
            let files: Map<String, Value> = args.required(2, "sessionFiles")?;
            if !files.values().all(Value::is_string) {
                return Err(CoreError::new("Invalid catalog argument sessionFiles"));
            }
            store.replace_workspace_sessions(
                &args.required::<String>(0, "workspaceId")?,
                args.required(1, "entries")?,
                files,
            )?;
            done()
        }
        other => Err(CoreError::new(format!("Unknown catalog method: {other}"))),
    }
}
