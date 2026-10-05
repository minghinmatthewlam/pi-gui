//! One capture: every tracked and non-ignored untracked file of a checkout, read without
//! touching the checkout's own Git state and stored as a tree in the app's bare repository.
//! The checks, error codes and Git commands are those of `captureCheckout` in the TypeScript
//! store this replaces.

use super::git::{git, strip_line, GitError};
use super::metadata::{is_object_id, Capture, Coverage};
use super::store::TurnCheckpoints;
use super::sync::AbortSignal;
use indexmap::IndexSet;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Files modified this recently may still change within one timestamp tick; reread them.
const RACY_WINDOW_MS: f64 = 2_000.0;
/// Checkouts whose last capture inventory is kept in memory for incremental captures.
const MAX_CACHED_CHECKOUTS: usize = 16;
pub const SNAPSHOT_REF_PREFIX: &str = "refs/pi-gui/snapshots/";
const NESTED_REPOSITORY_NOTE: &str =
    "Nested Git repositories inside this checkout are not included in turn captures.";

/// What identifies one version of a file, like the fields of Node's `Stats` the TypeScript
/// store compared.
#[derive(Debug, Clone, PartialEq)]
pub struct FileVersion {
    dev: u64,
    ino: u64,
    mode: u32,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

impl FileVersion {
    #[cfg(unix)]
    fn of(metadata: &Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            mode: metadata.mode(),
            size: metadata.size(),
            mtime: (metadata.mtime(), metadata.mtime_nsec()),
            ctime: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }

    /// Windows has no stable inode or change time in Rust's standard library; the size,
    /// type and write time still reveal ordinary edits.
    #[cfg(not(unix))]
    fn of(metadata: &Metadata) -> Self {
        let kind = if metadata.is_symlink() {
            0o120000
        } else if metadata.is_dir() {
            0o040000
        } else {
            0o100000
        };
        let write = if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|since| (since.as_secs() as i64, since.subsec_nanos() as i64))
            .unwrap_or_default();
        Self {
            dev: 0,
            ino: 0,
            mode: kind | write,
            size: metadata.len(),
            mtime: modified,
            ctime: modified,
        }
    }

    fn millis(time: (i64, i64)) -> f64 {
        time.0 as f64 * 1000.0 + time.1 as f64 / 1_000_000.0
    }

    fn same_identity(&self, other: &FileVersion) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
}

/// A file whose bytes are already stored as `oid`, valid while its version is unchanged.
#[derive(Debug, Clone)]
pub struct CachedFile {
    version: FileVersion,
    git_mode: &'static str,
    oid: String,
}

pub struct Inventory {
    tree_oid: String,
    /// Entries in `tree_oid`; recently changed files are in the tree but not in `files`.
    entry_count: u64,
    files: HashMap<String, CachedFile>,
}

pub enum Failure {
    Coded(&'static str, String),
    Other(String),
}

fn coded(code: &'static str, message: &str) -> Failure {
    Failure::Coded(code, message.into())
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Failure::Other(error.to_string())
    }
}

impl From<GitError> for Failure {
    fn from(error: GitError) -> Self {
        Failure::Other(error.0)
    }
}

impl From<crate::error::CoreError> for Failure {
    fn from(error: crate::error::CoreError) -> Self {
        Failure::Other(error.message)
    }
}

/// What a failed or stopped capture had counted, for its report.
#[derive(Default)]
struct Progress {
    spool: RefCell<Option<PathBuf>>,
    file_count: Cell<u64>,
    byte_count: Cell<u64>,
}

enum Snapshot {
    Stored(CachedFile),
    Read {
        mode: &'static str,
        bytes: Vec<u8>,
        version: FileVersion,
    },
}

struct Spooled {
    path: String,
    mode: &'static str,
    name: String,
    version: FileVersion,
}

enum DirState {
    Missing,
    Directory(FileVersion),
}

/// Shared by the workers of one capture.
struct Walk<'a> {
    store: &'a TurnCheckpoints,
    progress: &'a Progress,
    root: &'a Path,
    root_version: FileVersion,
    previous: Option<Rc<Inventory>>,
    directories: RefCell<HashMap<PathBuf, Rc<DirState>>>,
}

impl TurnCheckpoints {
    /// Captures `workspace_path` within `timeout`. Never fails: a capture that cannot be
    /// trusted completely is reported as unavailable with a reason.
    pub(super) async fn capture_checkout(
        &self,
        workspace_path: &str,
        parent: &AbortSignal,
        timeout: Duration,
    ) -> Capture {
        let started = Instant::now();
        let progress = Progress::default();
        let snapshot_id = crate::random_id();
        let index_path = self
            .directory
            .join("indexes")
            .join(format!("{snapshot_id}.index"));
        let work = self.capture_work(workspace_path, &index_path, &snapshot_id, &progress);
        let outcome = tokio::select! {
            biased;
            result = work => Some(result),
            _ = tokio::time::sleep(timeout) => None,
            _ = parent.aborted() => None,
        };
        let stopped = parent.is_aborted() || started.elapsed() >= timeout;
        let duration_ms = started.elapsed().as_millis() as u64;
        let result = match outcome {
            Some(Ok(capture)) => match capture {
                Capture::Available {
                    tree_oid,
                    captured_at,
                    coverage,
                    file_count,
                    byte_count,
                    ..
                } => Capture::Available {
                    tree_oid,
                    captured_at,
                    coverage,
                    file_count,
                    byte_count,
                    duration_ms,
                },
                unavailable => unavailable,
            },
            failed => {
                let reason = match failed {
                    _ if stopped || failed.is_none() => Capture::unavailable(
                        "capture-aborted",
                        "The capture was interrupted or exceeded its time limit.",
                    ),
                    Some(Err(Failure::Coded(code, message))) => {
                        Capture::unavailable(code, &message)
                    }
                    other => {
                        if let Some(Err(Failure::Other(reason))) = other {
                            eprintln!("[turn-checkpoints] capture failed: {reason}");
                        }
                        Capture::unavailable(
                        "capture-failed",
                        "The checkout could not be captured completely; no partial diff will be shown.",
                    )
                    }
                };
                with_counts(reason, &progress, duration_ms)
            }
        };
        let spool = progress.spool.borrow_mut().take();
        if let Some(spool) = spool {
            let _ = tokio::fs::remove_dir_all(spool).await;
        }
        // These are this capture's newly created scratch indexes, not user or checkpoint data.
        let lock_path = {
            let mut name = index_path.clone().into_os_string();
            name.push(".lock");
            PathBuf::from(name)
        };
        for path in [&index_path, &lock_path] {
            if let Err(error) = tokio::fs::remove_file(path).await {
                if error.kind() != io::ErrorKind::NotFound {
                    eprintln!(
                        "[turn-checkpoints] could not remove {}: {error}",
                        path.display()
                    );
                }
            }
        }
        result
    }

    async fn capture_work(
        &self,
        workspace_path: &str,
        index_path: &Path,
        snapshot_id: &str,
        progress: &Progress,
    ) -> Result<Capture, Failure> {
        let started_ms = now_ms();
        let generation = self.inventory_generation.get();
        self.prepare_git().await?;
        tokio::fs::create_dir_all(index_path.parent().expect("indexes folder")).await?;
        let root = canonical(Path::new(workspace_path)).await?;
        let root_stat = tokio::fs::symlink_metadata(&root).await?;
        if !root_stat.is_dir() || root_stat.is_symlink() {
            return Err(coded(
                "checkout-changing",
                "The checkout root changed during capture.",
            ));
        }
        let top = strip_line(&git(&root, &["rev-parse", "--show-toplevel"], None, &[]).await?);
        if canonical(Path::new(&top)).await? != root {
            return Err(coded(
                "checkout-root-required",
                "Turn captures require the Git checkout root.",
            ));
        }
        let (tracked, others) = tokio::try_join!(
            git(&root, &["ls-files", "--stage", "-v", "-z"], None, &[]),
            git(
                &root,
                &["ls-files", "--others", "--exclude-standard", "-z"],
                None,
                &[]
            ),
        )?;
        let mut paths = IndexSet::new();
        for entry in nul_records(&tracked)? {
            let (tag, mode, stage, path) = parse_stage_entry(&entry).ok_or_else(|| {
                coded(
                    "inventory-invalid",
                    "Git returned an unreadable tracked-file inventory.",
                )
            })?;
            if tag.eq_ignore_ascii_case(&'S') {
                return Err(coded(
                    "sparse-checkout",
                    "Sparse checkout paths are not yet supported by turn captures.",
                ));
            }
            if mode == "160000" {
                return Err(coded(
                    "submodule",
                    "Submodule contents are excluded; this turn capture is unavailable.",
                ));
            }
            if stage != '0' {
                return Err(coded(
                    "conflicted-checkout",
                    "Resolve Git index conflicts before capturing a complete turn.",
                ));
            }
            paths.insert(path.to_owned());
        }
        // Git lists an untracked nested repository (or linked worktree) as one "dir/" entry.
        // Its files belong to that repository, so the capture skips it and says so.
        let mut skipped_nested_repository = false;
        for path in nul_records(&others)? {
            if path.ends_with('/') {
                skipped_nested_repository = true;
            } else {
                paths.insert(path);
            }
        }
        let limits = &self.limits;
        if paths.len() as u64 > limits.max_files {
            return Err(Failure::Coded(
                "file-limit",
                format!(
                    "The checkout exceeds the {}-file capture limit.",
                    limits.max_files
                ),
            ));
        }
        let entries: Vec<String> = paths.into_iter().collect();
        let root_key = root.clone();
        // Only files whose version changed since this checkout's last capture are read again.
        let previous = self.inventories.borrow().get(&root_key).cloned();
        let capture_dir = make_temp_dir(&self.directory, "capture-").await?;
        *progress.spool.borrow_mut() = Some(capture_dir.clone());
        let walk = Walk {
            store: self,
            progress,
            root: &root,
            root_version: FileVersion::of(&root_stat),
            previous: previous.clone(),
            directories: RefCell::new(HashMap::new()),
        };
        let cursor = Cell::new(0usize);
        let stored: RefCell<Vec<(String, CachedFile)>> = RefCell::new(Vec::new());
        let spooled: RefCell<Vec<Spooled>> = RefCell::new(Vec::new());
        let (walk, cursor, stored_ref, spooled_ref, entries_ref, capture_dir_ref) =
            (&walk, &cursor, &stored, &spooled, &entries, &capture_dir);
        let worker = move || async move {
            while cursor.get() < entries_ref.len() {
                let ordinal = cursor.get();
                cursor.set(ordinal + 1);
                let path = &entries_ref[ordinal];
                // A tracked deletion is represented by absence from the new tree.
                let Some(file) = walk.inspect(path).await? else {
                    continue;
                };
                walk.progress
                    .file_count
                    .set(walk.progress.file_count.get() + 1);
                match file {
                    Snapshot::Stored(file) => stored_ref.borrow_mut().push((path.clone(), file)),
                    Snapshot::Read {
                        mode,
                        bytes,
                        version,
                    } => {
                        let name = format!("blob-{ordinal}");
                        write_private(&capture_dir_ref.join(&name), &bytes).await?;
                        spooled_ref.borrow_mut().push(Spooled {
                            path: path.clone(),
                            mode,
                            name,
                            version,
                        });
                    }
                }
            }
            Ok::<(), Failure>(())
        };
        tokio::try_join!(
            worker(),
            worker(),
            worker(),
            worker(),
            worker(),
            worker(),
            worker(),
            worker()
        )?;
        let stored = stored.into_inner();
        let spooled = spooled.into_inner();
        let mut object_ids: Vec<String> = Vec::new();
        if !spooled.is_empty() {
            // Git only opens freshly created private files with synthetic relative names.
            // Original paths (including tabs/newlines) never enter this line-based input or
            // get reopened by Git.
            let input: String = spooled
                .iter()
                .map(|entry| format!("{}\n", entry.name))
                .collect();
            let args: [&OsStr; 6] = [
                OsStr::new("--git-dir"),
                self.repository_path.as_os_str(),
                OsStr::new("hash-object"),
                OsStr::new("--stdin-paths"),
                OsStr::new("--no-filters"),
                OsStr::new("-w"),
            ];
            let output = git(&capture_dir, &args, Some(input.as_bytes()), &[]).await?;
            if !output.is_empty() {
                object_ids = strip_line(&output)
                    .split('\n')
                    .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
                    .collect();
            }
        }
        if object_ids.len() != spooled.len() || !object_ids.iter().all(|oid| is_object_id(oid)) {
            return Err(coded(
                "object-invalid",
                "Git returned an invalid snapshot object inventory.",
            ));
        }
        tokio::fs::remove_dir_all(&capture_dir).await?;
        progress.spool.borrow_mut().take();
        let file_count = progress.file_count.get();
        let mut files: HashMap<String, CachedFile> = stored.iter().cloned().collect();
        for (entry, oid) in spooled.iter().zip(&object_ids) {
            // A file written within one timestamp tick of this read could change again
            // without a visible version change, so it is not trusted for reuse until it has aged.
            let changed = FileVersion::millis(entry.version.mtime)
                .max(FileVersion::millis(entry.version.ctime));
            if changed < started_ms - RACY_WINDOW_MS {
                files.insert(
                    entry.path.clone(),
                    CachedFile {
                        version: entry.version.clone(),
                        git_mode: entry.mode,
                        oid: oid.clone(),
                    },
                );
            }
        }
        let tree_oid = match &previous {
            // Every previously stored file is unchanged and nothing else exists: the same
            // tree. Its ref cannot have been pruned, because maintenance clears inventories.
            Some(previous) if spooled.is_empty() && stored.len() as u64 == previous.entry_count => {
                previous.tree_oid.clone()
            }
            _ => {
                let mut index_info = Vec::new();
                for (path, file) in &stored {
                    index_info.extend_from_slice(
                        format!("{} {}\t{}\0", file.git_mode, file.oid, path).as_bytes(),
                    );
                }
                for (entry, oid) in spooled.iter().zip(&object_ids) {
                    index_info.extend_from_slice(
                        format!("{} {}\t{}\0", entry.mode, oid, entry.path).as_bytes(),
                    );
                }
                let env = [("GIT_INDEX_FILE", index_path.as_os_str())];
                let repository = &self.repository_path;
                git(repository, &["read-tree", "--empty"], None, &env).await?;
                git(
                    repository,
                    &["update-index", "-z", "--index-info"],
                    Some(&index_info),
                    &env,
                )
                .await?;
                let tree_oid = strip_line(&git(repository, &["write-tree"], None, &env).await?);
                if !is_object_id(&tree_oid) {
                    return Err(coded(
                        "tree-invalid",
                        "Git returned an invalid snapshot tree.",
                    ));
                }
                // The creation time in the name lets maintenance spare refs of in-flight captures.
                let name = format!("{SNAPSHOT_REF_PREFIX}{}-{snapshot_id}", now_ms() as u64);
                git(
                    repository,
                    &["update-ref", name.as_str(), tree_oid.as_str()],
                    None,
                    &[],
                )
                .await?;
                tree_oid
            }
        };
        if generation == self.inventory_generation.get() {
            let mut inventories = self.inventories.borrow_mut();
            inventories.shift_remove(&root_key);
            inventories.insert(
                root_key,
                Rc::new(Inventory {
                    tree_oid: tree_oid.clone(),
                    entry_count: file_count,
                    files,
                }),
            );
            while inventories.len() > MAX_CACHED_CHECKOUTS {
                inventories.shift_remove_index(0);
            }
        }
        Ok(Capture::Available {
            tree_oid,
            captured_at: super::iso_now(),
            coverage: if skipped_nested_repository {
                Coverage::partial(vec![NESTED_REPOSITORY_NOTE.into()])
            } else {
                Coverage::complete()
            },
            file_count,
            byte_count: progress.byte_count.get(),
            duration_ms: 0,
        })
    }
}

impl Walk<'_> {
    fn reserve(&self, size: u64) -> Result<(), Failure> {
        let limits = &self.store.limits;
        let total = self.progress.byte_count.get();
        if size > limits.max_file_bytes || total + size > limits.max_bytes {
            return Err(coded(
                "byte-limit",
                "The checkout exceeds the bounded turn-capture size limit.",
            ));
        }
        self.progress.byte_count.set(total + size);
        Ok(())
    }

    /// Each ancestor directory is checked once per capture; a missing one means a deletion.
    async fn directory(&self, path: &Path) -> Result<Rc<DirState>, Failure> {
        if let Some(state) = self.directories.borrow().get(path) {
            return Ok(state.clone());
        }
        let state = match tokio::fs::symlink_metadata(path).await {
            Ok(stat) if !stat.is_dir() || stat.is_symlink() => {
                return Err(coded(
                    "unsafe-symlink",
                    "A tracked path now passes through a symlink or non-directory.",
                ))
            }
            Ok(stat) => DirState::Directory(FileVersion::of(&stat)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => DirState::Missing,
            Err(error) => return Err(error.into()),
        };
        let state = Rc::new(state);
        self.directories
            .borrow_mut()
            .insert(path.to_owned(), state.clone());
        Ok(state)
    }

    async fn inspect(&self, path: &str) -> Result<Option<Snapshot>, Failure> {
        let parts: Vec<&str> = path.split('/').collect();
        if path.starts_with('/')
            || (cfg!(windows) && path.contains('\\'))
            || path.contains('\0')
            || parts.iter().any(|part| {
                part.is_empty()
                    || *part == "."
                    || *part == ".."
                    || part.eq_ignore_ascii_case(".git")
            })
        {
            return Err(coded(
                "unsafe-path",
                "The checkout contains an unsafe capture path.",
            ));
        }
        let mut ancestors = vec![(self.root.to_path_buf(), self.root_version.clone())];
        let mut parent = self.root.to_path_buf();
        for component in &parts[..parts.len() - 1] {
            parent = parent.join(component);
            match &*self.directory(&parent).await? {
                DirState::Missing => return Ok(None),
                DirState::Directory(version) => ancestors.push((parent.clone(), version.clone())),
            }
        }
        let absolute = parent.join(parts[parts.len() - 1]);
        let before = match tokio::fs::symlink_metadata(&absolute).await {
            Ok(stat) => stat,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let version = FileVersion::of(&before);
        if let Some(stored) = self
            .previous
            .as_ref()
            .and_then(|previous| previous.files.get(path))
        {
            if stored.version == version {
                self.reserve(version.size)?;
                return Ok(Some(Snapshot::Stored(stored.clone())));
            }
        }
        let ancestors = &ancestors;
        let verify_ancestors = move || async move {
            for (path, version) in ancestors {
                let current = tokio::fs::symlink_metadata(path).await?;
                if !current.is_dir() || !version.same_identity(&FileVersion::of(&current)) {
                    return Err(coded(
                        "checkout-changing",
                        "A parent directory changed during capture.",
                    ));
                }
            }
            Ok::<(), Failure>(())
        };
        if before.is_symlink() {
            let bytes = link_bytes(&tokio::fs::read_link(&absolute).await?);
            self.reserve(bytes.len() as u64)?;
            verify_ancestors().await?;
            if FileVersion::of(&tokio::fs::symlink_metadata(&absolute).await?) != version {
                return Err(coded(
                    "checkout-changing",
                    "A symlink changed during capture.",
                ));
            }
            return Ok(Some(Snapshot::Read {
                mode: "120000",
                bytes,
                version,
            }));
        }
        if !before.is_file() {
            return Err(coded(
                "unsupported-file",
                "Special files and nested repositories are excluded from turn captures.",
            ));
        }
        self.reserve(version.size)?;
        let mut file = open_no_follow(&absolute).await?;
        // Check the opened inode before reading bytes: ancestor replacement cannot redirect a read.
        if FileVersion::of(&file.metadata().await?) != version {
            return Err(coded(
                "checkout-changing",
                "A file changed before it could be captured.",
            ));
        }
        verify_ancestors().await?;
        let mut bytes = vec![0u8; version.size as usize];
        let mut offset = 0;
        while offset < bytes.len() {
            let end = bytes.len().min(offset + 64 * 1024);
            let read = file.read(&mut bytes[offset..end]).await?;
            if read == 0 {
                return Err(coded(
                    "checkout-changing",
                    "A file was truncated during capture.",
                ));
            }
            offset += read;
        }
        if FileVersion::of(&file.metadata().await?) != version
            || FileVersion::of(&tokio::fs::symlink_metadata(&absolute).await?) != version
        {
            return Err(coded("checkout-changing", "A file changed during capture."));
        }
        verify_ancestors().await?;
        Ok(Some(Snapshot::Read {
            mode: if version.mode & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            },
            bytes,
            version,
        }))
    }
}

fn with_counts(capture: Capture, progress: &Progress, duration: u64) -> Capture {
    match capture {
        Capture::Unavailable {
            code,
            message,
            captured_at,
            coverage,
            ..
        } => Capture::Unavailable {
            code,
            message,
            captured_at,
            coverage,
            file_count: progress.file_count.get(),
            byte_count: progress.byte_count.get(),
            duration_ms: duration,
        },
        available => available,
    }
}

/// `<tag> <mode> <oid> <stage>\t<path>` from `git ls-files --stage -v -z`.
fn parse_stage_entry(entry: &str) -> Option<(char, &str, char, &str)> {
    let (head, path) = entry.split_once('\t')?;
    let mut fields = head.split(' ');
    let tag = fields.next()?;
    let mode = fields.next()?;
    let oid = fields.next()?;
    let stage = fields.next()?;
    let mut tag_chars = tag.chars();
    let tag_char = tag_chars.next()?;
    let valid = fields.next().is_none()
        && tag_chars.next().is_none()
        && (tag_char.is_ascii_alphabetic() || tag_char == '?')
        && mode.len() == 6
        && mode.bytes().all(|b| (b'0'..=b'7').contains(&b))
        && (40..=64).contains(&oid.len())
        && oid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && matches!(stage, "0" | "1" | "2" | "3")
        && !path.is_empty();
    valid.then(|| (tag_char, mode, stage.chars().next().unwrap_or('0'), path))
}

/// NUL-terminated records. Paths that are not UTF-8 cannot be named safely in the tree input,
/// so they fail the capture instead of silently disappearing from it.
fn nul_records(output: &[u8]) -> Result<Vec<String>, Failure> {
    let text = std::str::from_utf8(output)
        .ok()
        .filter(|text| text.is_empty() || text.ends_with('\0'));
    let Some(text) = text else {
        return Err(coded(
            "inventory-encoding",
            "Git paths cannot be represented safely by the app.",
        ));
    };
    if text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(text[..text.len() - 1]
        .split('\0')
        .map(str::to_owned)
        .collect())
}

/// `realpath`, without the `\\?\` prefix Windows adds, so stored paths match the old ones.
pub async fn canonical(path: &Path) -> io::Result<PathBuf> {
    let path = tokio::fs::canonicalize(path).await?;
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return Ok(PathBuf::from(rest));
            }
        }
    }
    Ok(path)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs_f64() * 1000.0)
        .unwrap_or_default()
        .floor()
}

/// Like `mkdtemp`: a new private folder named `prefix` plus six random characters.
async fn make_temp_dir(parent: &Path, prefix: &str) -> io::Result<PathBuf> {
    loop {
        let suffix: String = crate::random_id()
            .chars()
            .filter(|c| *c != '-')
            .take(6)
            .collect();
        let path = parent.join(format!("{prefix}{suffix}"));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = tokio::fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        match builder.create(&path).await {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            result => return result.map(|()| path),
        }
    }
}

async fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(bytes).await?;
    file.flush().await
}

async fn open_no_follow(path: &Path) -> io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    options.open(path).await
}

fn link_bytes(target: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        target.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        target.to_string_lossy().into_owned().into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_git_stage_entries_like_the_typescript_pattern() {
        let oid = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
        assert_eq!(
            parse_stage_entry(&format!("H 100644 {oid} 0\ta\tb")),
            Some(('H', "100644", '0', "a\tb"))
        );
        assert_eq!(
            parse_stage_entry(&format!("? 100755 {oid} 2\tx")),
            Some(('?', "100755", '2', "x"))
        );
        for bad in [
            format!("H 100648 {oid} 0\tx"),
            format!("H 100644 {} 0\tx", &oid[..39]),
            format!("H 100644 {oid} 4\tx"),
            format!("H 100644 {oid} 0\t"),
            format!("HH 100644 {oid} 0\tx"),
        ] {
            assert_eq!(parse_stage_entry(&bad), None, "{bad}");
        }
    }

    #[test]
    fn nul_records_need_utf8_and_a_final_nul() {
        assert_eq!(nul_records(b"").ok(), Some(vec![]));
        assert_eq!(
            nul_records(b"a\0b c\0").ok(),
            Some(vec!["a".to_owned(), "b c".to_owned()])
        );
        assert!(nul_records(b"a").is_err());
        assert!(nul_records(b"\xff\0").is_err());
    }
}
