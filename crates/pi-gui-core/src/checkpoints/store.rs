//! Turn intervals and their snapshots, as `TurnCheckpointStore` kept them in Electron main:
//! `turn-checkpoints/checkpoints.json` for the intervals and the app-owned bare repository
//! `turn-checkpoints/objects.git` for the snapshot trees. It never changes the user's Git state.

use super::capture::{canonical, Inventory, SNAPSHOT_REF_PREFIX};
use super::git::{git, strip_line};
use super::metadata::{self, Capture, Coverage, Outcome, Record, Target};
use super::sync::{running, AbortSignal, Settled};
use crate::error::{CoreError, CoreResult};
use crate::persistence::backup_json::{read_json_with_backup, write_with_backup};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};
use tokio::sync::{watch, Mutex};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub timeout_ms: u64,
    pub max_files: u64,
    pub max_bytes: u64,
    pub max_file_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout_ms: 2_000,
            max_files: 10_000,
            max_bytes: 64 * 1024 * 1024,
            max_file_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Retention {
    /// Finalized intervals kept per task; open intervals are never dropped.
    pub max_records_per_task: u64,
    /// Finalized intervals kept across all tasks.
    pub max_records: u64,
    /// Unreferenced refs and objects younger than this survive maintenance.
    pub prune_grace_ms: u64,
    /// Minimum spacing between background maintenance passes.
    pub maintenance_interval_ms: u64,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            max_records_per_task: 50,
            max_records: 500,
            prune_grace_ms: 60 * 60 * 1000,
            maintenance_interval_ms: 60 * 60 * 1000,
        }
    }
}

/// Boundaries between maintenance passes when no record was dropped.
const MAINTENANCE_BOUNDARIES: u64 = 200;
/// Budget for building a checkout's first inventory in the background.
const WARM_TIMEOUT: Duration = Duration::from_secs(60);
const WARM_RETRY: Duration = Duration::from_secs(15 * 60);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub workspace_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opening {
    pub checkpoint_id: String,
    pub before_entry_id: Option<String>,
    pub started_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Closing {
    #[serde(flatten)]
    pub anchor: Opening,
    pub user_entry_ids: Vec<String>,
    pub assistant_entry_ids: Vec<String>,
    pub last_entry_id: Option<String>,
    pub outcome: Outcome,
    pub capture_error: Option<String>,
}

/// `TurnCaptureBoundary` from `@pi-gui/session-driver`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Boundary {
    pub session_ref: Target,
    pub workspace: Workspace,
    pub runtime_generation: String,
    pub run_id: String,
    pub timestamp: String,
    pub opening: Option<Opening>,
    pub closing: Option<Closing>,
}

type TaskKey = (String, String);

pub struct TurnCheckpoints {
    pub(super) directory: PathBuf,
    pub(super) repository_path: PathBuf,
    metadata_path: PathBuf,
    pub(super) limits: Limits,
    retention: Retention,
    records: RefCell<IndexMap<String, Record>>,
    /// True once `checkpoints.json` has been read; a failed read is retried by the next call.
    loaded: Mutex<bool>,
    git_ready: Mutex<bool>,
    /// Boundaries serialize per checkout; unrelated checkouts capture concurrently.
    checkout_queues: RefCell<HashMap<String, Settled>>,
    /// The latest boundary of each task, so its lookups never return an older turn.
    task_boundaries: RefCell<HashMap<TaskKey, Settled>>,
    /// Writes run one at a time; a write covers every change made before it started.
    writing: Mutex<()>,
    writes_wanted: Cell<u64>,
    writes_done: Cell<u64>,
    /// Last successful inventory per checkout root; cleared whenever objects may be pruned.
    pub(super) inventories: RefCell<IndexMap<PathBuf, Rc<Inventory>>>,
    pub(super) inventory_generation: Cell<u64>,
    warming: RefCell<HashSet<String>>,
    warm_retry_after: RefCell<HashMap<String, Instant>>,
    active_captures: RefCell<HashMap<u64, Settled>>,
    next_capture: Cell<u64>,
    maintenance: RefCell<Option<watch::Receiver<Option<CoreResult<()>>>>>,
    /// The first pass also waits one interval, keeping gc away from startup.
    last_maintenance_at: Cell<Instant>,
    boundaries_since_maintenance: Cell<u64>,
    dropped_since_maintenance: Cell<u64>,
}

impl TurnCheckpoints {
    pub fn new(user_data_dir: &Path, limits: Limits, retention: Retention) -> CoreResult<Self> {
        let limit_values = [
            limits.timeout_ms,
            limits.max_files,
            limits.max_bytes,
            limits.max_file_bytes,
        ];
        if limit_values
            .iter()
            .any(|value| *value < 1 || *value > MAX_SAFE_INTEGER)
        {
            return Err(CoreError::new(
                "Checkpoint capture limits must be positive safe integers.",
            ));
        }
        let retention_values = [
            retention.max_records_per_task,
            retention.max_records,
            retention.prune_grace_ms,
            retention.maintenance_interval_ms,
        ];
        if retention_values
            .iter()
            .any(|value| *value > MAX_SAFE_INTEGER)
            || retention.max_records_per_task < 1
            || retention.max_records < 1
        {
            return Err(CoreError::new(
                "Checkpoint retention limits must be safe integers.",
            ));
        }
        let directory = user_data_dir.join("turn-checkpoints");
        Ok(Self {
            repository_path: directory.join("objects.git"),
            metadata_path: directory.join("checkpoints.json"),
            directory,
            limits,
            retention,
            records: RefCell::new(IndexMap::new()),
            loaded: Mutex::new(false),
            git_ready: Mutex::new(false),
            checkout_queues: RefCell::new(HashMap::new()),
            task_boundaries: RefCell::new(HashMap::new()),
            writing: Mutex::new(()),
            writes_wanted: Cell::new(0),
            writes_done: Cell::new(0),
            inventories: RefCell::new(IndexMap::new()),
            inventory_generation: Cell::new(0),
            warming: RefCell::new(HashSet::new()),
            warm_retry_after: RefCell::new(HashMap::new()),
            active_captures: RefCell::new(HashMap::new()),
            next_capture: Cell::new(0),
            maintenance: RefCell::new(None),
            last_maintenance_at: Cell::new(Instant::now()),
            boundaries_since_maintenance: Cell::new(0),
            dropped_since_maintenance: Cell::new(0),
        })
    }

    /// Records one boundary. pi waits for this before a tool can run, and a transition
    /// shares exactly one tree. Only boundaries in the same checkout wait for each other, and
    /// the capture budget starts when this boundary's own capture starts.
    ///
    /// The task is registered before the returned future first runs, so a lookup that
    /// arrives after this call waits for it.
    pub fn record_boundary(
        self: &Rc<Self>,
        boundary: Boundary,
        signal: AbortSignal,
    ) -> impl std::future::Future<Output = CoreResult<()>> + 'static {
        let task = boundary.session_ref.key();
        let (done, settled) = running();
        self.task_boundaries
            .borrow_mut()
            .insert(task.clone(), settled.clone());
        let store = self.clone();
        async move {
            // Same-task boundaries never overlap (each is awaited), so resolving the queue key
            // first cannot reorder them; paths reaching one checkout through symlinks share
            // its queue.
            let checkout_path = checkout_root(&boundary.workspace.path).await;
            let result = store
                .enqueue(
                    checkout_path.clone(),
                    store.record_in_queue(&boundary, &checkout_path, &signal),
                )
                .await;
            drop(done);
            let mut boundaries = store.task_boundaries.borrow_mut();
            if boundaries
                .get(&task)
                .is_some_and(|latest| latest.same(&settled))
            {
                boundaries.remove(&task);
            }
            result
        }
    }

    async fn record_in_queue(
        self: &Rc<Self>,
        boundary: &Boundary,
        checkout_path: &str,
        signal: &AbortSignal,
    ) -> CoreResult<()> {
        self.load().await?;
        let opening = boundary.opening.as_ref();
        let closing = boundary.closing.as_ref();
        if opening.is_none() && closing.is_none() {
            return Ok(());
        }
        {
            let mut records = self.records.borrow_mut();
            // Validate the entire transition before changing either interval. A late or
            // replayed observer must never replace an original baseline or a finalized
            // comparison.
            if let Some(opening) = opening {
                if records.contains_key(&opening.checkpoint_id)
                    || closing.is_some_and(|closing| {
                        closing.anchor.checkpoint_id == opening.checkpoint_id
                    })
                {
                    return Err(CoreError::new(
                        "Checkpoint opening identity was already used.",
                    ));
                }
            }
            if let Some(closing) = closing {
                if records
                    .get(&closing.anchor.checkpoint_id)
                    .is_some_and(|existing| existing.outcome != Outcome::Open)
                {
                    return Err(CoreError::new("Checkpoint interval was already finalized."));
                }
            }
            for anchor in [opening, closing.map(|closing| &closing.anchor)]
                .into_iter()
                .flatten()
            {
                if let Some(existing) = records.get(&anchor.checkpoint_id) {
                    if existing.target != boundary.session_ref
                        || existing.checkout_id != boundary.workspace.workspace_id
                        || existing.runtime_generation != boundary.runtime_generation
                        || existing.run_id != boundary.run_id
                    {
                        return Err(CoreError::new(
                            "Checkpoint identity belongs to another runtime interval.",
                        ));
                    }
                }
            }
            let make_record = |anchor: &Opening| Record {
                checkpoint_id: anchor.checkpoint_id.clone(),
                target: boundary.session_ref.clone(),
                checkout_id: boundary.workspace.workspace_id.clone(),
                checkout_path: checkout_path.to_owned(),
                runtime_generation: boundary.runtime_generation.clone(),
                run_id: boundary.run_id.clone(),
                started_at: anchor.started_at.clone(),
                updated_at: boundary.timestamp.clone(),
                before_entry_id: anchor.before_entry_id.clone(),
                user_entry_ids: Vec::new(),
                assistant_entry_ids: Vec::new(),
                last_entry_id: None,
                outcome: Outcome::Open,
                before: Capture::unavailable(
                    "capture-pending",
                    "The before capture did not finish.",
                ),
                after: None,
                overlaps: Vec::new(),
            };
            if let Some(closing) = closing {
                if !records.contains_key(&closing.anchor.checkpoint_id) {
                    records.insert(
                        closing.anchor.checkpoint_id.clone(),
                        make_record(&closing.anchor),
                    );
                }
            }
            if let Some(opening) = opening {
                let mut next = make_record(opening);
                for (id, active) in records.iter_mut() {
                    if active.outcome != Outcome::Open
                        || closing.is_some_and(|closing| &closing.anchor.checkpoint_id == id)
                        || active.checkout_path != checkout_path
                    {
                        continue;
                    }
                    next.overlaps.push(id.clone());
                    if !active.overlaps.contains(&next.checkpoint_id) {
                        active.overlaps.push(next.checkpoint_id.clone());
                    }
                }
                records.insert(next.checkpoint_id.clone(), next);
            }
        }
        // This boundary writes metadata once, after the capture. If the app exits first, a
        // closed interval stays durably open and an opening is absent or pending (another
        // checkout's write may include it); restart marks either one interrupted, never
        // complete.
        let capture = self
            .capture(
                &boundary.workspace.path,
                signal,
                Duration::from_millis(self.limits.timeout_ms),
            )
            .await;
        let capture = if signal.is_aborted() {
            Capture::unavailable(
                "capture-aborted",
                "The capture was interrupted or exceeded its time limit.",
            )
        } else {
            capture
        };
        if capture.is_aborted() {
            self.warm_inventory(checkout_path);
        }
        {
            let mut records = self.records.borrow_mut();
            if let Some(closing) = closing {
                if let Some(current) = records.get_mut(&closing.anchor.checkpoint_id) {
                    current.outcome = closing.outcome;
                    current.updated_at = boundary.timestamp.clone();
                    current.user_entry_ids = closing.user_entry_ids.clone();
                    current.assistant_entry_ids = closing.assistant_entry_ids.clone();
                    current.last_entry_id = closing.last_entry_id.clone();
                    current.after = Some(match &closing.capture_error {
                        Some(error) if !error.is_empty() => {
                            Capture::unavailable("capture-boundary-failed", error)
                        }
                        _ => capture.clone(),
                    });
                }
            }
            if let Some(opening) = opening {
                if let Some(current) = records.get_mut(&opening.checkpoint_id) {
                    current.before = capture;
                }
            }
        }
        // A capture whose deadline passed after its bytes were read still describes the
        // checkout at this boundary; the adapter records the missed deadline itself.
        let dropped = self.enforce_retention();
        self.persist().await?;
        self.boundaries_since_maintenance
            .set(self.boundaries_since_maintenance.get() + 1);
        self.dropped_since_maintenance
            .set(self.dropped_since_maintenance.get() + dropped);
        self.schedule_maintenance();
        Ok(())
    }

    /// Every interval of a task, after its latest boundary has finished.
    pub async fn list(&self, target: &Target) -> CoreResult<Vec<Record>> {
        self.wait_for_task(target).await;
        self.load().await?;
        Ok(self
            .records
            .borrow()
            .values()
            .filter(|record| &record.target == target)
            .cloned()
            .collect())
    }

    /// The task's interval to review: the given one, or its newest finished one.
    pub async fn resolve(
        &self,
        target: &Target,
        checkout_id: &str,
        checkpoint_id: Option<&str>,
    ) -> Value {
        // Resolution waits for the task's in-flight boundary, so it never returns an older turn.
        self.wait_for_task(target).await;
        if self.load().await.is_err() {
            return unavailable_review(
                "checkpoint-storage-unavailable",
                "Checkpoint metadata could not be read; existing data was retained.",
            );
        }
        let records = self.records.borrow();
        let record = match checkpoint_id {
            Some(id) => records.get(id),
            None => {
                let mut finished: Vec<&Record> = records
                    .values()
                    .filter(|candidate| {
                        &candidate.target == target
                            && candidate.checkout_id == checkout_id
                            && candidate.outcome != Outcome::Open
                    })
                    .collect();
                finished.sort_by(|left, right| locale_compare(&right.updated_at, &left.updated_at));
                finished.first().copied()
            }
        };
        match record {
            Some(record) if &record.target == target && record.checkout_id == checkout_id => {
                self.resolve_record(record)
            }
            _ => unavailable_review(
                "checkpoint-unavailable",
                "No captured turn exists for this task and checkout.",
            ),
        }
    }

    /// Every finished turn of a task whose before and after captures are both usable.
    pub async fn list_turns(&self, target: &Target) -> CoreResult<Vec<Value>> {
        let records = self.list(target).await?;
        Ok(records
            .iter()
            .filter_map(|record| {
                let mut resolved = self.resolve_record(record);
                if resolved["state"] != "available" {
                    return None;
                }
                let mut entry_ids: Vec<&String> = Vec::new();
                for id in record
                    .user_entry_ids
                    .iter()
                    .chain(&record.assistant_entry_ids)
                    .chain(&record.last_entry_id)
                {
                    if !entry_ids.contains(&id) {
                        entry_ids.push(id);
                    }
                }
                resolved["entryIds"] = json!(entry_ids);
                Some(resolved)
            })
            .collect())
    }

    fn resolve_record(&self, record: &Record) -> Value {
        let (before, after) = match (&record.before, &record.after) {
            (
                Capture::Available {
                    tree_oid: before,
                    coverage: before_coverage,
                    ..
                },
                Some(Capture::Available {
                    tree_oid: after,
                    coverage: after_coverage,
                    captured_at,
                    ..
                }),
            ) if record.outcome != Outcome::Open => (
                (before, before_coverage),
                (after, after_coverage, captured_at),
            ),
            _ => {
                let failed = match (&record.before, &record.after) {
                    (Capture::Unavailable { message, .. }, _) => Some(message),
                    (_, Some(Capture::Unavailable { message, .. })) => Some(message),
                    _ => None,
                };
                return unavailable_review(
                    "checkpoint-incomplete",
                    failed.map_or(
                        "This turn does not have complete before and after captures.",
                        String::as_str,
                    ),
                );
            }
        };
        let mut notes: Vec<String> = before
            .1
            .notes
            .iter()
            .chain(&after.1.notes)
            .cloned()
            .collect();
        if record.outcome != Outcome::Completed {
            notes.push(format!(
                "This interval ended {}; it is not a completed turn.",
                record.outcome.name()
            ));
        }
        if !record.overlaps.is_empty() {
            notes.push(format!(
                "Other runs overlapped this interval in the same checkout ({}). Changes cannot be attributed to this agent alone.",
                record.overlaps.len()
            ));
        }
        let mut unique: Vec<String> = Vec::new();
        for note in notes {
            if !unique.contains(&note) {
                unique.push(note);
            }
        }
        let coverage = if unique.is_empty() {
            Coverage::complete()
        } else {
            Coverage::partial(unique)
        };
        json!({
            "state": "available",
            "checkpointId": record.checkpoint_id,
            "checkoutId": record.checkout_id,
            "repositoryPath": self.repository_path.to_string_lossy(),
            "beforeTreeOid": before.0,
            "afterTreeOid": after.0,
            "capturedAt": after.2,
            "coverage": coverage,
        })
    }

    /// Captures a checkout now. Maintenance waits for every capture that might still reuse
    /// objects it could prune.
    pub async fn capture(
        &self,
        workspace_path: &str,
        signal: &AbortSignal,
        timeout: Duration,
    ) -> Capture {
        let id = self.next_capture.get();
        self.next_capture.set(id + 1);
        let (done, settled) = running();
        self.active_captures.borrow_mut().insert(id, settled);
        let capture = self.capture_checkout(workspace_path, signal, timeout).await;
        self.active_captures.borrow_mut().remove(&id);
        drop(done);
        capture
    }

    /// Waits until no capture runs, background inventory builds included, so a test can
    /// remove its folders without a `git` child still writing into them.
    #[cfg(test)]
    pub(super) async fn captures_idle(&self) {
        while !self.warming.borrow().is_empty() || !self.active_captures.borrow().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// A checkout too large to read within one boundary's budget never gets an inventory
    /// from boundaries alone. Build it off the capture path so later boundaries read only
    /// changes.
    fn warm_inventory(self: &Rc<Self>, checkout_path: &str) {
        let retry_later = self
            .warm_retry_after
            .borrow()
            .get(checkout_path)
            .is_some_and(|after| *after > Instant::now());
        if self
            .inventories
            .borrow()
            .contains_key(Path::new(checkout_path))
            || self.warming.borrow().contains(checkout_path)
            || retry_later
        {
            return;
        }
        self.warming.borrow_mut().insert(checkout_path.to_owned());
        let store = self.clone();
        let checkout_path = checkout_path.to_owned();
        tokio::task::spawn_local(async move {
            let capture = store
                .capture(&checkout_path, &AbortSignal::never(), WARM_TIMEOUT)
                .await;
            // A checkout that cannot be read even with the longer budget is not retried soon.
            if matches!(capture, Capture::Available { .. }) {
                store.warm_retry_after.borrow_mut().remove(&checkout_path);
            } else {
                store
                    .warm_retry_after
                    .borrow_mut()
                    .insert(checkout_path.clone(), Instant::now() + WARM_RETRY);
            }
            store.warming.borrow_mut().remove(&checkout_path);
        });
    }

    /// Creates the bare repository on first use. A killed `git init` leaves only its own
    /// uniquely named staging folder, so the next attempt starts fresh.
    pub(super) async fn prepare_git(&self) -> CoreResult<()> {
        let mut ready = self.git_ready.lock().await;
        if *ready {
            return Ok(());
        }
        let git_error = |error: super::git::GitError| CoreError::new(error.0);
        let mut builder = tokio::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder
            .create(&self.directory)
            .await
            .map_err(|error| CoreError::io(&error, &self.directory))?;
        match tokio::fs::symlink_metadata(&self.repository_path).await {
            Ok(existing) => {
                if !existing.is_dir() || existing.is_symlink() {
                    return Err(CoreError::new("Invalid checkpoint repository."));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let initializing = self
                    .directory
                    .join(format!("objects.git.initializing.{}", crate::random_id()));
                let args = [
                    "init".as_ref(),
                    "--bare".as_ref(),
                    "--template=".as_ref(),
                    "--object-format=sha1".as_ref(),
                    initializing.as_os_str(),
                ];
                git(&self.directory, &args, None, &[])
                    .await
                    .map_err(git_error)?;
                let bare = git(
                    &initializing,
                    &["rev-parse", "--is-bare-repository"],
                    None,
                    &[],
                )
                .await
                .map_err(git_error)?;
                if strip_line(&bare) != "true" {
                    return Err(CoreError::new(
                        "Checkpoint repository initialization did not finish.",
                    ));
                }
                // Publish only a validated repository.
                tokio::fs::rename(&initializing, &self.repository_path)
                    .await
                    .map_err(|error| CoreError::io(&error, &self.repository_path))?;
            }
            Err(error) => return Err(CoreError::io(&error, &self.repository_path)),
        }
        let bare = git(
            &self.repository_path,
            &["rev-parse", "--is-bare-repository"],
            None,
            &[],
        )
        .await
        .map_err(git_error)?;
        if strip_line(&bare) != "true" {
            return Err(CoreError::new("Checkpoint repository must be bare."));
        }
        *ready = true;
        Ok(())
    }

    async fn wait_for_task(&self, target: &Target) {
        let latest = self.task_boundaries.borrow().get(&target.key()).cloned();
        if let Some(latest) = latest {
            latest.wait().await;
        }
    }

    /// Reads `checkpoints.json` once. Intervals still open from the last run are marked
    /// interrupted, never complete.
    async fn load(&self) -> CoreResult<()> {
        let mut loaded = self.loaded.lock().await;
        if *loaded {
            return Ok(());
        }
        let result = async {
            let path = self.metadata_path.clone();
            let read = blocking(move || read_json_with_backup(&path)).await?;
            if read.corrupted && !read.recovered {
                return Err(CoreError::new(
                    "Invalid checkpoint metadata; original data retained.",
                ));
            }
            let saved = match &read.value {
                None => Vec::new(),
                Some(value) => metadata::decode(value)?,
            };
            let mut interrupted = false;
            {
                let mut records = self.records.borrow_mut();
                for mut record in saved {
                    if record.outcome == Outcome::Open {
                        interrupted = true;
                        record.outcome = Outcome::Interrupted;
                        record.after = Some(Capture::unavailable(
                            "runtime-interrupted",
                            "The app exited before this interval's final capture.",
                        ));
                    }
                    records.insert(record.checkpoint_id.clone(), record);
                }
            }
            if interrupted {
                self.persist().await?;
            }
            Ok(())
        }
        .await;
        match result {
            Ok(()) => *loaded = true,
            // A transient read failure must not disable captures until restart.
            Err(_) => self.records.borrow_mut().clear(),
        }
        result
    }

    /// Writes the records as they are when the write starts. Callers that arrive while an
    /// earlier write runs share the next one.
    async fn persist(&self) -> CoreResult<()> {
        let wanted = self.writes_wanted.get() + 1;
        self.writes_wanted.set(wanted);
        let _writing = self.writing.lock().await;
        if self.writes_done.get() >= wanted {
            return Ok(());
        }
        let covers = self.writes_wanted.get();
        let text = metadata::encode(self.records.borrow().values())?;
        let path = self.metadata_path.clone();
        blocking(move || {
            write_with_backup(&path, &text, |existing| {
                metadata::decode(existing).map(|_| ())
            })
        })
        .await?;
        self.writes_done.set(covers);
        Ok(())
    }

    async fn enqueue<T>(
        &self,
        checkout: String,
        action: impl std::future::Future<Output = T>,
    ) -> T {
        let previous = self.checkout_queues.borrow().get(&checkout).cloned();
        let (done, settled) = running();
        self.checkout_queues
            .borrow_mut()
            .insert(checkout.clone(), settled.clone());
        if let Some(previous) = previous {
            previous.wait().await;
        }
        let result = action.await;
        drop(done);
        let mut queues = self.checkout_queues.borrow_mut();
        if queues
            .get(&checkout)
            .is_some_and(|tail| tail.same(&settled))
        {
            queues.remove(&checkout);
        }
        result
    }

    /// Keeps the newest finalized intervals per task and overall. Returns the number dropped.
    fn enforce_retention(&self) -> u64 {
        let mut records = self.records.borrow_mut();
        let mut finalized: Vec<(String, TaskKey, String)> = records
            .values()
            .filter(|record| record.outcome != Outcome::Open)
            .map(|record| {
                (
                    record.checkpoint_id.clone(),
                    record.target.key(),
                    record.updated_at.clone(),
                )
            })
            .collect();
        finalized.sort_by(|left, right| locale_compare(&right.2, &left.2));
        let mut per_task: HashMap<TaskKey, u64> = HashMap::new();
        let mut kept = 0;
        let mut dropped = 0;
        for (id, task, _) in finalized {
            let count = per_task.entry(task).or_default();
            *count += 1;
            if *count > self.retention.max_records_per_task || kept >= self.retention.max_records {
                records.shift_remove(&id);
                dropped += 1;
            } else {
                kept += 1;
            }
        }
        dropped
    }

    fn schedule_maintenance(self: &Rc<Self>) {
        if self.maintenance.borrow().is_some()
            || (self.dropped_since_maintenance.get() == 0
                && self.boundaries_since_maintenance.get() < MAINTENANCE_BOUNDARIES)
            || self.last_maintenance_at.get().elapsed()
                < Duration::from_millis(self.retention.maintenance_interval_ms)
        {
            return;
        }
        // Off the capture path: the boundary that triggered this returns first.
        let store = self.clone();
        tokio::task::spawn_local(async move {
            if let Err(error) = store.maintain().await {
                eprintln!("[turn-checkpoints] maintenance failed: {}", error.message);
            }
        });
    }

    /// Deletes refs that no retained interval needs and lets Git prune their objects. Refs
    /// and objects younger than the grace period survive, so a concurrent capture keeps its
    /// tree. Callers during a pass share it.
    pub async fn maintain(self: &Rc<Self>) -> CoreResult<()> {
        let existing = self.maintenance.borrow().clone();
        let mut receiver = match existing {
            Some(receiver) => receiver,
            None => {
                let (sender, receiver) = watch::channel(None);
                *self.maintenance.borrow_mut() = Some(receiver.clone());
                let store = self.clone();
                tokio::task::spawn_local(async move {
                    let result = store.run_maintenance().await;
                    *store.maintenance.borrow_mut() = None;
                    sender.send_replace(Some(result));
                });
                receiver
            }
        };
        let result = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|_| CoreError::new("Checkpoint maintenance stopped."))?;
        result.clone().expect("waited for a result")
    }

    async fn run_maintenance(&self) -> CoreResult<()> {
        self.load().await?;
        self.last_maintenance_at.set(Instant::now());
        self.boundaries_since_maintenance.set(0);
        self.dropped_since_maintenance.set(0);
        // Stop reusing stored objects, then wait for captures that may already be reusing
        // them and for boundaries to record the trees they captured, so those trees count
        // as live.
        self.inventory_generation
            .set(self.inventory_generation.get() + 1);
        self.inventories.borrow_mut().clear();
        let waiting: Vec<Settled> = self
            .active_captures
            .borrow()
            .values()
            .chain(self.checkout_queues.borrow().values())
            .cloned()
            .collect();
        for settled in waiting {
            settled.wait().await;
        }
        tokio::time::timeout(Duration::from_secs(30 * 60), self.prune())
            .await
            .map_err(|_| {
                CoreError::named("TimeoutError", "The operation was aborted due to timeout")
            })?
    }

    async fn prune(&self) -> CoreResult<()> {
        let git_error = |error: super::git::GitError| CoreError::new(error.0);
        self.prepare_git().await?;
        let live: HashSet<String> = self
            .records
            .borrow()
            .values()
            .flat_map(|record| [Some(&record.before), record.after.as_ref()])
            .flatten()
            .filter_map(|capture| capture.tree_oid().map(str::to_owned))
            .collect();
        let cutoff = unix_ms() - self.retention.prune_grace_ms as f64;
        let repository = &self.repository_path;
        let output = git(
            repository,
            &[
                "for-each-ref",
                "--format=%(objectname) %(refname)",
                SNAPSHOT_REF_PREFIX,
            ],
            None,
            &[],
        )
        .await
        .map_err(git_error)?;
        let refs: Vec<(String, String, bool)> = strip_line(&output)
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(|line| {
                let mut parts = line.split(' ');
                let oid = parts.next().unwrap_or_default().to_owned();
                let name = parts.next().unwrap_or_default().to_owned();
                // Refs from before timestamped names have no age and count as old.
                let suffix = name.get(SNAPSHOT_REF_PREFIX.len()..).unwrap_or_default();
                let digits: String = suffix.chars().take_while(char::is_ascii_digit).collect();
                let young = !digits.is_empty()
                    && suffix[digits.len()..].starts_with('-')
                    && digits.parse::<f64>().is_ok_and(|created| created > cutoff);
                (oid, name, young)
            })
            .collect();
        // Keep every young ref and one ref per retained tree; delete the rest.
        let mut kept: HashSet<&String> = refs
            .iter()
            .filter(|(_, _, young)| *young)
            .map(|(oid, _, _)| oid)
            .collect();
        let mut deletions = String::new();
        for (oid, name, young) in &refs {
            if *young {
                continue;
            }
            if live.contains(oid) && !kept.contains(oid) {
                kept.insert(oid);
            } else {
                deletions.push_str(&format!("delete {name} {oid}\n"));
            }
        }
        if !deletions.is_empty() {
            git(
                repository,
                &["update-ref", "--stdin"],
                Some(deletions.as_bytes()),
                &[],
            )
            .await
            .map_err(git_error)?;
        }
        let expiry = if self.retention.prune_grace_ms == 0 {
            "now".to_owned()
        } else {
            format!(
                "{}.seconds.ago",
                self.retention.prune_grace_ms.div_ceil(1000)
            )
        };
        git(
            repository,
            &["gc", "--quiet", &format!("--prune={expiry}")],
            None,
            &[],
        )
        .await
        .map_err(git_error)?;
        Ok(())
    }
}

/// The checkout's real path, or the given one made absolute when it cannot be resolved.
async fn checkout_root(path: &str) -> String {
    match canonical(Path::new(path)).await {
        Ok(real) => real.to_string_lossy().into_owned(),
        Err(_) => std::path::absolute(path)
            .map(|absolute| normalize(&absolute).to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_owned()),
    }
}

/// Removes `.` and `..` components without touching the disk, like Node's `path.resolve`.
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}

fn unavailable_review(code: &str, message: &str) -> Value {
    json!({ "state": "unavailable", "code": code, "message": message })
}

fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    crate::locale::compare(left, right)
}

fn unix_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as f64)
        .unwrap_or_default()
}

/// Runs file work that blocks off the core's thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> CoreResult<T> + Send + 'static,
) -> CoreResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| CoreError::new(format!("Checkpoint file work stopped: {error}")))?
}
