//! A folder's file list (for mentions, the palette and the file tree), one file's preview,
//! and the simple changed-files view: `git status`, a file's diff, and staging one file.
//! Same Git arguments, limits, ordering and results as the TypeScript code it replaces.

use super::{GitCommand, GitOutput};
use crate::error::{CoreError, CoreResult};
use crate::paths;
use crate::{locale, parse, Core};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

const CACHE_TTL: Duration = Duration::from_secs(30);
const CACHE_MAX_ENTRIES: usize = 20;
const MAX_PREVIEW_BYTES: u64 = 200 * 1024;
const DEFAULT_MAX_FILES: usize = 20_000;
const ALWAYS_IGNORED_NAMES: [&str; 3] = [".git", "node_modules", ".DS_Store"];
const GIT_LIST_MAX_BUFFER: usize = 64 * 1024 * 1024;
const GIT_LIST_TIMEOUT: Duration = Duration::from_secs(15);
const STATUS_MAX_BUFFER: usize = 2 * 1024 * 1024;
const DIFF_MAX_BUFFER: usize = 5 * 1024 * 1024;

/// One folder's listing, shared between the cache and the call that made it.
type FileList = Rc<Vec<String>>;

/// Recent listings by folder path, oldest first. A re-listed folder keeps its place, as in
/// the JavaScript `Map` it replaces.
#[derive(Default)]
pub struct FileListCache {
    entries: RefCell<Vec<(String, Instant, FileList)>>,
}

impl FileListCache {
    fn get(&self, workspace_path: &str) -> Option<Rc<Vec<String>>> {
        self.entries
            .borrow()
            .iter()
            .find(|(path, at, _)| path == workspace_path && at.elapsed() < CACHE_TTL)
            .map(|(_, _, files)| files.clone())
    }

    fn remember(&self, workspace_path: &str, files: Rc<Vec<String>>) {
        let mut entries = self.entries.borrow_mut();
        if let Some(entry) = entries
            .iter_mut()
            .find(|(path, _, _)| path == workspace_path)
        {
            *entry = (workspace_path.to_owned(), Instant::now(), files);
            return;
        }
        if entries.len() >= CACHE_MAX_ENTRIES {
            entries.remove(0);
        }
        entries.push((workspace_path.to_owned(), Instant::now(), files));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    workspace_path: String,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    max_files: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceParams {
    workspace_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileParams {
    workspace_path: String,
    file_path: String,
    #[serde(default)]
    source_path: Option<String>,
}

pub async fn call(core: Rc<Core>, method: String, params: Value) -> CoreResult<Value> {
    match method.as_str() {
        crate::methods::WORKSPACE_FILES_LIST => {
            let params: ListParams = parse(params)?;
            let cache = &core.parts()?.file_lists;
            if !params.force {
                if let Some(files) = cache.get(&params.workspace_path) {
                    return Ok(json!(*files));
                }
            }
            let max_files = params.max_files.unwrap_or(DEFAULT_MAX_FILES);
            let files = match list_git_checkout_files(&params.workspace_path, max_files).await {
                Some(files) => files,
                None => walk_workspace_files(Path::new(&params.workspace_path), max_files).await,
            };
            let files = Rc::new(files);
            cache.remember(&params.workspace_path, files.clone());
            Ok(json!(*files))
        }
        crate::methods::WORKSPACE_FILES_READ => {
            let params: FileParams = parse(params)?;
            read_workspace_file(&params.workspace_path, &params.file_path).await
        }
        crate::methods::WORKSPACE_FILES_CHANGED => {
            let params: WorkspaceParams = parse(params)?;
            Ok(changed_files(&params.workspace_path).await)
        }
        crate::methods::WORKSPACE_FILES_DIFF => {
            let params: FileParams = parse(params)?;
            file_diff(&params.workspace_path, &params.file_path)
                .await
                .map(Value::String)
        }
        crate::methods::WORKSPACE_FILES_STAGE => {
            let params: FileParams = parse(params)?;
            stage_file(
                &params.workspace_path,
                &params.file_path,
                params.source_path.as_deref(),
            )
            .await?;
            Ok(Value::Null)
        }
        _ => Err(CoreError::new(format!("Unknown RPC method: {method}"))),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFilePreview<'a> {
    path: &'a str,
    content: String,
    truncated: bool,
    binary: bool,
    size_bytes: u64,
}

async fn read_workspace_file(workspace_path: &str, file_path: &str) -> CoreResult<Value> {
    let resolved = paths::resolve_existing_workspace_path(workspace_path, file_path).await?;
    let io_error = |error: std::io::Error| CoreError::io(&error, &resolved);
    let mut file = tokio::fs::File::open(&resolved).await.map_err(io_error)?;
    let metadata = file.metadata().await.map_err(io_error)?;
    let size = metadata.len();
    if !metadata.is_file() {
        return Ok(json!(WorkspaceFilePreview {
            path: file_path,
            content: String::new(),
            truncated: false,
            binary: true,
            size_bytes: size,
        }));
    }
    let read_length = size.min(MAX_PREVIEW_BYTES + 1);
    let mut buffer = Vec::with_capacity(read_length as usize);
    (&mut file)
        .take(read_length)
        .read_to_end(&mut buffer)
        .await
        .map_err(io_error)?;
    let bytes_read = buffer.len() as u64;
    buffer.truncate(MAX_PREVIEW_BYTES as usize);
    let binary = buffer.contains(&0);
    Ok(json!(WorkspaceFilePreview {
        path: file_path,
        // `TextDecoder` drops a leading byte order mark and replaces invalid bytes.
        content: if binary {
            String::new()
        } else {
            let text = buffer.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buffer);
            String::from_utf8_lossy(text).into_owned()
        },
        truncated: bytes_read > MAX_PREVIEW_BYTES || size > MAX_PREVIEW_BYTES,
        binary,
        size_bytes: size,
    }))
}

/// Git's own view of the checkout: tracked files still on disk plus untracked files no ignore
/// source excludes (nested .gitignore, .git/info/exclude, core.excludesFile). Git does not
/// descend into nested repositories or linked worktrees, and submodules stay a single gitlink,
/// which is left out. `None` when the folder is not usable as a Git checkout.
async fn list_git_checkout_files(workspace_path: &str, max_files: usize) -> Option<Vec<String>> {
    let cwd = Path::new(workspace_path);
    let listing = |args: &'static [&'static str]| async move {
        GitCommand::new(args.iter().copied())
            .cwd(cwd)
            .isolated()
            .max_buffer(GIT_LIST_MAX_BUFFER)
            .timeout(GIT_LIST_TIMEOUT)
            .text()
            .await
    };
    let (ignored_folder, staged, deleted, others) = tokio::join!(
        // A folder its enclosing repository ignores (inside a dotfiles repo, say) is not part
        // of that checkout; it is listed from disk instead.
        listing(&["check-ignore", "-q", "."]),
        listing(&["ls-files", "-z", "--stage"]),
        listing(&["ls-files", "-z", "--deleted"]),
        listing(&["ls-files", "-z", "--others", "--exclude-standard"]),
    );
    if ignored_folder.is_ok() {
        return None;
    }
    let (staged, deleted, others) = (staged.ok()?, deleted.ok()?, others.ok()?);
    let missing: HashSet<&str> = nul_records(&deleted).collect();
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for entry in nul_records(&staged) {
        // "<mode> <object> <stage>\t<path>"; mode 160000 is a submodule gitlink, not a file.
        let Some(tab) = entry.find('\t') else {
            continue;
        };
        let file_path = &entry[tab + 1..];
        if entry.starts_with("160000 ") || missing.contains(file_path) {
            continue;
        }
        if seen.insert(file_path) {
            files.push(file_path);
        }
    }
    // A trailing slash marks a nested repository or worktree, which is another checkout.
    for file_path in nul_records(&others) {
        if !file_path.ends_with('/') && seen.insert(file_path) {
            files.push(file_path);
        }
    }
    let mut files: Vec<String> = files
        .into_iter()
        .filter(|path| {
            !path
                .split('/')
                .any(|name| ALWAYS_IGNORED_NAMES.contains(&name))
        })
        .map(str::to_owned)
        .collect();
    files.sort_by(|left, right| locale::compare(left, right));
    files.truncate(max_files);
    Some(files)
}

fn nul_records(output: &str) -> impl Iterator<Item = &str> {
    output.split('\0').filter(|record| !record.is_empty())
}

/// For a folder that is not a Git checkout: walk it, honoring its root `.gitignore` and
/// always skipping `.git`, `node_modules` and `.DS_Store`.
async fn walk_workspace_files(workspace_path: &Path, max_files: usize) -> Vec<String> {
    let mut builder = ignore::gitignore::GitignoreBuilder::new(workspace_path);
    for name in ALWAYS_IGNORED_NAMES {
        let _ = builder.add_line(None, name);
    }
    match tokio::fs::read_to_string(workspace_path.join(".gitignore")).await {
        Ok(text) => {
            for line in text.lines() {
                let _ = builder.add_line(None, line);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!(
            "[main] Failed to read workspace .gitignore {} {error}",
            workspace_path.display()
        ),
    }
    let rules = builder
        .build()
        .unwrap_or_else(|_| ignore::gitignore::Gitignore::empty());
    let mut files = Vec::new();
    // Each folder's entries in name order, descending into a folder as it comes up, so the
    // file limit cuts the walk where the recursive TypeScript walk stopped.
    let mut stack = Vec::new();
    if let Some(names) = sorted_entries(workspace_path, true).await {
        stack.push((
            workspace_path.to_path_buf(),
            String::new(),
            names.into_iter(),
        ));
    }
    while let Some((directory, relative_dir, names)) = stack.last_mut() {
        if files.len() >= max_files {
            break;
        }
        let Some((name, is_dir)) = names.next() else {
            stack.pop();
            continue;
        };
        if ALWAYS_IGNORED_NAMES.contains(&name.as_str()) {
            continue;
        }
        let relative_path = if relative_dir.is_empty() {
            name.clone()
        } else {
            format!("{relative_dir}/{name}")
        };
        if rules.matched(&relative_path, is_dir).is_ignore() {
            continue;
        }
        if !is_dir {
            files.push(relative_path);
            continue;
        }
        let child = directory.join(&name);
        if let Some(names) = sorted_entries(&child, false).await {
            stack.push((child, relative_path, names.into_iter()));
        }
    }
    files.sort_by(|left, right| locale::compare(left, right));
    files
}

/// A folder's entries as `(name, is_directory)` in name order; `None` when it cannot be read.
async fn sorted_entries(directory: &Path, is_root: bool) -> Option<Vec<(String, bool)>> {
    let mut entries = match tokio::fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) => {
            if is_root && error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[main] listWorkspaceFiles failed {} {error}",
                    directory.display()
                );
            }
            return None;
        }
    };
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        // A symbolic link is listed as a file, never followed, as `Dirent.isDirectory()` did.
        let is_dir = entry.file_type().await.is_ok_and(|kind| kind.is_dir());
        names.push((entry.file_name().to_string_lossy().into_owned(), is_dir));
    }
    names.sort_by(|left, right| locale::compare(&left.0, &right.0));
    Some(names)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFileEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staging_source_path: Option<String>,
    status: &'static str,
    staged: bool,
}

/// Runs Git as `executeGitCommand` did: in the folder, with the isolated environment, and
/// with Node's 1 MiB default output limit unless a command needs more.
async fn execute_git(
    workspace_path: &str,
    args: &[&str],
    max_buffer: usize,
) -> CoreResult<GitOutput> {
    GitCommand::new(args.iter().copied())
        .cwd(Path::new(workspace_path))
        .isolated()
        .max_buffer(max_buffer)
        .output()
        .await
}

async fn changed_files(workspace_path: &str) -> Value {
    let unavailable = |code: &str, message: &str| json!({ "state": "unavailable", "error": { "code": code, "message": message } });
    let output = match execute_git(
        workspace_path,
        &["status", "--porcelain=v1", "-z"],
        STATUS_MAX_BUFFER,
    )
    .await
    {
        Ok(output) if output.succeeded() => output,
        _ => {
            return unavailable(
                "git-status-failed",
                "Git status is unavailable for this workspace.",
            )
        }
    };
    match parse_status_porcelain_v1_z(&output.stdout_text()) {
        Some(files) => json!({ "state": "available", "files": files }),
        None => unavailable(
            "git-status-invalid",
            "Git returned an unreadable changed-file status.",
        ),
    }
}

/// `parseGitStatusPorcelainV1Z`, indexing the text by UTF-16 unit as the JavaScript did.
fn parse_status_porcelain_v1_z(output: &str) -> Option<Vec<ChangedFileEntry>> {
    if output.is_empty() {
        return Some(Vec::new());
    }
    let fields: Vec<&str> = output.strip_suffix('\0')?.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let record: Vec<u16> = fields[index].encode_utf16().collect();
        if record.len() < 4 || record[2] != u16::from(b' ') {
            return None;
        }
        let xy = String::from_utf16_lossy(&record[..2]);
        let file_path = String::from_utf16_lossy(&record[3..]);
        let previous_path = if xy.contains('R') || xy.contains('C') {
            index += 1;
            Some(
                fields
                    .get(index)
                    .filter(|path| !path.is_empty())?
                    .to_string(),
            )
        } else {
            None
        };
        let (x, y) = {
            let mut columns = xy.chars();
            (columns.next().unwrap_or(' '), columns.next().unwrap_or(' '))
        };
        entries.push(ChangedFileEntry {
            path: file_path,
            staging_source_path: previous_path.clone().filter(|_| y == 'R'),
            previous_path,
            status: if x == '?' && y == '?' {
                "untracked"
            } else if x == 'R' || y == 'R' {
                "renamed"
            } else if x == 'C' || y == 'C' {
                "copied"
            } else if x == 'A' || y == 'A' {
                "added"
            } else if x == 'D' || y == 'D' {
                "deleted"
            } else {
                "modified"
            },
            staged: x != '?' && x != ' ' && y == ' ',
        });
        index += 1;
    }
    Some(entries)
}

async fn file_diff(workspace_path: &str, file_path: &str) -> CoreResult<String> {
    paths::resolve_workspace_path(workspace_path, file_path)?;
    for args in [
        &["--literal-pathspecs", "diff", "--", file_path][..],
        &["--literal-pathspecs", "diff", "--cached", "--", file_path],
    ] {
        if let Ok(output) = execute_git(workspace_path, args, DIFF_MAX_BUFFER).await {
            let text = output.stdout_text();
            if output.succeeded() && !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    // `git diff --no-index` exits 1 when the files differ, which is expected.
    let untracked = execute_git(
        workspace_path,
        &[
            "--literal-pathspecs",
            "diff",
            "--no-index",
            "--",
            "/dev/null",
            file_path,
        ],
        DIFF_MAX_BUFFER,
    )
    .await;
    Ok(untracked
        .map(|output| output.stdout_text())
        .unwrap_or_default())
}

async fn stage_file(
    workspace_path: &str,
    file_path: &str,
    source_path: Option<&str>,
) -> CoreResult<()> {
    paths::resolve_workspace_path(workspace_path, file_path)?;
    let mut args = vec!["--literal-pathspecs", "add", "--", file_path];
    if let Some(source_path) = source_path {
        paths::resolve_workspace_path(workspace_path, source_path)?;
        args.push(source_path);
    }
    let output = execute_git(workspace_path, &args, super::DEFAULT_MAX_BUFFER).await?;
    if output.succeeded() {
        Ok(())
    } else {
        Err(output.error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_records_and_rejects_bad_ones() {
        let parsed =
            parse_status_porcelain_v1_z(" M a b\0R  new\0old\0 R moved\0src\0?? u\0").unwrap();
        let json = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            json,
            json!([
                { "path": "a b", "status": "modified", "staged": false },
                { "path": "new", "previousPath": "old", "status": "renamed", "staged": true },
                { "path": "moved", "previousPath": "src", "stagingSourcePath": "src",
                  "status": "renamed", "staged": false },
                { "path": "u", "status": "untracked", "staged": false },
            ])
        );
        assert!(parse_status_porcelain_v1_z("?? not terminated").is_none());
        assert!(parse_status_porcelain_v1_z("R  only\0").is_none());
        assert!(parse_status_porcelain_v1_z("xx\0").is_none());
    }
}
