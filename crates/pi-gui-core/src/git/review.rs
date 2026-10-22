//! Review comparisons: Uncommitted, Staged and Unstaged changes in a checkout, a branch against
//! its base, and a captured turn's trees, plus staging and unstaging one file from a review.
//! A snapshot lists every file with fingerprints of what was read; reading, marking or staging
//! a file first checks its fingerprint again, so nothing acts on content the user did not see.
//!
//! The app keeps snapshots and passes one back with each file call. Fingerprints are SHA-256
//! of the same JSON text the TypeScript version hashed, so reviewed marks saved by earlier
//! versions still match.

use super::{nul_split, GitCommand, GitOutput};
use crate::error::{CoreError, CoreResult};
use crate::paths;
use crate::{parse, Core};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

const MAX_FILES: usize = 2_000;
const MAX_CONTENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PATCH_BYTES: usize = 1024 * 1024;
const MAX_GIT_BYTES: usize = 32 * 1024 * 1024;
const MAX_PREPARATION_BYTES: u64 = 32 * 1024 * 1024;
const PREPARATION_TIME: Duration = Duration::from_secs(10);
const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Pathspec bytes per Git call, well below Windows' 32K command-line limit.
const MAX_PATHSPEC_BYTES: usize = 24_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    state: CoverageState,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum CoverageState {
    Complete,
    Partial,
}

fn complete() -> Coverage {
    Coverage {
        state: CoverageState::Complete,
        notes: Vec::new(),
    }
}

fn partial(notes: impl IntoIterator<Item = String>) -> Coverage {
    let mut unique: Vec<String> = Vec::new();
    for note in notes {
        if !unique.contains(&note) {
            unique.push(note);
        }
    }
    Coverage {
        state: CoverageState::Partial,
        notes: unique,
    }
}

fn combine_coverage(coverages: &[Coverage]) -> Coverage {
    let notes = coverages.iter().flat_map(|coverage| coverage.notes.clone());
    if coverages
        .iter()
        .any(|coverage| coverage.state == CoverageState::Partial)
    {
        partial(notes)
    } else {
        complete()
    }
}

fn issue(state: &str, code: &str, message: impl Into<String>) -> Value {
    json!({ "state": state, "code": code, "message": message.into() })
}

/// A comparison scope as the app sends it in, and as a snapshot records it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Scope {
    Uncommitted,
    Staged,
    Unstaged,
    #[serde(rename_all = "camelCase")]
    Branch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_ref: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Turn {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_tree_oid: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_tree_oid: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        coverage: Option<Coverage>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Uncommitted,
    Staged,
    Unstaged,
    Branch,
    Turn,
}

impl Scope {
    fn kind(&self) -> Kind {
        match self {
            Scope::Uncommitted => Kind::Uncommitted,
            Scope::Staged => Kind::Staged,
            Scope::Unstaged => Kind::Unstaged,
            Scope::Branch { .. } => Kind::Branch,
            Scope::Turn { .. } => Kind::Turn,
        }
    }
}

impl Kind {
    fn is_working(self) -> bool {
        matches!(self, Kind::Uncommitted | Kind::Staged | Kind::Unstaged)
    }
}

/// One side of a file in Git: `{ mode, oid, stage? }`, in that key order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlobRef {
    mode: String,
    oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stage: Option<u32>,
}

/// What a snapshot records of a working-tree file: `{ mode, digest, note? }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkingIdentity {
    mode: String,
    digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// Everything a file's comparison read. Field order is the key order the TypeScript objects
/// had, which the fingerprints hash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base: Option<BlobRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    head: Option<BlobRef>,
    index: Vec<BlobRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    working: Option<WorkingIdentity>,
    status_records: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LineCounts {
    added: Value,
    removed: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    id: String,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_path: Option<String>,
    status: String,
    has_staged_changes: bool,
    has_unstaged_changes: bool,
    conflicted: bool,
    lines: Option<LineCounts>,
    /// Everything the comparison read, including the index; any change makes actions stale.
    fingerprint: String,
    /// The reviewed content only. Staging moves it into the index without changing it.
    content_fingerprint: String,
    source: FileSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    state: String,
    checkout_path: String,
    scope: Scope,
    base_label: String,
    head_oid: Option<String>,
    base_oid: Option<String>,
    coverage: Coverage,
    files: Vec<ReviewFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    #[serde(default)]
    max_git_bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    checkout_path: String,
    scope: Scope,
    #[serde(default)]
    limits: Option<Limits>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileParams {
    snapshot: Snapshot,
    file_id: String,
    #[serde(default)]
    action: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TreeChangesParams {
    repository_path: String,
    before_tree_oid: String,
    after_tree_oid: String,
}

pub async fn call(_core: Rc<Core>, method: String, params: Value) -> CoreResult<Value> {
    match method.as_str() {
        crate::methods::REVIEW_CREATE => {
            let params: CreateParams = parse(params)?;
            let max_git_bytes = params
                .limits
                .and_then(|limits| limits.max_git_bytes)
                .unwrap_or(MAX_GIT_BYTES);
            Ok(
                match create(&params.checkout_path, params.scope, max_git_bytes).await {
                    Ok(Ok(snapshot)) => serde_json::to_value(snapshot).expect("snapshots encode"),
                    Ok(Err(issue)) => issue,
                    Err(error) => issue("unavailable", "git-review-unavailable", error.message),
                },
            )
        }
        crate::methods::REVIEW_CHECK_FILE => {
            let params: FileParams = parse(params)?;
            Ok(check_file_current(&params.snapshot, &params.file_id)
                .await
                .unwrap_or(Value::Null))
        }
        crate::methods::REVIEW_READ_FILE => {
            let params: FileParams = parse(params)?;
            Ok(read_file(&params.snapshot, &params.file_id).await)
        }
        crate::methods::REVIEW_CHANGE_STAGE => {
            let params: FileParams = parse(params)?;
            let action = match params.action.as_deref() {
                Some("stage") => Stage::Stage,
                Some("unstage") => Stage::Unstage,
                _ => return Err(CoreError::new("Invalid parameters: action")),
            };
            Ok(change_file_stage(&params.snapshot, &params.file_id, action).await)
        }
        crate::methods::REVIEW_TREE_CHANGES => {
            let params: TreeChangesParams = parse(params)?;
            let files = numstat(
                Path::new(&params.repository_path),
                &[&params.before_tree_oid, &params.after_tree_oid],
                MAX_GIT_BYTES,
            )
            .await?;
            Ok(Value::Array(
                files.into_iter().map(|file| file.to_json()).collect(),
            ))
        }
        _ => Err(CoreError::new(format!("Unknown RPC method: {method}"))),
    }
}

/* ── Running Git ─────────────────────────────────────────── */

/// Runs Git for review: exact pathspecs, no fsmonitor hook, unquoted paths, the isolated
/// environment, and a time limit. Exit codes 0 and 1 are answers (1 is "differs"); anything
/// higher fails with Git's own message.
async fn git(cwd: &Path, args: &[&str], max_buffer: usize) -> CoreResult<GitOutput> {
    let mut all = vec![
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotepath=false",
    ];
    all.extend_from_slice(args);
    let output = GitCommand::new(all.iter().copied())
        .cwd(cwd)
        .isolated()
        .max_buffer(max_buffer)
        .timeout(GIT_TIMEOUT)
        .output()
        .await?;
    if output.truncated {
        return Ok(output);
    }
    match output.exit {
        super::Exit::Code(code) if code <= 1 => Ok(output),
        super::Exit::Code(_) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            Err(CoreError::new(if stderr.is_empty() {
                "Git command failed.".to_owned()
            } else {
                stderr
            }))
        }
        super::Exit::Killed => Err(output.error()),
    }
}

async fn git_text(cwd: &Path, args: &[&str], max_buffer: usize) -> CoreResult<String> {
    let output = git(cwd, args, max_buffer).await?;
    if output.exit != super::Exit::Code(0) || output.truncated {
        return Err(CoreError::new(
            "Git review data is unavailable or exceeds its size limit.",
        ));
    }
    Ok(output.stdout_text())
}

async fn resolve_revision(cwd: &Path, reference: &str, kind: &str) -> Option<String> {
    let spec = format!("{reference}^{{{kind}}}");
    git_text(
        cwd,
        &["rev-parse", "--verify", "--end-of-options", &spec],
        MAX_GIT_BYTES,
    )
    .await
    .ok()
    .map(|text| text.trim().to_owned())
}

fn digest(value: impl AsRef<[u8]>) -> String {
    let hash = Sha256::digest(value.as_ref());
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `JSON.stringify` of an object built from these keys in order, leaving out absent ones.
fn json_text(fields: &[(&str, Option<Value>)]) -> String {
    let mut object = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            object.insert((*key).to_owned(), value.clone());
        }
    }
    serde_json::to_string(&Value::Object(object)).expect("JSON values encode")
}

fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("review values encode")
}

/* ── Reading files ───────────────────────────────────────── */

/// A working-tree file or Git blob, with its bytes when they were read.
#[derive(Clone)]
struct Content {
    mode: String,
    digest: String,
    bytes: Option<Vec<u8>>,
    note: Option<String>,
}

impl Content {
    fn missing() -> Self {
        Self {
            mode: "missing".into(),
            digest: "missing".into(),
            bytes: None,
            note: None,
        }
    }

    fn noted(mode: &str, digest: String, note: &str) -> Self {
        Self {
            mode: mode.into(),
            digest,
            bytes: None,
            note: Some(note.into()),
        }
    }

    fn identity(&self) -> WorkingIdentity {
        WorkingIdentity {
            mode: self.mode.clone(),
            digest: self.digest.clone(),
            note: self.note.clone(),
        }
    }
}

impl From<&WorkingIdentity> for Content {
    fn from(identity: &WorkingIdentity) -> Self {
        Self {
            mode: identity.mode.clone(),
            digest: identity.digest.clone(),
            bytes: None,
            note: identity.note.clone(),
        }
    }
}

/// The TypeScript `safePath`: a relative path that stays inside `root`.
fn safe_path(root: &Path, path: &str) -> CoreResult<PathBuf> {
    let invalid = || CoreError::new("Invalid Git file path.");
    if path.is_empty() || Path::new(path).is_absolute() || path.contains('\0') {
        return Err(invalid());
    }
    let root = paths::absolute(root);
    let target = paths::resolve(&root, path);
    if !target.starts_with(&root) {
        return Err(invalid());
    }
    Ok(target)
}

fn is_missing(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// Node's `Stats.mtimeMs` and `ctimeMs`: seconds times 1000 plus nanoseconds over a million.
fn times(metadata: &std::fs::Metadata) -> (f64, f64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ms = |seconds: i64, nanos: i64| seconds as f64 * 1e3 + nanos as f64 / 1e6;
        (
            ms(metadata.mtime(), metadata.mtime_nsec()),
            ms(metadata.ctime(), metadata.ctime_nsec()),
        )
    }
    #[cfg(not(unix))]
    {
        let ms = |time: std::io::Result<std::time::SystemTime>| {
            time.ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |since| since.as_nanos() as f64 / 1e6)
        };
        (ms(metadata.modified()), ms(metadata.created()))
    }
}

fn inode(metadata: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0
    }
}

fn is_executable(metadata: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}

/// A JavaScript number's text, for the time-based digests.
fn js_number(value: f64) -> String {
    format!("{value}")
}

async fn read_working_file(root: &Path, path: &str, max_bytes: u64) -> CoreResult<Content> {
    let absolute = safe_path(root, path)?;
    // A replaced ancestor must not redirect a review read outside the checkout.
    let segments: Vec<&str> = path.split('/').collect();
    for end in 1..segments.len() {
        let ancestor = segments[..end]
            .iter()
            .fold(root.to_path_buf(), |path, segment| path.join(segment));
        match tokio::fs::symlink_metadata(&ancestor).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Ok(Content::noted(
                    "unsupported",
                    "symlink-parent".into(),
                    "A parent directory is a symbolic link; content was not followed.",
                ))
            }
            Ok(_) => {}
            Err(error) if is_missing(&error) => return Ok(Content::missing()),
            Err(error) => return Err(CoreError::io(&error, &ancestor)),
        }
    }
    let io = |error: std::io::Error| -> CoreResult<Content> {
        if is_missing(&error) {
            Ok(Content::missing())
        } else {
            Err(CoreError::io(&error, &absolute))
        }
    };
    let before = match tokio::fs::symlink_metadata(&absolute).await {
        Ok(metadata) => metadata,
        Err(error) => return io(error),
    };
    let (mtime, ctime) = times(&before);
    if before.is_dir() {
        return Ok(Content::noted(
            "160000",
            format!("{}:{}", js_number(mtime), js_number(ctime)),
            "Submodule or directory content is not included in this patch.",
        ));
    }
    let is_link = before.file_type().is_symlink();
    let mode = if is_link {
        "120000"
    } else if is_executable(&before) {
        "100755"
    } else {
        "100644"
    };
    if !is_link && !before.is_file() {
        return Ok(Content::noted(
            "unsupported",
            "special-file".into(),
            "Special file content is not supported.",
        ));
    }
    if before.len() > max_bytes {
        return Ok(Content::noted(
            mode,
            format!(
                "large:{}:{}:{}",
                before.len(),
                js_number(mtime),
                js_number(ctime)
            ),
            if before.len() > MAX_CONTENT_BYTES {
                "File exceeds the 8 MiB review content limit."
            } else {
                "File content was omitted because review preparation reached its byte or time budget."
            },
        ));
    }
    let bytes = if is_link {
        match tokio::fs::read_link(&absolute).await {
            Ok(target) => target.to_string_lossy().into_owned().into_bytes(),
            Err(error) => return io(error),
        }
    } else {
        match tokio::fs::read(&absolute).await {
            Ok(bytes) => bytes,
            Err(error) => return io(error),
        }
    };
    let after = match tokio::fs::symlink_metadata(&absolute).await {
        Ok(metadata) => metadata,
        Err(error) => return io(error),
    };
    if inode(&before) != inode(&after)
        || before.len() != after.len()
        || times(&before) != times(&after)
    {
        return Err(CoreError::new(
            "File changed while its review snapshot was being read.",
        ));
    }
    Ok(Content {
        mode: mode.into(),
        digest: digest(&bytes),
        bytes: Some(bytes),
        note: None,
    })
}

async fn read_blob(cwd: &Path, blob: Option<&BlobRef>) -> CoreResult<Content> {
    let Some(blob) = blob else {
        return Ok(Content::missing());
    };
    if blob.mode == "160000" {
        return Ok(Content::noted(
            &blob.mode,
            blob.oid.clone(),
            &format!(
                "Submodule revision {}; nested content is not included.",
                blob.oid
            ),
        ));
    }
    let size = git_text(cwd, &["cat-file", "-s", &blob.oid], MAX_GIT_BYTES).await?;
    // `Number("")` is 0 and an unreadable size is never over the limit, as in JavaScript.
    if size
        .trim()
        .parse::<f64>()
        .is_ok_and(|size| size > MAX_CONTENT_BYTES as f64)
    {
        return Ok(Content::noted(
            &blob.mode,
            blob.oid.clone(),
            "File exceeds the 8 MiB review content limit.",
        ));
    }
    let output = git(
        cwd,
        &["cat-file", "blob", &blob.oid],
        MAX_CONTENT_BYTES as usize,
    )
    .await?;
    if output.exit != super::Exit::Code(0) || output.truncated {
        return Err(CoreError::new("Git blob is unavailable."));
    }
    Ok(Content {
        mode: blob.mode.clone(),
        digest: blob.oid.clone(),
        bytes: Some(output.stdout),
        note: None,
    })
}

/* ── Listings ────────────────────────────────────────────── */

fn parse_blobs(output: &str, index: bool) -> CoreResult<HashMap<String, Vec<BlobRef>>> {
    let mut blobs: HashMap<String, Vec<BlobRef>> = HashMap::new();
    for record in nul_split(output) {
        if record.is_empty() {
            continue;
        }
        let invalid = || CoreError::new("Invalid Git blob listing.");
        let (head, path) = record.split_once('\t').ok_or_else(invalid)?;
        let fields: Vec<&str> = head.split(' ').collect();
        let mode = fields[0];
        let oid = fields.get(if index { 1 } else { 2 }).copied().unwrap_or("");
        if mode.is_empty() || oid.is_empty() {
            return Err(invalid());
        }
        let blob = BlobRef {
            mode: mode.into(),
            oid: oid.into(),
            stage: if index {
                Some(
                    fields
                        .get(2)
                        .and_then(|stage| stage.parse().ok())
                        .ok_or_else(invalid)?,
                )
            } else {
                None
            },
        };
        blobs.entry(path.to_owned()).or_default().push(blob);
    }
    Ok(blobs)
}

/// Splits pathspecs into command-line-sized batches, without repeats.
fn path_batches<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<Vec<&'a str>> {
    let mut batches = Vec::new();
    let mut batch: Vec<&str> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut bytes = 0;
    for path in paths {
        if !seen.insert(path) {
            continue;
        }
        let size = path.len() + 1;
        if !batch.is_empty() && bytes + size > MAX_PATHSPEC_BYTES {
            batches.push(std::mem::take(&mut batch));
            bytes = 0;
        }
        batch.push(path);
        bytes += size;
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

/// Lists only the named paths, so the cost follows the change set rather than the size of
/// the repository. Without paths nothing is listed (an empty pathspec would list everything).
async fn list_blobs<'a>(
    cwd: &Path,
    command: &[&str],
    paths: impl IntoIterator<Item = &'a str>,
    index: bool,
    max_git_bytes: usize,
) -> CoreResult<HashMap<String, Vec<BlobRef>>> {
    let mut blobs = HashMap::new();
    for batch in path_batches(paths) {
        let mut args = command.to_vec();
        args.push("--");
        args.extend(batch);
        let output = git_text(cwd, &args, max_git_bytes).await?;
        blobs.extend(parse_blobs(&output, index)?);
    }
    Ok(blobs)
}

async fn tree<'a>(
    cwd: &Path,
    oid: Option<&str>,
    paths: impl IntoIterator<Item = &'a str>,
    max_git_bytes: usize,
) -> CoreResult<HashMap<String, Vec<BlobRef>>> {
    match oid {
        Some(oid) => {
            list_blobs(
                cwd,
                &["ls-tree", "-r", "-z", oid],
                paths,
                false,
                max_git_bytes,
            )
            .await
        }
        None => Ok(HashMap::new()),
    }
}

#[derive(Debug, Clone)]
struct StatusFile {
    path: String,
    previous_path: Option<String>,
    status: &'static str,
    has_staged_changes: bool,
    has_unstaged_changes: bool,
    conflicted: bool,
    records: Vec<String>,
}

/// `git status --porcelain=v1 -z` by path, in first-seen order. A path listed twice (an
/// unmerged path, or a new file at a staged rename's old path) merges into one entry.
fn parse_status(output: &str) -> CoreResult<Vec<StatusFile>> {
    let records = nul_split(output);
    let mut files: Vec<StatusFile> = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let units: Vec<u16> = record.encode_utf16().collect();
        if units.len() < 4 || units[2] != u16::from(b' ') {
            return Err(CoreError::new("Invalid Git status."));
        }
        let xy = String::from_utf16_lossy(&units[..2]);
        let path = String::from_utf16_lossy(&units[3..]);
        let previous_path = if xy.contains(['R', 'C']) {
            index += 1;
            records.get(index - 1).map(|path| (*path).to_owned())
        } else {
            None
        }
        .filter(|path| !path.is_empty());
        let conflicted = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].contains(&xy.as_str());
        let status = if conflicted {
            "conflicted"
        } else if xy == "??" {
            "untracked"
        } else if xy.contains('R') {
            "renamed"
        } else if xy.contains('C') {
            "copied"
        } else if xy.contains('T') {
            "typechanged"
        } else if xy.contains('A') {
            "added"
        } else if xy.contains('D') {
            "deleted"
        } else {
            "modified"
        };
        let mut columns = xy.chars();
        let (x, y) = (columns.next().unwrap_or(' '), columns.next().unwrap_or(' '));
        let prior = files.iter().position(|file| file.path == path);
        let mut records_so_far = prior.map_or_else(Vec::new, |at| files[at].records.clone());
        records_so_far.push(record.to_owned());
        if let Some(previous) = &previous_path {
            records_so_far.push(previous.clone());
        }
        let next = StatusFile {
            status: if prior.is_some() { "modified" } else { status },
            has_staged_changes: prior.is_some_and(|at| files[at].has_staged_changes)
                || (x != ' ' && x != '?'),
            has_unstaged_changes: prior.is_some_and(|at| files[at].has_unstaged_changes)
                || y != ' ',
            conflicted: prior.is_some_and(|at| files[at].conflicted) || conflicted,
            records: records_so_far,
            previous_path,
            path,
        };
        match prior {
            Some(at) => files[at] = next,
            None => files.push(next),
        }
    }
    Ok(files)
}

/// Staged and Unstaged report the status of their own side: Git's X column for the index,
/// Y for the working tree.
fn scoped_status(entry: &StatusFile, kind: Kind) -> String {
    if kind == Kind::Uncommitted || entry.conflicted {
        return entry.status.into();
    }
    let column = if kind == Kind::Staged { 0 } else { 1 };
    let code = entry
        .records
        .iter()
        .filter_map(|record| {
            let units: Vec<u16> = record.encode_utf16().collect();
            (units.len() > 3 && units[2] == u16::from(b' ')).then(|| units[column])
        })
        .map(|unit| char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}'))
        .find(|code| *code != ' ' && (kind != Kind::Staged || *code != '?'));
    match code {
        Some('M') => "modified",
        Some('A') => "added",
        Some('D') => "deleted",
        Some('R') => "renamed",
        Some('C') => "copied",
        Some('T') => "typechanged",
        Some('?') => "untracked",
        _ => entry.status,
    }
    .into()
}

fn working_part(working: Option<&WorkingIdentity>) -> Option<Value> {
    working.map(|working| json!({ "mode": working.mode, "digest": working.digest }))
}

/// Everything a comparison's actions depend on. Staged compares HEAD with the index, so
/// working-tree edits (and the status column that reports them) never make it stale.
fn fingerprint(source: &FileSource, kind: Kind) -> String {
    let text = if kind == Kind::Staged {
        json_text(&[
            ("base", source.base.as_ref().map(to_json)),
            ("index", Some(to_json(&source.index))),
        ])
    } else {
        json_text(&[
            ("base", source.base.as_ref().map(to_json)),
            ("head", source.head.as_ref().map(to_json)),
            ("index", Some(to_json(&source.index))),
            ("working", working_part(source.working.as_ref())),
            ("statusRecords", Some(to_json(&source.status_records))),
        ])
    };
    digest(text)
}

/// Staging moves content between sides, so Staged and Unstaged fingerprint their own two sides.
fn content_fingerprint(source: &FileSource, kind: Kind) -> String {
    let index = source
        .index
        .iter()
        .find(|blob| blob.stage == Some(0))
        .map(to_json);
    let working = working_part(source.working.as_ref());
    let base = source.base.as_ref().map(to_json);
    digest(match kind {
        Kind::Staged => json_text(&[("base", base), ("index", index)]),
        Kind::Unstaged => json_text(&[("index", index), ("working", working)]),
        _ => json_text(&[
            ("base", base),
            ("head", source.head.as_ref().map(to_json)),
            ("working", working),
        ]),
    })
}

async fn default_base(cwd: &Path) -> CoreResult<Option<String>> {
    let text = |args: &'static [&'static str]| async move {
        git_text(cwd, args, MAX_GIT_BYTES)
            .await
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let branch = text(&["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
    let remote = if branch.is_empty() {
        String::new()
    } else {
        let key = format!("branch.{branch}.remote");
        git_text(cwd, &["config", "--get", &key], MAX_GIT_BYTES)
            .await
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let listing = git_text(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname) %(symref)",
            "refs/remotes",
        ],
        MAX_GIT_BYTES,
    )
    .await?;
    let remote_heads: Vec<&str> = listing
        .split('\n')
        .filter(|line| line.contains("/HEAD "))
        .collect();
    let preferred_prefix = format!("refs/remotes/{remote}/HEAD ");
    let chosen = remote_heads
        .iter()
        .find(|line| line.starts_with(&preferred_prefix))
        .or_else(|| (remote_heads.len() == 1).then(|| &remote_heads[0]));
    if let Some(chosen) = chosen {
        let target = chosen
            .split_once(' ')
            .map_or(*chosen, |(_, rest)| rest)
            .trim();
        return Ok((!target.is_empty()).then(|| target.to_owned()));
    }
    if branch.is_empty() {
        return Ok(None);
    }
    let upstream = text(&["rev-parse", "--symbolic-full-name", "@{upstream}"]).await;
    Ok((!upstream.is_empty()).then_some(upstream))
}

/* ── Creating a review ───────────────────────────────────── */

async fn create(
    checkout_path: &str,
    scope: Scope,
    max_git_bytes: usize,
) -> CoreResult<Result<Snapshot, Value>> {
    let cwd = Path::new(checkout_path);
    let kind = scope.kind();
    if kind != Kind::Turn {
        let top_level = git_text(cwd, &["rev-parse", "--show-toplevel"], MAX_GIT_BYTES).await?;
        let real = |path: &Path| paths::realpath(path).map_err(|error| CoreError::io(&error, path));
        if real(cwd)? != real(Path::new(top_level.trim()))? {
            return Ok(Err(issue(
                "unavailable",
                "nested-workspace",
                "Git review requires the checkout root. Open the repository root to review its changes.",
            )));
        }
    }
    if kind.is_working() {
        create_working(cwd, checkout_path, scope, kind, max_git_bytes).await
    } else {
        create_comparison(cwd, checkout_path, scope, kind, max_git_bytes).await
    }
}

async fn create_working(
    cwd: &Path,
    checkout_path: &str,
    scope: Scope,
    kind: Kind,
    max_git_bytes: usize,
) -> CoreResult<Result<Snapshot, Value>> {
    let deadline = Instant::now() + PREPARATION_TIME;
    let head_oid = resolve_revision(cwd, "HEAD", "commit").await;
    let entries: Vec<StatusFile> = parse_status(
        &git_text(
            cwd,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            max_git_bytes,
        )
        .await?,
    )?
    .into_iter()
    .filter(|entry| match kind {
        Kind::Staged => entry.has_staged_changes,
        Kind::Unstaged => entry.has_unstaged_changes,
        _ => true,
    })
    .collect();
    let included = &entries[..entries.len().min(MAX_FILES)];
    let (index_blobs, base_blobs) = tokio::join!(
        list_blobs(
            cwd,
            &["ls-files", "--stage", "-z"],
            included.iter().map(|entry| entry.path.as_str()),
            true,
            max_git_bytes,
        ),
        tree(
            cwd,
            head_oid.as_deref(),
            included
                .iter()
                .map(|entry| entry.previous_path.as_deref().unwrap_or(&entry.path)),
            max_git_bytes,
        ),
    );
    let (index_blobs, base_blobs) = (index_blobs?, base_blobs?);
    let counts = working_line_counts(cwd, kind, head_oid.as_deref(), max_git_bytes).await?;
    let mut files = Vec::new();
    let mut remaining_bytes = MAX_PREPARATION_BYTES;
    for entry in included {
        // Staged never shows the working tree, so it does not spend the read budget on it.
        let working = if kind == Kind::Staged {
            None
        } else {
            let budget = if Instant::now() < deadline {
                remaining_bytes.min(MAX_CONTENT_BYTES)
            } else {
                0
            };
            Some(read_working_file(cwd, &entry.path, budget).await?)
        };
        remaining_bytes -= working
            .as_ref()
            .and_then(|working| working.bytes.as_ref())
            .map_or(0, |bytes| bytes.len() as u64);
        let source = FileSource {
            base: base_blobs
                .get(entry.previous_path.as_deref().unwrap_or(&entry.path))
                .and_then(|blobs| blobs.first())
                .cloned(),
            head: None,
            index: index_blobs.get(&entry.path).cloned().unwrap_or_default(),
            working: working.as_ref().map(Content::identity),
            status_records: entry.records.clone(),
        };
        let untracked = entry.records.iter().any(|record| record.starts_with("?? "));
        let lines = if entry.conflicted {
            None
        } else if untracked && (entry.status == "untracked" || kind == Kind::Unstaged) {
            // Git diff does not list untracked files, so their added lines are counted here.
            // A staged deletion recreated untracked is all-added in Unstaged, and a
            // replacement Git cannot count in Uncommitted.
            count_text_lines(
                working
                    .as_ref()
                    .and_then(|working| working.bytes.as_deref()),
            )
        } else if untracked && kind == Kind::Uncommitted {
            None
        } else {
            match counts.lines.get(&entry.path) {
                Some(Some(lines)) => Some(lines.clone()),
                // Git leaves out a file whose sides match, such as cancelling staged edits.
                // (A binary file's missing count lands here too, as it always has.)
                _ if counts.truncated => None,
                _ => Some(zero_lines()),
            }
        };
        files.push(ReviewFile {
            id: digest(&entry.path),
            path: entry.path.clone(),
            previous_path: entry.previous_path.clone(),
            status: scoped_status(entry, kind),
            has_staged_changes: entry.has_staged_changes,
            has_unstaged_changes: entry.has_unstaged_changes,
            conflicted: entry.conflicted,
            lines,
            fingerprint: fingerprint(&source, kind),
            content_fingerprint: content_fingerprint(&source, kind),
            source,
        });
    }
    // Each file's index and working state is checked against its fingerprint again before it
    // is read, reviewed or staged, so the repository-wide listings are not repeated here.
    if head_oid != resolve_revision(cwd, "HEAD", "commit").await {
        return Ok(Err(issue(
            "stale",
            "checkout-changed",
            "The checkout changed while the review was being created. Refresh it.",
        )));
    }
    let mut notes: Vec<String> = files
        .iter()
        .filter_map(|file| file.source.working.as_ref()?.note.clone())
        .collect();
    if !files.is_empty() {
        // Patch generation compares raw bytes without clean/textconv conversion.
        let mut attribute_paths: Vec<&str> = files
            .iter()
            .take(100)
            .map(|file| file.path.as_str())
            .collect();
        while attribute_paths.join("\0").encode_utf16().count() > 32_000 {
            attribute_paths.pop();
        }
        let mut args = vec![
            "check-attr",
            "-z",
            "filter",
            "working-tree-encoding",
            "eol",
            "--",
        ];
        args.extend(&attribute_paths);
        let attributes = git_text(cwd, &args, MAX_GIT_BYTES).await?;
        let transformed = nul_split(&attributes)
            .iter()
            .enumerate()
            .any(|(index, value)| index % 3 == 2 && *value != "unspecified" && *value != "unset");
        let auto_crlf = git_text(cwd, &["config", "--get", "core.autocrlf"], MAX_GIT_BYTES)
            .await
            .unwrap_or_default();
        let auto_crlf = auto_crlf.trim();
        if transformed || auto_crlf == "true" || auto_crlf == "input" {
            notes.push("Patches compare raw working bytes with Git blobs; configured filters and line-ending conversions are not applied.".into());
        }
        if files.len() > attribute_paths.len() {
            notes.push(format!("Attribute-conversion coverage was checked for the first {} changed files only; patches use raw bytes.", attribute_paths.len()));
        }
    }
    if entries.len() > MAX_FILES {
        notes.push(format!(
            "Only the first {MAX_FILES} changed files are included."
        ));
    }
    let head = if head_oid.is_some() {
        "HEAD"
    } else {
        "Empty repository"
    };
    Ok(Ok(Snapshot {
        state: "available".into(),
        checkout_path: checkout_path.into(),
        base_label: match kind {
            Kind::Staged => format!("{head} → index"),
            Kind::Unstaged => "Index → working tree".into(),
            _ => format!("{head} → working tree"),
        },
        scope,
        base_oid: head_oid.clone(),
        head_oid,
        coverage: if notes.is_empty() {
            complete()
        } else {
            partial(notes)
        },
        files,
    }))
}

async fn create_comparison(
    cwd: &Path,
    checkout_path: &str,
    scope: Scope,
    kind: Kind,
    max_git_bytes: usize,
) -> CoreResult<Result<Snapshot, Value>> {
    let (head_ref, revision_kind) = match &scope {
        Scope::Turn { after_tree_oid, .. } => (after_tree_oid.clone().unwrap_or_default(), "tree"),
        _ => ("HEAD".to_owned(), "commit"),
    };
    let Some(head_oid) = resolve_revision(cwd, &head_ref, revision_kind).await else {
        return Ok(Err(issue(
            "unavailable",
            "missing-head",
            "This comparison has no available head revision.",
        )));
    };
    let base_ref = match &scope {
        Scope::Turn {
            before_tree_oid, ..
        } => before_tree_oid.clone(),
        Scope::Branch {
            base_ref: Some(base_ref),
        } => Some(base_ref.clone()),
        _ => default_base(cwd).await?,
    };
    let Some(base_ref) = base_ref.filter(|base_ref| !base_ref.is_empty()) else {
        return Ok(Err(issue(
            "unavailable",
            "missing-base",
            "No repository default or tracking branch is configured. Choose a base reference.",
        )));
    };
    let Some(mut base_oid) = resolve_revision(cwd, &base_ref, revision_kind).await else {
        return Ok(Err(issue(
            "unavailable",
            "missing-base",
            "The selected base reference is unavailable.",
        )));
    };
    if kind == Kind::Branch {
        base_oid = git_text(cwd, &["merge-base", &base_oid, &head_oid], MAX_GIT_BYTES)
            .await
            .unwrap_or_default()
            .trim()
            .to_owned();
        if base_oid.is_empty() {
            return Ok(Err(issue(
                "unavailable",
                "unrelated-base",
                "The selected base and HEAD have no common ancestor.",
            )));
        }
    }
    let listing = git_text(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "-z",
            "--find-renames",
            &base_oid,
            &head_oid,
            "--",
        ],
        max_git_bytes,
    )
    .await?;
    let names = nul_split(&listing);
    struct Change<'a> {
        code: &'a str,
        first: &'a str,
        path: &'a str,
        renamed: bool,
    }
    let mut changes = Vec::new();
    let mut index = 0;
    while index < names.len() {
        let code = names[index];
        index += 1;
        if code.is_empty() {
            continue;
        }
        let renamed = code.starts_with(['R', 'C']);
        let first = names.get(index).copied().unwrap_or("");
        index += 1;
        let path = if renamed {
            index += 1;
            names.get(index - 1).copied().unwrap_or("")
        } else {
            first
        };
        if path.is_empty() || first.is_empty() {
            return Err(CoreError::new("Invalid Git comparison listing."));
        }
        changes.push(Change {
            code,
            first,
            path,
            renamed,
        });
    }
    let included = &changes[..changes.len().min(MAX_FILES)];
    let (base_blobs, head_blobs) = tokio::join!(
        tree(
            cwd,
            Some(&base_oid),
            included.iter().map(|change| change.first),
            max_git_bytes,
        ),
        tree(
            cwd,
            Some(&head_oid),
            included.iter().map(|change| change.path),
            max_git_bytes,
        ),
    );
    let (base_blobs, head_blobs) = (base_blobs?, head_blobs?);
    let mut counts: HashMap<String, Option<LineCounts>> = HashMap::new();
    for file in numstat(cwd, &[&base_oid, &head_oid], max_git_bytes).await? {
        counts.insert(file.path, file.lines);
    }
    let files = included
        .iter()
        .map(|change| {
            let source = FileSource {
                base: base_blobs
                    .get(change.first)
                    .and_then(|blobs| blobs.first())
                    .cloned(),
                head: head_blobs
                    .get(change.path)
                    .and_then(|blobs| blobs.first())
                    .cloned(),
                index: Vec::new(),
                working: None,
                status_records: Vec::new(),
            };
            ReviewFile {
                id: digest(change.path),
                path: change.path.into(),
                previous_path: change.renamed.then(|| change.first.to_owned()),
                status: match change.code.chars().next() {
                    Some('A') => "added",
                    Some('D') => "deleted",
                    Some('R') => "renamed",
                    Some('C') => "copied",
                    Some('T') => "typechanged",
                    _ => "modified",
                }
                .into(),
                has_staged_changes: false,
                has_unstaged_changes: false,
                conflicted: false,
                lines: counts.get(change.path).cloned().flatten(),
                fingerprint: fingerprint(&source, kind),
                content_fingerprint: content_fingerprint(&source, kind),
                source,
            }
        })
        .collect();
    let (scope_coverage, snapshot_scope, base_label) = match scope {
        Scope::Turn {
            checkpoint_id,
            coverage,
            ..
        } => (
            coverage.unwrap_or_else(complete),
            Scope::Turn {
                checkpoint_id,
                before_tree_oid: None,
                after_tree_oid: None,
                coverage: None,
            },
            "Captured turn".to_owned(),
        ),
        _ => (
            complete(),
            Scope::Branch {
                base_ref: Some(base_ref.clone()),
            },
            base_ref,
        ),
    };
    let coverage = combine_coverage(&[
        scope_coverage,
        if changes.len() > MAX_FILES {
            partial([format!(
                "Only the first {MAX_FILES} changed files are included."
            )])
        } else {
            complete()
        },
    ]);
    Ok(Ok(Snapshot {
        state: "available".into(),
        checkout_path: checkout_path.into(),
        scope: snapshot_scope,
        base_label,
        head_oid: Some(head_oid),
        base_oid: Some(base_oid),
        coverage,
        files,
    }))
}

struct ChangedFile {
    path: String,
    previous_path: Option<String>,
    lines: Option<LineCounts>,
}

impl ChangedFile {
    fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("path".into(), self.path.clone().into());
        if let Some(previous) = &self.previous_path {
            object.insert("previousPath".into(), previous.clone().into());
        }
        object.insert("lines".into(), to_json(&self.lines));
        Value::Object(object)
    }
}

fn zero_lines() -> LineCounts {
    LineCounts {
        added: 0.into(),
        removed: 0.into(),
    }
}

/// `Number(text)` for Git's counts; JSON writes anything unreadable as `null`, as `NaN` was.
fn count(text: &str) -> Value {
    text.parse::<u64>().map_or(Value::Null, Value::from)
}

/// `git diff --numstat` for the given comparison arguments, in Git's path order.
async fn numstat(
    cwd: &Path,
    comparison: &[&str],
    max_git_bytes: usize,
) -> CoreResult<Vec<ChangedFile>> {
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        "--find-renames",
    ];
    args.extend_from_slice(comparison);
    args.push("--");
    let output = git_text(cwd, &args, max_git_bytes).await?;
    let records = nul_split(&output);
    let invalid = || CoreError::new("Invalid Git change summary.");
    let mut files = Vec::new();
    let mut index = 0;
    while index < records.len() && files.len() < MAX_FILES {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        // With -z paths are not quoted, so a path may itself contain tabs.
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(inline_path)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return Err(invalid());
        };
        // A rename leaves the inline path empty and lists the old and new paths next.
        let (previous_path, path) = if inline_path.is_empty() {
            let previous = records.get(index).copied();
            let path = records.get(index + 1).copied();
            index += 2;
            (Some(previous.unwrap_or("")), path.unwrap_or(""))
        } else {
            (None, inline_path)
        };
        if path.is_empty() || previous_path == Some("") {
            return Err(invalid());
        }
        files.push(ChangedFile {
            path: path.into(),
            previous_path: previous_path.map(str::to_owned),
            lines: if added == "-" || removed == "-" {
                None
            } else {
                Some(LineCounts {
                    added: count(added),
                    removed: count(removed),
                })
            },
        });
    }
    Ok(files)
}

async fn empty_tree(cwd: &Path) -> CoreResult<&'static str> {
    let format = git_text(cwd, &["rev-parse", "--show-object-format"], MAX_GIT_BYTES).await?;
    Ok(if format.trim() == "sha256" {
        "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
    } else {
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    })
}

struct LineCountMap {
    lines: HashMap<String, Option<LineCounts>>,
    /// The listing stopped at the file cap, so a missing path may still have changes.
    truncated: bool,
}

/// Tracked-file line counts for a working scope, keyed by current path.
async fn working_line_counts(
    cwd: &Path,
    kind: Kind,
    head_oid: Option<&str>,
    max_git_bytes: usize,
) -> CoreResult<LineCountMap> {
    // Before the first commit, Uncommitted compares Git's empty tree with the working tree.
    let base = match head_oid {
        Some(head) => head,
        None => empty_tree(cwd).await?,
    };
    let comparison: &[&str] = match kind {
        Kind::Staged => &["--cached"],
        Kind::Unstaged => &[],
        _ => &[base],
    };
    let files = numstat(cwd, comparison, max_git_bytes).await?;
    let truncated = files.len() >= MAX_FILES;
    Ok(LineCountMap {
        lines: files
            .into_iter()
            .map(|file| (file.path, file.lines))
            .collect(),
        truncated,
    })
}

fn count_text_lines(bytes: Option<&[u8]>) -> Option<LineCounts> {
    let bytes = bytes?;
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    if bytes.is_empty() {
        return Some(zero_lines());
    }
    let mut added = bytes.iter().filter(|byte| **byte == b'\n').count();
    if bytes.last() != Some(&b'\n') {
        added += 1;
    }
    Some(LineCounts {
        added: added.into(),
        removed: 0.into(),
    })
}

/* ── Reading, checking and staging one file ──────────────── */

/// `null` when the file is unchanged since the review read it, else the issue to show.
async fn check_file_current(snapshot: &Snapshot, file_id: &str) -> Option<Value> {
    let Some(file) = snapshot.files.iter().find(|entry| entry.id == file_id) else {
        return Some(issue(
            "unavailable",
            "missing-file",
            "This file does not belong to the review.",
        ));
    };
    let kind = snapshot.scope.kind();
    if !kind.is_working() {
        return None;
    }
    match check_working_file(snapshot, file, kind).await {
        Ok(None) => None,
        Ok(Some(issue)) => Some(issue),
        Err(error) => Some(issue("unavailable", "freshness-unavailable", error.message)),
    }
}

async fn check_working_file(
    snapshot: &Snapshot,
    file: &ReviewFile,
    kind: Kind,
) -> CoreResult<Option<Value>> {
    let cwd = Path::new(&snapshot.checkout_path);
    // Path-limited status only pairs a rename when both sides are in the pathspec, so include
    // the other half of any rename touching this file, or its records differ from the review's.
    let mut own_paths = vec![file.path.as_str()];
    own_paths.extend(file.previous_path.as_deref());
    let mut paths: Vec<&str> = Vec::new();
    for path in own_paths.iter().copied().chain(
        snapshot
            .files
            .iter()
            .filter(|entry| {
                entry
                    .previous_path
                    .as_deref()
                    .is_some_and(|previous| !previous.is_empty() && own_paths.contains(&previous))
            })
            .map(|entry| entry.path.as_str()),
    ) {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    let head = resolve_revision(cwd, "HEAD", "commit").await;
    if head != snapshot.head_oid {
        return Ok(Some(issue(
            "stale",
            "head-changed",
            "HEAD changed. Refresh the review.",
        )));
    }
    let mut args = vec!["ls-files", "--stage", "-z", "--"];
    args.extend(&paths);
    let index = parse_blobs(&git_text(cwd, &args, MAX_GIT_BYTES).await?, true)?;
    let mut source = file.source.clone();
    source.index = index.get(&file.path).cloned().unwrap_or_default();
    // Staged compares HEAD with the index only, so it skips the status and working reads.
    if kind != Kind::Staged {
        let mut args = vec![
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
        ];
        args.extend(&paths);
        source.status_records = parse_status(&git_text(cwd, &args, MAX_GIT_BYTES).await?)?
            .into_iter()
            .find(|entry| entry.path == file.path)
            .map(|entry| entry.records)
            .unwrap_or_default();
        let budget = if file
            .source
            .working
            .as_ref()
            .is_some_and(|working| working.note.is_some())
        {
            0
        } else {
            MAX_CONTENT_BYTES
        };
        source.working = Some(read_working_file(cwd, &file.path, budget).await?.identity());
    }
    Ok((fingerprint(&source, kind) != file.fingerprint).then(|| {
        issue(
            "stale",
            "file-changed",
            "The file or index changed. Refresh the review before continuing.",
        )
    }))
}

struct Patch {
    patch: String,
    coverage: Coverage,
}

fn has_nul_prefix(content: &Content) -> bool {
    content
        .bytes
        .as_deref()
        .is_some_and(|bytes| bytes[..bytes.len().min(8000)].contains(&0))
}

async fn read_patch(
    path: &str,
    before_path: &str,
    before: &Content,
    after: &Content,
) -> CoreResult<Patch> {
    if before.note.is_some() || after.note.is_some() {
        return Ok(Patch {
            patch: String::new(),
            coverage: partial(before.note.iter().chain(&after.note).cloned()),
        });
    }
    if before.mode == "missing" && after.mode == "missing" {
        return Ok(Patch {
            patch: String::new(),
            coverage: complete(),
        });
    }
    let scratch = scratch_dir().await?;
    let result = diff_in(&scratch, path, before_path, before, after).await;
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    result
}

async fn diff_in(
    scratch: &Path,
    path: &str,
    before_path: &str,
    before: &Content,
    after: &Content,
) -> CoreResult<Patch> {
    let left = materialize(scratch, "a", before_path, before).await?;
    let right = materialize(scratch, "b", path, after).await?;
    let output = git(
        scratch,
        &[
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-prefix",
            "--",
            &left,
            &right,
        ],
        MAX_PATCH_BYTES,
    )
    .await?;
    let patch = output.stdout_text();
    let mut notes = Vec::new();
    if output.truncated {
        notes.push("Patch is truncated at the 1 MiB review limit.".to_owned());
    }
    if patch.contains("Binary files ") || has_nul_prefix(before) || has_nul_prefix(after) {
        notes.push(
            "Binary file contents are not rendered; the patch reports whether they differ."
                .to_owned(),
        );
    }
    Ok(Patch {
        patch,
        coverage: if notes.is_empty() {
            complete()
        } else {
            partial(notes)
        },
    })
}

/// Writes one side of a patch under the scratch folder; the path Git should compare.
async fn materialize(scratch: &Path, side: &str, name: &str, file: &Content) -> CoreResult<String> {
    if file.mode == "missing" {
        return Ok(if cfg!(windows) {
            r"\\.\nul"
        } else {
            "/dev/null"
        }
        .to_owned());
    }
    let relative = format!("{side}/{name}");
    let target = safe_path(scratch, &relative)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| CoreError::io(&error, parent))?;
    }
    let bytes = file.bytes.clone().unwrap_or_default();
    let written = if file.mode == "120000" {
        let link = String::from_utf8_lossy(&bytes).into_owned();
        #[cfg(unix)]
        let made = tokio::fs::symlink(link, &target).await;
        #[cfg(windows)]
        let made = tokio::fs::symlink_file(link, &target).await;
        made
    } else {
        let written = tokio::fs::write(&target, &bytes).await;
        #[cfg(unix)]
        let written = match written {
            Ok(()) => {
                use std::os::unix::fs::PermissionsExt;
                let mode = if file.mode == "100755" { 0o755 } else { 0o644 };
                tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode)).await
            }
            error => error,
        };
        written
    };
    written.map_err(|error| CoreError::io(&error, &target))?;
    Ok(relative)
}

/// `mkdtemp(join(tmpdir(), "pi-gui-review-"))`.
async fn scratch_dir() -> CoreResult<PathBuf> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let temp = std::env::temp_dir();
    loop {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        let dir = temp.join(format!(
            "pi-gui-review-{:x}{:x}{:x}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            nanos
        ));
        match tokio::fs::create_dir(&dir).await {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(CoreError::io(&error, &dir)),
        }
    }
}

async fn read_file(snapshot: &Snapshot, file_id: &str) -> Value {
    let Some(file) = snapshot.files.iter().find(|entry| entry.id == file_id) else {
        return issue(
            "unavailable",
            "missing-file",
            "This file does not belong to the review.",
        );
    };
    if let Some(stale) = check_file_current(snapshot, file_id).await {
        return stale;
    }
    match read_file_patch(snapshot, file).await {
        Ok(Ok(result)) => match check_file_current(snapshot, file_id).await {
            Some(stale) => stale,
            None => result,
        },
        Ok(Err(issue)) => issue,
        Err(error) => issue("failed", "file-review-failed", error.message),
    }
}

async fn read_file_patch(
    snapshot: &Snapshot,
    file: &ReviewFile,
) -> CoreResult<Result<Value, Value>> {
    let cwd = Path::new(&snapshot.checkout_path);
    let kind = snapshot.scope.kind();
    let read_index = || {
        read_blob(
            cwd,
            file.source.index.iter().find(|blob| blob.stage == Some(0)),
        )
    };
    let read_working = || async {
        match &file.source.working {
            Some(working) if working.note.is_some() => Ok(Content::from(working)),
            _ => read_working_file(cwd, &file.path, MAX_CONTENT_BYTES).await,
        }
    };
    // A conflict has no single index side. Uncommitted and Unstaged show HEAD → working tree;
    // Staged never reads the working tree, so it shows only the summary of index stages.
    let side = if file.conflicted && kind.is_working() {
        Kind::Uncommitted
    } else {
        kind
    };
    let conflicted_staged = file.conflicted && kind == Kind::Staged;
    let before_path = if side == Kind::Unstaged {
        file.path.as_str()
    } else {
        file.previous_path.as_deref().unwrap_or(&file.path)
    };
    let Patch { patch, coverage } = if conflicted_staged {
        Patch {
            patch: String::new(),
            coverage: complete(),
        }
    } else {
        let before = if side == Kind::Unstaged {
            read_index().await?
        } else {
            read_blob(cwd, file.source.base.as_ref()).await?
        };
        let after = match side {
            Kind::Staged => read_index().await?,
            Kind::Uncommitted | Kind::Unstaged => read_working().await?,
            _ => read_blob(cwd, file.source.head.as_ref()).await?,
        };
        read_patch(&file.path, before_path, &before, &after).await?
    };
    let summary = if file.conflicted {
        let stages: Vec<String> = file
            .source
            .index
            .iter()
            .map(|blob| {
                let name = match blob.stage {
                    Some(1) => "base",
                    Some(2) => "ours",
                    _ => "theirs",
                };
                format!("{name} {}", blob.oid)
            })
            .collect();
        Some(format!(
            "Unmerged index stages: {}. Resolve the conflict before staging through review.",
            stages.join("; ")
        ))
    } else if kind == Kind::Uncommitted
        && patch.is_empty()
        && file.has_staged_changes
        && file.has_unstaged_changes
    {
        Some("The combined contents match HEAD; staged and unstaged changes cancel each other. Choose Staged or Unstaged to see each part.".to_owned())
    } else {
        None
    };
    let coverage = combine_coverage(&[
        coverage,
        if file.conflicted {
            partial([
                "Unmerged index stages are summarized; no staged or unstaged patch is claimed."
                    .to_owned(),
            ])
        } else {
            complete()
        },
    ]);
    let mut result = json!({ "state": "available", "patch": patch, "coverage": coverage });
    if let Some(summary) = summary {
        result["summary"] = summary.into();
    }
    Ok(Ok(result))
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Stage,
    Unstage,
}

async fn change_file_stage(snapshot: &Snapshot, file_id: &str, action: Stage) -> Value {
    let kind = snapshot.scope.kind();
    if !kind.is_working() {
        return issue(
            "unavailable",
            "immutable-comparison",
            "Only Uncommitted, Staged and Unstaged review can change the index.",
        );
    }
    // Staged and Unstaged only move the side they show: staging from Staged or unstaging from
    // Unstaged would change content that comparison never displayed.
    let allowed = match kind {
        Kind::Staged => action == Stage::Unstage,
        Kind::Unstaged => action == Stage::Stage,
        _ => true,
    };
    if !allowed {
        return issue(
            "unavailable",
            "unseen-stage-change",
            if action == Stage::Stage {
                "Staged review cannot stage working-tree edits it does not show."
            } else {
                "Unstaged review cannot unstage index changes it does not show."
            },
        );
    }
    let Some(file) = snapshot.files.iter().find(|entry| entry.id == file_id) else {
        return issue(
            "unavailable",
            "missing-file",
            "This file does not belong to the review.",
        );
    };
    if file.conflicted
        || file
            .source
            .working
            .as_ref()
            .is_some_and(|working| working.note.is_some())
    {
        return issue(
            "unavailable",
            "unsupported-staging",
            "Resolve this file's conflict or incomplete coverage before staging it through review.",
        );
    }
    if let Some(stale) = check_file_current(snapshot, file_id).await {
        return stale;
    }
    // A staged rename has already removed its previous path from the index and working tree,
    // so `git add` must name only the current path. Unstaging restores both halves of the pair.
    let mut paths = vec![file.path.as_str()];
    if let Some(previous) = file.previous_path.as_deref() {
        if previous != file.path {
            paths.push(previous);
        }
    }
    let mut args = match (action, snapshot.head_oid.as_deref()) {
        (Stage::Stage, _) => vec!["add", "--", file.path.as_str()],
        (Stage::Unstage, Some(head)) => vec!["reset", "--quiet", head, "--"],
        (Stage::Unstage, None) => vec!["rm", "--cached", "--ignore-unmatch", "--force", "--"],
    };
    if action == Stage::Unstage {
        args.extend(&paths);
    }
    match git_text(Path::new(&snapshot.checkout_path), &args, MAX_GIT_BYTES).await {
        Ok(_) => json!({ "state": "applied" }),
        Err(error) => issue("failed", "stage-failed", error.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_hash_the_same_json_text_as_javascript() {
        let source = FileSource {
            base: Some(BlobRef {
                mode: "100644".into(),
                oid: "a".into(),
                stage: None,
            }),
            head: None,
            index: vec![BlobRef {
                mode: "100644".into(),
                oid: "b".into(),
                stage: Some(0),
            }],
            working: Some(WorkingIdentity {
                mode: "100644".into(),
                digest: "c".into(),
                note: Some("dropped from the identity".into()),
            }),
            status_records: vec![" M x\ty\n\"z\"".into()],
        };
        assert_eq!(
            fingerprint(&source, Kind::Uncommitted),
            digest(
                r#"{"base":{"mode":"100644","oid":"a"},"index":[{"mode":"100644","oid":"b","stage":0}],"working":{"mode":"100644","digest":"c"},"statusRecords":[" M x\ty\n\"z\""]}"#
            )
        );
        assert_eq!(
            fingerprint(&source, Kind::Staged),
            digest(
                r#"{"base":{"mode":"100644","oid":"a"},"index":[{"mode":"100644","oid":"b","stage":0}]}"#
            )
        );
        assert_eq!(
            content_fingerprint(&source, Kind::Unstaged),
            digest(
                r#"{"index":{"mode":"100644","oid":"b","stage":0},"working":{"mode":"100644","digest":"c"}}"#
            )
        );
        assert_eq!(
            content_fingerprint(&source, Kind::Uncommitted),
            digest(
                r#"{"base":{"mode":"100644","oid":"a"},"working":{"mode":"100644","digest":"c"}}"#
            )
        );
    }

    #[test]
    fn status_merges_repeated_paths_and_keeps_rename_sources() {
        let files = parse_status("R  new\0old\0?? old\0UU both\0 M plain\0AD x\0?? x\0").unwrap();
        let summary: Vec<_> = files
            .iter()
            .map(|file| {
                (
                    file.path.as_str(),
                    file.status,
                    file.previous_path.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("new", "renamed", Some("old")),
                ("old", "untracked", None),
                ("both", "conflicted", None),
                ("plain", "modified", None),
                ("x", "modified", None),
            ]
        );
        assert_eq!(files[4].records, ["AD x", "?? x"]);
        assert_eq!(scoped_status(&files[4], Kind::Staged), "added");
        assert_eq!(scoped_status(&files[4], Kind::Unstaged), "deleted");
        assert!(parse_status("x\0").is_err());
    }

    #[test]
    fn numstat_and_line_counts() {
        assert_eq!(count_text_lines(Some(b"a\nb")).unwrap().added, 2);
        assert_eq!(count_text_lines(Some(b"a\n")).unwrap().added, 1);
        assert!(count_text_lines(Some(b"a\0")).is_none());
        assert_eq!(js_number(1_727_000_000_123.0), "1727000000123");
        assert_eq!(js_number(1_727_000_000_123.456_7), "1727000000123.4568");
    }
}
