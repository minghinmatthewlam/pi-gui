//! `catalogs.json`: the saved list of folders, threads and worktrees, and where each thread's
//! pi session file lives. Same file format, validation and ordering as `JsonCatalogStore` in
//! `@pi-gui/catalogs`, so an existing user's file loads unchanged.

use crate::error::{CoreError, CoreResult};
use crate::persistence::atomic::write_json_atomic;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
    pub last_opened_at: String,
    /// Kept as written so `0` stays `0` rather than becoming `0.0`.
    pub sort_order: Number,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub pinned: Option<bool>,
    /// Fields this version does not know, kept so a newer app's data survives.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub workspace_id: String,
    pub session_id: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl SessionRef {
    /// Same as `sessionKey` in `@pi-gui/session-driver`.
    pub fn key(&self) -> String {
        format!("{}:{}", self.workspace_id, self.session_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Running,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub session_ref: SessionRef,
    pub workspace_id: String,
    pub title: String,
    pub updated_at: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub archived_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub preview_snippet: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_file_path: Option<String>,
    pub status: SessionStatus,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeKind {
    Primary,
    Linked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeStatus {
    Ready,
    Missing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub worktree_id: String,
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
    pub kind: WorktreeKind,
    pub status: WorktreeStatus,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub branch_name: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub head_sha: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub pinned: Option<bool>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The file's contents. Always written as version 2.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogState {
    version: u8,
    pub workspaces: Vec<WorkspaceEntry>,
    pub sessions: Vec<SessionEntry>,
    pub worktrees: Vec<WorktreeEntry>,
    /// By session key. Insertion order is kept, like a JavaScript object.
    pub session_files: Map<String, Value>,
}

impl Default for CatalogState {
    fn default() -> Self {
        Self {
            version: 2,
            workspaces: Vec::new(),
            sessions: Vec::new(),
            worktrees: Vec::new(),
            session_files: Map::new(),
        }
    }
}

impl CatalogState {
    /// Same checks and messages as `parseState`. A bad file is reported, never repaired by
    /// dropping entries: the app uses the catalog to decide which attachments are still in use.
    pub fn parse(raw: &str, path: &Path) -> CoreResult<Self> {
        let parsed: Value = serde_json::from_str(&crate::json_text::replace_lone_surrogates(raw))
            .map_err(|error| CoreError::named("SyntaxError", error.to_string()))?;
        let unsupported = || {
            CoreError::new(format!(
                "Unsupported catalog file format in {}.",
                path.display()
            ))
        };
        let root = parsed.as_object().ok_or_else(unsupported)?;
        let version = root.get("version").and_then(Value::as_f64);
        let legacy = match version {
            Some(1.0) => true,
            Some(2.0) => false,
            _ => return Err(unsupported()),
        };
        let invalid = || {
            CoreError::new(format!(
                "Invalid catalog file contents in {}; original file was left unchanged.",
                path.display()
            ))
        };
        // Version 1 predates worktrees; its missing collections were empty.
        let field = |name: &str, empty: Value| match root.get(name) {
            None if legacy => Some(empty),
            other => other.cloned(),
        };
        let list = |name: &str| field(name, Value::Array(Vec::new())).ok_or_else(invalid);

        let workspaces: Vec<WorkspaceEntry> = entries(list("workspaces")?).ok_or_else(invalid)?;
        let sessions: Vec<SessionEntry> = entries(list("sessions")?).ok_or_else(invalid)?;
        let worktrees: Vec<WorktreeEntry> = entries(list("worktrees")?).ok_or_else(invalid)?;
        let session_files = match field("sessionFiles", Value::Object(Map::new())) {
            Some(Value::Object(map)) if map.values().all(Value::is_string) => map,
            _ => return Err(invalid()),
        };
        if workspaces.iter().any(|entry| !is_finite(&entry.sort_order))
            || sessions
                .iter()
                .any(|entry| entry.session_ref.workspace_id != entry.workspace_id)
        {
            return Err(invalid());
        }
        Ok(Self {
            version: 2,
            workspaces,
            sessions,
            worktrees,
            session_files,
        })
    }
}

/// For optional fields: absent is `None`, but an explicit `null` is invalid, as in `parseState`.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn entries<T: for<'de> Deserialize<'de>>(value: Value) -> Option<Vec<T>> {
    match value {
        Value::Array(items) => items
            .into_iter()
            .map(|item| {
                if item.is_object() {
                    serde_json::from_value(item).ok()
                } else {
                    None
                }
            })
            .collect(),
        _ => None,
    }
}

fn is_finite(number: &Number) -> bool {
    number.as_f64().is_some_and(f64::is_finite)
}

/// The one owner of `catalogs.json`. Reads come from memory until the next change; every
/// change re-reads the file first, exactly as the TypeScript store did.
pub struct CatalogStore {
    path: PathBuf,
    cached: Option<CatalogState>,
}

impl CatalogStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, cached: None }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list_workspaces(&mut self) -> CoreResult<Vec<WorkspaceEntry>> {
        let mut workspaces = self.state()?.workspaces.clone();
        workspaces.sort_by(compare_workspaces);
        Ok(workspaces)
    }

    pub fn get_workspace(&mut self, workspace_id: &str) -> CoreResult<Option<WorkspaceEntry>> {
        Ok(self
            .state()?
            .workspaces
            .iter()
            .find(|entry| entry.workspace_id == workspace_id)
            .cloned())
    }

    pub fn upsert_workspace(&mut self, entry: WorkspaceEntry) -> CoreResult<()> {
        self.mutate(|state| {
            upsert(&mut state.workspaces, entry, |a, b| {
                a.workspace_id == b.workspace_id
            });
            true
        })
    }

    pub fn delete_workspace(&mut self, workspace_id: &str) -> CoreResult<()> {
        self.mutate(|state| {
            state
                .workspaces
                .retain(|entry| entry.workspace_id != workspace_id);
            state
                .sessions
                .retain(|entry| entry.workspace_id != workspace_id);
            state.worktrees.retain(|entry| {
                !(entry.workspace_id == workspace_id && entry.kind == WorktreeKind::Primary)
            });
            let prefix = format!("{workspace_id}:");
            state
                .session_files
                .retain(|key, _| !key.starts_with(&prefix));
            true
        })
    }

    pub fn list_worktrees(&mut self, workspace_id: Option<&str>) -> CoreResult<Vec<WorktreeEntry>> {
        let mut worktrees: Vec<WorktreeEntry> = self
            .state()?
            .worktrees
            .iter()
            .filter(|entry| workspace_id.is_none_or(|id| entry.workspace_id == id))
            .cloned()
            .collect();
        worktrees.sort_by(compare_worktrees);
        Ok(worktrees)
    }

    pub fn get_worktree(&mut self, worktree_id: &str) -> CoreResult<Option<WorktreeEntry>> {
        Ok(self
            .state()?
            .worktrees
            .iter()
            .find(|entry| entry.worktree_id == worktree_id)
            .cloned())
    }

    pub fn upsert_worktree(&mut self, entry: WorktreeEntry) -> CoreResult<()> {
        self.mutate(|state| {
            upsert(&mut state.worktrees, entry, |a, b| {
                a.worktree_id == b.worktree_id
            });
            true
        })
    }

    pub fn delete_worktree(&mut self, worktree_id: &str) -> CoreResult<()> {
        self.mutate(|state| {
            state
                .worktrees
                .retain(|entry| entry.worktree_id != worktree_id);
            true
        })
    }

    pub fn replace_workspace_worktrees(
        &mut self,
        workspace_id: &str,
        entries: Vec<WorktreeEntry>,
    ) -> CoreResult<()> {
        self.mutate(|state| {
            let mut existing: Vec<&WorktreeEntry> = state
                .worktrees
                .iter()
                .filter(|entry| entry.workspace_id == workspace_id)
                .collect();
            existing.sort_by(|a, b| compare_worktrees(a, b));
            let mut sorted_next: Vec<&WorktreeEntry> = entries.iter().collect();
            sorted_next.sort_by(|a, b| compare_worktrees(a, b));
            if existing.len() == sorted_next.len()
                && existing
                    .iter()
                    .zip(&sorted_next)
                    .all(|(a, b)| same_worktree(a, b))
            {
                return false;
            }
            state
                .worktrees
                .retain(|entry| entry.workspace_id != workspace_id);
            state.worktrees.extend(entries);
            true
        })
    }

    pub fn list_sessions(&mut self, workspace_id: Option<&str>) -> CoreResult<Vec<SessionEntry>> {
        let mut sessions: Vec<SessionEntry> = self
            .state()?
            .sessions
            .iter()
            .filter(|entry| workspace_id.is_none_or(|id| entry.workspace_id == id))
            .cloned()
            .collect();
        sessions.sort_by(compare_sessions);
        Ok(sessions)
    }

    pub fn get_session(&mut self, session_ref: &SessionRef) -> CoreResult<Option<SessionEntry>> {
        let key = session_ref.key();
        Ok(self
            .state()?
            .sessions
            .iter()
            .find(|entry| entry.session_ref.key() == key)
            .cloned())
    }

    pub fn upsert_session(&mut self, entry: SessionEntry) -> CoreResult<()> {
        self.mutate(|state| {
            let key = entry.session_ref.key();
            match state
                .sessions
                .iter()
                .position(|existing| existing.session_ref.key() == key)
            {
                // The driver saves a session on every agent event, mostly unchanged; skipping
                // those writes keeps file syncs from delaying the events behind them.
                Some(index) if same_session(&state.sessions[index], &entry) => false,
                Some(index) => {
                    state.sessions[index] = entry;
                    true
                }
                None => {
                    state.sessions.push(entry);
                    true
                }
            }
        })
    }

    pub fn delete_session(&mut self, session_ref: &SessionRef) -> CoreResult<()> {
        let key = session_ref.key();
        self.mutate(|state| {
            state
                .sessions
                .retain(|entry| entry.session_ref.key() != key);
            state.session_files.shift_remove(&key);
            true
        })
    }

    pub fn get_session_file(&mut self, session_ref: &SessionRef) -> CoreResult<Option<String>> {
        Ok(self
            .state()?
            .session_files
            .get(&session_ref.key())
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    pub fn set_session_file(&mut self, session_ref: &SessionRef, file: String) -> CoreResult<()> {
        let key = session_ref.key();
        self.mutate(|state| {
            if state.session_files.get(&key).and_then(Value::as_str) == Some(file.as_str()) {
                return false;
            }
            state.session_files.insert(key, Value::String(file));
            true
        })
    }

    pub fn delete_session_file(&mut self, session_ref: &SessionRef) -> CoreResult<()> {
        let key = session_ref.key();
        self.mutate(|state| {
            state.session_files.shift_remove(&key);
            true
        })
    }

    pub fn replace_workspace_sessions(
        &mut self,
        workspace_id: &str,
        entries: Vec<SessionEntry>,
        session_files: Map<String, Value>,
    ) -> CoreResult<()> {
        self.mutate(|state| {
            let next_keys: std::collections::HashSet<String> = entries
                .iter()
                .map(|entry| entry.session_ref.key())
                .collect();
            state
                .sessions
                .retain(|entry| entry.workspace_id != workspace_id);
            state.sessions.extend(entries);
            let prefix = format!("{workspace_id}:");
            state
                .session_files
                .retain(|key, _| !(key.starts_with(&prefix) && !next_keys.contains(key)));
            for (key, file) in session_files {
                state.session_files.insert(key, file);
            }
            true
        })
    }

    fn state(&mut self) -> CoreResult<&CatalogState> {
        if self.cached.is_none() {
            self.cached = Some(self.load()?);
        }
        Ok(self.cached.as_ref().expect("loaded above"))
    }

    fn load(&self) -> CoreResult<CatalogState> {
        match fs::read_to_string(&self.path) {
            Ok(raw) => CatalogState::parse(&raw, &self.path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(CatalogState::default()),
            Err(error) => Err(CoreError::io(&error, &self.path)),
        }
    }

    /// `change` returns false when it changed nothing, which skips the write.
    fn mutate(&mut self, change: impl FnOnce(&mut CatalogState) -> bool) -> CoreResult<()> {
        self.cached = None;
        let mut state = self.load()?;
        if change(&mut state) {
            write_json_atomic(&self.path, &state)?;
        }
        self.cached = Some(state);
        Ok(())
    }
}

fn upsert<T>(list: &mut Vec<T>, entry: T, same: impl Fn(&T, &T) -> bool) {
    match list.iter().position(|existing| same(existing, &entry)) {
        Some(index) => list[index] = entry,
        None => list.push(entry),
    }
}

fn compare_workspaces(left: &WorkspaceEntry, right: &WorkspaceEntry) -> Ordering {
    pinned_first(left.pinned, right.pinned)
        .then_with(|| {
            let (a, b) = (
                left.sort_order.as_f64().unwrap_or_default(),
                right.sort_order.as_f64().unwrap_or_default(),
            );
            a.partial_cmp(&b).unwrap_or(Ordering::Equal)
        })
        .then_with(|| right.last_opened_at.cmp(&left.last_opened_at))
}

fn compare_sessions(left: &SessionEntry, right: &SessionEntry) -> Ordering {
    let archived = |entry: &SessionEntry| {
        entry
            .archived_at
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    };
    let status_rank = |status: SessionStatus| match status {
        SessionStatus::Running => 0,
        SessionStatus::Idle => 1,
        SessionStatus::Failed => 2,
    };
    archived(left)
        .cmp(&archived(right))
        .then_with(|| status_rank(left.status).cmp(&status_rank(right.status)))
        .then_with(|| right.updated_at.cmp(&left.updated_at))
}

fn compare_worktrees(left: &WorktreeEntry, right: &WorktreeEntry) -> Ordering {
    let kind_rank = |kind: WorktreeKind| match kind {
        WorktreeKind::Primary => 0,
        WorktreeKind::Linked => 1,
    };
    kind_rank(left.kind)
        .cmp(&kind_rank(right.kind))
        .then_with(|| pinned_first(left.pinned, right.pinned))
        .then_with(|| right.updated_at.cmp(&left.updated_at))
        .then_with(|| compare_display_names(&left.display_name, &right.display_name))
}

fn pinned_first(left: Option<bool>, right: Option<bool>) -> Ordering {
    let rank = |pinned: Option<bool>| if pinned == Some(true) { 0 } else { 1 };
    rank(left).cmp(&rank(right))
}

/// JavaScript's `localeCompare`: the same ICU root collation V8 uses.
pub(crate) fn compare_display_names(left: &str, right: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(Default::default(), CollatorOptions::default())
                .expect("the root collation is compiled in")
        })
        .compare(left, right)
}

/// The fields `areSessionEntriesEqual` compares.
fn same_session(left: &SessionEntry, right: &SessionEntry) -> bool {
    left.session_ref.workspace_id == right.session_ref.workspace_id
        && left.session_ref.session_id == right.session_ref.session_id
        && left.workspace_id == right.workspace_id
        && left.title == right.title
        && left.updated_at == right.updated_at
        && left.archived_at == right.archived_at
        && left.preview_snippet == right.preview_snippet
        && left.session_file_path == right.session_file_path
        && left.status == right.status
}

/// The fields `areWorktreeEntriesEqual` compares.
fn same_worktree(left: &WorktreeEntry, right: &WorktreeEntry) -> bool {
    left.worktree_id == right.worktree_id
        && left.workspace_id == right.workspace_id
        && left.path == right.path
        && left.display_name == right.display_name
        && left.kind == right.kind
        && left.status == right.status
        && left.branch_name == right.branch_name
        && left.head_sha == right.head_sha
        && left.pinned == right.pinned
        && left.created_at == right.created_at
        && left.updated_at == right.updated_at
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TIME: &str = "2026-07-27T00:00:00.000Z";

    fn session(workspace: &str, id: &str, updated_at: &str, status: &str) -> SessionEntry {
        serde_json::from_value(json!({
            "sessionRef": { "workspaceId": workspace, "sessionId": id },
            "workspaceId": workspace,
            "title": id,
            "updatedAt": updated_at,
            "status": status,
        }))
        .unwrap()
    }

    fn store(name: &str) -> (PathBuf, CatalogStore) {
        let dir = crate::test_support::temp_dir(name);
        let store = CatalogStore::new(dir.join("catalogs.json"));
        (dir, store)
    }

    #[test]
    fn missing_file_is_empty_and_first_write_creates_it() {
        let (dir, mut store) = store("catalog-empty");
        assert!(store.list_workspaces().unwrap().is_empty());
        store
            .upsert_session(session("w", "s", TIME, "idle"))
            .unwrap();
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
        assert_eq!(saved["version"], 2);
        assert_eq!(saved["sessions"][0]["sessionRef"]["sessionId"], "s");
        assert_eq!(saved["sessionFiles"], json!({}));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_file_is_reported_and_left_unchanged() {
        let (dir, mut store) = store("catalog-invalid");
        let original =
            r#"{"version":2,"workspaces":[],"sessions":[null],"worktrees":[],"sessionFiles":{}}"#;
        fs::write(store.path(), original).unwrap();
        let error = store.list_sessions(None).unwrap_err();
        assert!(error
            .message
            .starts_with("Invalid catalog file contents in "));
        assert!(store
            .upsert_session(session("w", "s", TIME, "idle"))
            .is_err());
        assert_eq!(fs::read_to_string(store.path()).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn version_one_files_without_worktrees_load() {
        let (dir, mut store) = store("catalog-v1");
        fs::write(store.path(), r#"{"version":1,"workspaces":[]}"#).unwrap();
        assert!(store.list_worktrees(None).unwrap().is_empty());
        assert!(store.list_sessions(None).unwrap().is_empty());
        fs::write(store.path(), r#"{"version":3}"#).unwrap();
        store.cached = None;
        assert!(store
            .list_sessions(None)
            .unwrap_err()
            .message
            .starts_with("Unsupported catalog file format"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sessions_sort_running_first_then_newest_and_archived_last() {
        let (dir, mut store) = store("catalog-order");
        store
            .upsert_session(session("w", "old", "2026-01-01", "idle"))
            .unwrap();
        store
            .upsert_session(session("w", "new", "2026-02-01", "idle"))
            .unwrap();
        store
            .upsert_session(session("w", "run", "2025-01-01", "running"))
            .unwrap();
        let mut archived = session("w", "arch", "2027-01-01", "running");
        archived.archived_at = Some(TIME.into());
        store.upsert_session(archived).unwrap();
        let order: Vec<_> = store
            .list_sessions(Some("w"))
            .unwrap()
            .into_iter()
            .map(|entry| entry.session_ref.session_id)
            .collect();
        assert_eq!(order, ["run", "new", "old", "arch"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn deleting_a_folder_removes_its_threads_files_and_primary_worktree() {
        let (dir, mut store) = store("catalog-delete");
        store
            .upsert_session(session("w", "s", TIME, "idle"))
            .unwrap();
        store
            .upsert_session(session("other", "s", TIME, "idle"))
            .unwrap();
        store
            .set_session_file(
                &SessionRef {
                    workspace_id: "w".into(),
                    session_id: "s".into(),
                    extra: Map::new(),
                },
                "/x.jsonl".into(),
            )
            .unwrap();
        store.delete_workspace("w").unwrap();
        assert_eq!(store.list_sessions(None).unwrap().len(), 1);
        assert!(store.state().unwrap().session_files.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_fields_survive_a_rewrite() {
        let (dir, mut store) = store("catalog-extra");
        fs::write(
            store.path(),
            json!({
                "version": 2,
                "workspaces": [{ "workspaceId": "w", "path": "/w", "displayName": "W",
                  "lastOpenedAt": TIME, "sortOrder": 0, "future": { "a": 1 } }],
                "sessions": [], "worktrees": [], "sessionFiles": {}
            })
            .to_string(),
        )
        .unwrap();
        store
            .upsert_session(session("w", "s", TIME, "idle"))
            .unwrap();
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
        assert_eq!(saved["workspaces"][0]["future"], json!({ "a": 1 }));
        assert_eq!(saved["workspaces"][0]["sortOrder"].to_string(), "0");
        fs::remove_dir_all(dir).unwrap();
    }
}
