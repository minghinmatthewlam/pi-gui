//! Review and the task workbench (`ipc/review-requests.ts`, `workbench/review-owner.ts`,
//! `ipc/workbench-requests.ts` and the workbench half of `app-store.ts`): a task's saved
//! workbench layout, and the review owner, which keeps each comparison the core made so file
//! reads, review marks and staging act on exactly what the user saw.

use super::dispatch::{self, InvokeCall, MethodTable, Reply};
use super::validation::{self, Arg};
use super::{persist, Kernel, Readiness, WindowId};
use crate::error::{CoreError, CoreResult};
use crate::methods;
use crate::state::driver::{session_key, SessionRef};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::rc::Rc;

/// The last save sequence each window sent, and the queue saves and reads wait in.
#[derive(Default)]
pub struct WorkbenchRequests {
    /// By window; replaced on a renderer reset so saves already queued are dropped.
    renderers: RefCell<HashMap<WindowId, Rc<std::cell::Cell<u64>>>>,
    queue: tokio::sync::Mutex<()>,
}

impl WorkbenchRequests {
    /// `resetRenderer`: a reload or a closed window forgets its sequence.
    pub fn reset_renderer(&self, window: WindowId) {
        self.renderers.borrow_mut().remove(&window);
    }
}

pub fn register(table: &mut MethodTable) {
    table.on("getTaskWorkbenchTemplate", |kernel, call| {
        Box::pin(async move {
            dispatch::main_frame(&kernel, &call, "pi-gui:get-task-workbench-template")?;
            let target = validation::expect_session_target(call.arg(0), "target")?;
            let _turn = kernel.workbench.queue.lock().await;
            let template = get_task_workbench_template(&kernel, &target).await?;
            Ok(Reply::Value(template.unwrap_or(Value::Null)))
        })
    });
    table.on("saveTaskWorkbenchTemplate", |kernel, call| {
        Box::pin(async move { save(&kernel, &call).await })
    });
    table.on("getTurnChanges", |kernel, call| {
        Box::pin(async move {
            dispatch::main_frame(&kernel, &call, "pi-gui:get-turn-changes")?;
            let input = decode::record(call.arg(0), &["target"])?;
            let target = decode::session_target(input.get("target"))?;
            Ok(Reply::Value(or_failed(
                get_turn_changes(&kernel, &target).await,
            )))
        })
    });
    table.on("getReview", |kernel, call| {
        Box::pin(async move {
            dispatch::main_frame(&kernel, &call, "pi-gui:get-review")?;
            let input = decode::record(call.arg(0), &["target", "checkoutId", "scope"])?;
            let target = decode::session_target(input.get("target"))?;
            let checkout_id = decode::text(input.get("checkoutId"), "checkoutId")?;
            let scope = decode::scope(input.get("scope"))?;
            Ok(Reply::Value(or_failed(
                get_review(&kernel, target, checkout_id, scope).await,
            )))
        })
    });
    table.on("getReviewFile", |kernel, call| {
        Box::pin(async move {
            dispatch::main_frame(&kernel, &call, "pi-gui:get-review-file")?;
            let input = decode::record(call.arg(0), &["reviewId", "fileId"])?;
            let file = decode::file_input(&input)?;
            Ok(Reply::Value(or_failed(
                get_review_file(&kernel, &file).await,
            )))
        })
    });
    table.on("setReviewFileReviewed", |kernel, call| {
        Box::pin(async move {
            dispatch::main_frame(&kernel, &call, "pi-gui:set-review-file-reviewed")?;
            let input = decode::record(call.arg(0), &["reviewId", "fileId", "reviewed"])?;
            let file = decode::file_input(&input)?;
            let Some(reviewed) = input.get("reviewed").and_then(Value::as_bool) else {
                return Err(decode::fail("reviewed"));
            };
            Ok(Reply::Value(or_failed(
                set_review_file_reviewed(&kernel, &file, reviewed).await,
            )))
        })
    });
    table.on("changeReviewFileStage", |kernel, call| {
        Box::pin(async move {
            dispatch::main_frame(&kernel, &call, "pi-gui:change-review-file-stage")?;
            let input = decode::record(call.arg(0), &["reviewId", "fileId", "action"])?;
            let file = decode::file_input(&input)?;
            let action = match input.get("action").and_then(Value::as_str) {
                Some(action @ ("stage" | "unstage")) => action.to_owned(),
                _ => return Err(decode::fail("stage action")),
            };
            Ok(Reply::Value(or_failed(
                change_review_file_stage(&kernel, &file, &action).await,
            )))
        })
    });
}

async fn save(kernel: &Kernel, call: &InvokeCall) -> CoreResult<Reply> {
    let window = dispatch::main_frame(kernel, call, "pi-gui:save-task-workbench-template")?;
    let input = validation::expect_save_task_workbench_template_input(call.arg(0))?;
    let sequence = input["sequence"].as_u64().unwrap_or(0);
    let renderer = kernel
        .workbench
        .renderers
        .borrow_mut()
        .entry(window)
        .or_default()
        .clone();
    if sequence <= renderer.get() {
        return Ok(Reply::Undefined);
    }
    renderer.set(sequence);
    let _turn = kernel.workbench.queue.lock().await;
    // A renderer reload drops requests that have not started writing yet.
    let current = kernel.workbench.renderers.borrow().get(&window).cloned();
    if !current.is_some_and(|current| Rc::ptr_eq(&current, &renderer)) {
        return Ok(Reply::Undefined);
    }
    let target: SessionRef = crate::parse(input["target"].clone())?;
    save_task_workbench_template(kernel, &target, &input["template"]).await?;
    Ok(Reply::Undefined)
}

/// `decodeTaskWorkbenchTemplate` at the IPC boundary.
pub fn decode_task_workbench_template(value: Arg) -> CoreResult<Value> {
    crate::persistence::workbench_template::decode(value.unwrap_or(&Value::Null))
        .map_err(CoreError::new)
}

/// `requireWorkbenchTask`.
fn require_workbench_task(kernel: &Kernel, target: &SessionRef) -> CoreResult<()> {
    let data = kernel.data.borrow();
    if data.persistence != Readiness::Ready {
        return Err(CoreError::new(
            "Saved UI state is unavailable; repair or restore it before saving layouts.",
        ));
    }
    if data.session(target).is_none() {
        return Err(CoreError::new(
            "Workbench task does not exist in this workspace.",
        ));
    }
    Ok(())
}

/// `getTaskWorkbenchTemplate`.
pub async fn get_task_workbench_template(
    kernel: &Kernel,
    target: &SessionRef,
) -> CoreResult<Option<Value>> {
    kernel.initialize().await;
    require_workbench_task(kernel, target)?;
    Ok(kernel
        .data
        .borrow()
        .task_workbench_templates_by_session
        .get(&session_key(target))
        .cloned())
}

/// `saveTaskWorkbenchTemplate`: saved without an emit, so another window showing the task
/// keeps its layout; restored if the write fails.
pub async fn save_task_workbench_template(
    kernel: &Kernel,
    target: &SessionRef,
    template: &Value,
) -> CoreResult<()> {
    kernel.initialize().await;
    require_workbench_task(kernel, target)?;
    let key = session_key(target);
    let validated = decode_task_workbench_template(Some(template))?;
    let previous = kernel
        .data
        .borrow_mut()
        .task_workbench_templates_by_session
        .insert(key.clone(), validated.clone());
    if let Err(error) = persist::persist_ui_state(kernel).await {
        let mut data = kernel.data.borrow_mut();
        let templates = &mut data.task_workbench_templates_by_session;
        if templates.get(&key) == Some(&validated) {
            match previous {
                Some(previous) => {
                    templates.insert(key, previous);
                }
                None => {
                    templates.shift_remove(&key);
                }
            }
        }
        return Err(error);
    }
    Ok(())
}

// ---- Review owner ----

const MAX_RETAINED_REVIEWS: usize = 16;
/// Captured trees never change, so a turn's summary is computed once.
const MAX_CACHED_TURN_SUMMARIES: usize = 500;

/// One comparison the renderer may act on, as the core made it.
struct OwnedReview {
    target: SessionRef,
    checkout_id: String,
    /// None for a captured turn, which is read from the app's own snapshot repository.
    checkout_path: Option<String>,
    snapshot: Value,
}

/// The review owner's memory: recent comparisons, the staging queue per checkout and turn
/// summaries.
#[derive(Default)]
pub struct Reviews {
    reviews: RefCell<IndexMap<String, Rc<OwnedReview>>>,
    mutations: RefCell<HashMap<String, Rc<tokio::sync::Mutex<()>>>>,
    /// By checkpoint; a failed read leaves its cell empty so the next request tries again.
    turn_files: RefCell<IndexMap<String, Rc<tokio::sync::OnceCell<Value>>>>,
}

/// A review answer, or the `ReviewIssue` (or error) that ends the request early.
type ReviewResult<T = Value> = Result<T, Issue>;

enum Issue {
    Issue(Value),
    Failed(CoreError),
}

impl From<CoreError> for Issue {
    fn from(error: CoreError) -> Self {
        Self::Failed(error)
    }
}

fn unavailable(code: &str, message: &str) -> Issue {
    Issue::Issue(json!({ "state": "unavailable", "code": code, "message": message }))
}

/// `failed`: an error is answered as a failed review rather than thrown.
fn or_failed(result: ReviewResult) -> Value {
    match result {
        Ok(value) | Err(Issue::Issue(value)) => value,
        Err(Issue::Failed(error)) => {
            json!({ "state": "failed", "code": "review-failed", "message": error.message })
        }
    }
}

/// A core answer that is an issue (`state` other than `available`) ends the request.
fn available(value: Value) -> ReviewResult {
    if value["state"] == "available" {
        Ok(value)
    } else {
        Err(Issue::Issue(value))
    }
}

/// `validateTask`: the task is a thread the app shows.
fn validate_task(kernel: &Kernel, target: &SessionRef) -> ReviewResult<()> {
    if kernel.data.borrow().session(target).is_some() {
        Ok(())
    } else {
        Err(unavailable("task-unavailable", "This task is unavailable."))
    }
}

/// The task as checkpoints name it.
fn task_ref(target: &SessionRef) -> Value {
    json!({ "workspaceId": target.workspace_id, "sessionId": target.session_id })
}

/// `getTurnChanges`: what each finished turn of the task changed, for the cards in the
/// conversation. An unreadable capture drops only its own card.
async fn get_turn_changes(kernel: &Kernel, target: &SessionRef) -> ReviewResult {
    validate_task(kernel, target)?;
    let turns = kernel
        .core_call(
            methods::checkpoints::LIST_TURNS,
            json!({ "target": task_ref(target) }),
        )
        .await?;
    let turns = turns.as_array().cloned().unwrap_or_default();
    let summaries = super::futures_join_all(turns.iter().map(|turn| async move {
        let files = turn_changed_files(kernel, turn).await.ok()?;
        let has_files = files.as_array().is_some_and(|files| !files.is_empty());
        has_files.then(|| {
            json!({
                "checkpointId": turn["checkpointId"],
                "checkoutId": turn["checkoutId"],
                "entryIds": turn["entryIds"],
                "files": files,
            })
        })
    }))
    .await;
    Ok(json!({
        "state": "available",
        "turns": summaries.into_iter().flatten().collect::<Vec<_>>(),
    }))
}

async fn turn_changed_files(kernel: &Kernel, turn: &Value) -> CoreResult<Value> {
    let checkpoint_id = turn["checkpointId"].as_str().unwrap_or_default().to_owned();
    let cell = {
        let mut cache = kernel.reviews.turn_files.borrow_mut();
        let cell = cache.entry(checkpoint_id).or_default().clone();
        while cache.len() > MAX_CACHED_TURN_SUMMARIES {
            cache.shift_remove_index(0);
        }
        cell
    };
    let files = cell
        .get_or_try_init(|| {
            kernel.core_call(
                methods::REVIEW_TREE_CHANGES,
                json!({
                    "repositoryPath": turn["repositoryPath"],
                    "beforeTreeOid": turn["beforeTreeOid"],
                    "afterTreeOid": turn["afterTreeOid"],
                }),
            )
        })
        .await?;
    Ok(files.clone())
}

/// `getReview`: makes a comparison and remembers it under a new id.
async fn get_review(
    kernel: &Kernel,
    target: SessionRef,
    checkout_id: String,
    scope: Value,
) -> ReviewResult {
    validate_task(kernel, &target)?;
    let mut captured_at = None;
    let (checkout_path, git_path, scope) = if scope["kind"] == "turn" {
        let mut params = json!({ "target": task_ref(&target), "checkoutId": checkout_id });
        if let Some(checkpoint_id) = scope.get("checkpointId") {
            params["checkpointId"] = checkpoint_id.clone();
        }
        let checkpoint = available(
            kernel
                .core_call(methods::checkpoints::RESOLVE, params)
                .await?,
        )?;
        if checkpoint["checkoutId"] != checkout_id.as_str() {
            return Err(unavailable(
                "checkpoint-checkout-mismatch",
                "The captured turn belongs to another checkout.",
            ));
        }
        captured_at = checkpoint["capturedAt"]
            .as_str()
            .filter(|at| !at.is_empty())
            .map(str::to_owned);
        let scope = json!({
            "kind": "turn",
            "checkpointId": checkpoint["checkpointId"],
            "beforeTreeOid": checkpoint["beforeTreeOid"],
            "afterTreeOid": checkpoint["afterTreeOid"],
            "coverage": checkpoint["coverage"],
        });
        let git_path = checkpoint["repositoryPath"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        (None, git_path, scope)
    } else {
        let path = checkout_path(kernel, &target, &checkout_id).await?;
        (Some(path.clone()), path, scope)
    };
    let snapshot = available(
        kernel
            .core_call(
                methods::REVIEW_CREATE,
                json!({ "checkoutPath": git_path, "scope": scope, "limits": {} }),
            )
            .await?,
    )?;
    let marks: std::collections::HashSet<String> = serde_json::from_value(
        kernel
            .core_call(methods::REVIEWED_SNAPSHOT, Value::Null)
            .await?,
    )
    .unwrap_or_default();
    let owned = OwnedReview {
        target,
        checkout_id,
        checkout_path,
        snapshot,
    };
    let review_id = kernel.env().random_uuid();
    let snapshot = &owned.snapshot;
    let unstaged = snapshot["scope"]["kind"] == "unstaged";
    let files: Vec<Value> = snapshot["files"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|file| {
            let mut entry = Map::new();
            entry.insert("id".into(), file["id"].clone());
            entry.insert("path".into(), file["path"].clone());
            // An unstaged change is shown at its current path, so it reports no rename.
            if let Some(previous) = file.get("previousPath").filter(|_| !unstaged) {
                entry.insert("previousPath".into(), previous.clone());
            }
            for key in [
                "status",
                "hasStagedChanges",
                "hasUnstagedChanges",
                "conflicted",
                "lines",
            ] {
                entry.insert(key.into(), file[key].clone());
            }
            let reviewed = marks.contains(&mark_key(&owned, file));
            entry.insert("reviewed".into(), json!(reviewed));
            Value::Object(entry)
        })
        .collect();
    let mut result = Map::new();
    result.insert("state".into(), json!("available"));
    result.insert("reviewId".into(), json!(review_id));
    result.insert("scope".into(), snapshot["scope"].clone());
    result.insert("checkoutId".into(), json!(owned.checkout_id));
    result.insert("baseLabel".into(), snapshot["baseLabel"].clone());
    result.insert("headOid".into(), snapshot["headOid"].clone());
    result.insert("baseOid".into(), snapshot["baseOid"].clone());
    if let Some(captured_at) = captured_at {
        result.insert("capturedAt".into(), json!(captured_at));
    }
    result.insert("coverage".into(), snapshot["coverage"].clone());
    result.insert("files".into(), Value::Array(files));
    remember(kernel, review_id, owned);
    Ok(Value::Object(result))
}

fn remember(kernel: &Kernel, review_id: String, review: OwnedReview) {
    let mut reviews = kernel.reviews.reviews.borrow_mut();
    reviews.insert(review_id, Rc::new(review));
    while reviews.len() > MAX_RETAINED_REVIEWS {
        reviews.shift_remove_index(0);
    }
}

struct FileInput {
    review_id: String,
    file_id: String,
}

/// `getReviewFile`: the file's patch from the remembered comparison.
async fn get_review_file(kernel: &Kernel, input: &FileInput) -> ReviewResult {
    let review = resolve_file(kernel, input).await?;
    let content = available(
        kernel
            .core_call(
                methods::REVIEW_READ_FILE,
                json!({ "snapshot": review.snapshot, "fileId": input.file_id }),
            )
            .await?,
    )?;
    let mut result = content.as_object().cloned().unwrap_or_default();
    result.insert("reviewId".into(), json!(input.review_id));
    result.insert("fileId".into(), json!(input.file_id));
    Ok(Value::Object(result))
}

/// `setReviewFileReviewed`: only while the file still matches the comparison.
async fn set_review_file_reviewed(
    kernel: &Kernel,
    input: &FileInput,
    reviewed: bool,
) -> ReviewResult {
    let review = resolve_file(kernel, input).await?;
    let issue = kernel
        .core_call(
            methods::REVIEW_CHECK_FILE,
            json!({ "snapshot": review.snapshot, "fileId": input.file_id }),
        )
        .await?;
    if !issue.is_null() {
        return Err(Issue::Issue(issue));
    }
    let key = review_file(&review, &input.file_id)
        .map(|file| mark_key(&review, file))
        .unwrap_or_default();
    kernel
        .core_call(
            methods::REVIEWED_SET,
            json!({ "key": key, "reviewed": reviewed }),
        )
        .await?;
    Ok(json!({
        "state": "available",
        "reviewId": input.review_id,
        "fileId": input.file_id,
        "reviewed": reviewed,
    }))
}

/// `changeReviewFileStage`: live comparisons only, one change per checkout at a time.
async fn change_review_file_stage(
    kernel: &Kernel,
    input: &FileInput,
    action: &str,
) -> ReviewResult {
    let review = resolve_file(kernel, input).await?;
    let working = matches!(
        review.snapshot["scope"]["kind"].as_str(),
        Some("uncommitted" | "staged" | "unstaged")
    );
    let Some(checkout_path) = review.checkout_path.clone().filter(|_| working) else {
        return Err(unavailable(
            "read-only-comparison",
            "Staging is available only for Uncommitted, Staged and Unstaged changes.",
        ));
    };
    with_mutation(kernel, &checkout_path, async {
        let current = resolve_file(kernel, input).await?;
        Ok(kernel
            .core_call(
                methods::REVIEW_CHANGE_STAGE,
                json!({
                    "snapshot": current.snapshot,
                    "fileId": input.file_id,
                    "action": action,
                }),
            )
            .await?)
    })
    .await
}

fn review_file<'a>(review: &'a OwnedReview, file_id: &str) -> Option<&'a Value> {
    review.snapshot["files"]
        .as_array()?
        .iter()
        .find(|file| file["id"] == file_id)
}

/// `resolveFile`: the remembered comparison, still for a task the app has and the same
/// checkout, with the file in it.
async fn resolve_file(kernel: &Kernel, input: &FileInput) -> ReviewResult<Rc<OwnedReview>> {
    let review = kernel
        .reviews
        .reviews
        .borrow()
        .get(&input.review_id)
        .cloned();
    let Some(review) = review else {
        return Err(unavailable(
            "review-expired",
            "This comparison expired. Refresh to review current changes.",
        ));
    };
    validate_task(kernel, &review.target)?;
    if review.snapshot["scope"]["kind"] != "turn" {
        let current = checkout_path(kernel, &review.target, &review.checkout_id).await?;
        if review.checkout_path.as_deref() != Some(current.as_str()) {
            return Err(Issue::Issue(json!({
                "state": "stale",
                "code": "checkout-changed",
                "message": "The checkout moved. Refresh this comparison.",
            })));
        }
    }
    if review_file(&review, &input.file_id).is_none() {
        return Err(unavailable(
            "review-file-unavailable",
            "This file is not part of the selected comparison.",
        ));
    }
    Ok(review)
}

/// `checkoutPath`: the checkout's real path now.
async fn checkout_path(
    kernel: &Kernel,
    target: &SessionRef,
    checkout_id: &str,
) -> ReviewResult<String> {
    validate_task(kernel, target)?;
    let Some(path) = super::workspace::workspace_path(kernel, checkout_id) else {
        return Err(unavailable(
            "checkout-unavailable",
            "This checkout is unavailable.",
        ));
    };
    match tokio::fs::canonicalize(&path).await {
        Ok(real) => Ok(real.to_string_lossy().into_owned()),
        Err(_) => Err(unavailable(
            "checkout-unavailable",
            "This checkout no longer exists or cannot be read.",
        )),
    }
}

/// `withMutation`: staging changes to one checkout run one at a time.
async fn with_mutation(
    kernel: &Kernel,
    checkout_path: &str,
    action: impl Future<Output = ReviewResult>,
) -> ReviewResult {
    let queue = kernel
        .reviews
        .mutations
        .borrow_mut()
        .entry(checkout_path.to_owned())
        .or_default()
        .clone();
    let turn = queue.lock().await;
    let result = action.await;
    drop(turn);
    let mut mutations = kernel.reviews.mutations.borrow_mut();
    if mutations
        .get(checkout_path)
        .is_some_and(|current| Rc::ptr_eq(current, &queue) && Rc::strong_count(&queue) == 2)
    {
        mutations.remove(checkout_path);
    }
    result
}

/// `markKey`: a review mark belongs to the task, checkout, comparison and the file's
/// reviewed content, so a file changed since reads as not reviewed.
fn mark_key(review: &OwnedReview, file: &Value) -> String {
    let scope = &review.snapshot["scope"];
    let scope_detail = match scope["kind"].as_str() {
        Some("branch") => scope["baseRef"].clone(),
        Some("turn") => scope["checkpointId"].clone(),
        _ => Value::Null,
    };
    let parts = json!([
        review.target.workspace_id,
        review.target.session_id,
        review.checkout_id,
        review.checkout_path,
        scope["kind"],
        scope_detail,
        file["path"],
        file["previousPath"],
        file["contentFingerprint"],
    ]);
    let digest = Sha256::digest(parts.to_string().as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The review requests' decoders (`contracts/review.ts`).
mod decode {
    use super::super::validation::Arg;
    use crate::error::{CoreError, CoreResult};
    use crate::state::driver::SessionRef;
    use serde_json::{json, Map, Value};

    pub fn fail(label: &str) -> CoreError {
        CoreError::new(format!("Invalid review request: {label}"))
    }

    pub fn record(value: Arg, keys: &[&str]) -> CoreResult<Map<String, Value>> {
        match value {
            Some(Value::Object(record))
                if record.keys().all(|key| keys.contains(&key.as_str())) =>
            {
                Ok(record.clone())
            }
            _ => Err(fail("object fields")),
        }
    }

    pub fn text(value: Option<&Value>, label: &str) -> CoreResult<String> {
        match value.and_then(Value::as_str) {
            Some(text)
                if !crate::js::trim(text).is_empty()
                    && crate::js::length(text) <= 4096
                    && !text.contains('\0') =>
            {
                Ok(text.to_owned())
            }
            _ => Err(fail(label)),
        }
    }

    pub fn session_target(value: Option<&Value>) -> CoreResult<SessionRef> {
        let target = record(value, &["workspaceId", "sessionId"])?;
        Ok(crate::state::driver::session_ref(
            &text(target.get("workspaceId"), "target.workspaceId")?,
            &text(target.get("sessionId"), "target.sessionId")?,
        ))
    }

    pub fn file_input(input: &Map<String, Value>) -> CoreResult<super::FileInput> {
        Ok(super::FileInput {
            review_id: text(input.get("reviewId"), "reviewId")?,
            file_id: text(input.get("fileId"), "fileId")?,
        })
    }

    /// `decodeReviewScope`.
    pub fn scope(value: Option<&Value>) -> CoreResult<Value> {
        let scope = record(value, &["kind", "baseRef", "checkpointId"])?;
        let base_ref = scope.get("baseRef");
        let checkpoint_id = scope.get("checkpointId");
        match scope.get("kind").and_then(Value::as_str) {
            Some(kind @ ("uncommitted" | "staged" | "unstaged")) => {
                if base_ref.is_some() || checkpoint_id.is_some() {
                    return Err(fail("scope fields"));
                }
                Ok(json!({ "kind": kind }))
            }
            Some("branch") => {
                if checkpoint_id.is_some() {
                    return Err(fail("branch checkpoint"));
                }
                Ok(match base_ref {
                    None => json!({ "kind": "branch" }),
                    Some(base_ref) => {
                        json!({ "kind": "branch", "baseRef": text(Some(base_ref), "baseRef")? })
                    }
                })
            }
            Some("turn") => {
                if base_ref.is_some() {
                    return Err(fail("turn base"));
                }
                Ok(match checkpoint_id {
                    None => json!({ "kind": "turn" }),
                    Some(id) => {
                        json!({ "kind": "turn", "checkpointId": text(Some(id), "checkpointId")? })
                    }
                })
            }
            _ => Err(fail("scope kind")),
        }
    }
}
