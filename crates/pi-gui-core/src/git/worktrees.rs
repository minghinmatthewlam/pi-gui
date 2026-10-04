//! Worktrees pi-gui creates for threads, and the catalog rows that nest them under a folder.
//! Same Git commands, ownership rules and error messages as the TypeScript
//! `GitWorktreeManager` it replaces; the catalog is the core's own, so no call leaves the
//! process. A user's own checkout is never listed under a folder or removed.

use crate::error::{CoreError, CoreResult};
use crate::paths;
use crate::persistence::catalog::{compare_worktrees, WorktreeEntry, WorktreeKind, WorktreeStatus};
use crate::{parse, Core};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use super::GitCommand;

const MAX_BUFFER: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRef {
    pub workspace_id: String,
    pub path: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceParams {
    workspace: WorkspaceRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshParams {
    workspace: WorkspaceRef,
    #[serde(default)]
    claim_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    workspace: WorkspaceRef,
    path: String,
    #[serde(default)]
    branch_name: Option<String>,
    #[serde(default)]
    start_point: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    workspace: WorkspaceRef,
    worktree_id: String,
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DestroyParams {
    workspace: WorkspaceRef,
    path: String,
    #[serde(default)]
    branch_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PruneParams {
    worktree_root: String,
    referenced_paths: Vec<String>,
}

#[derive(Deserialize)]
struct PathParams {
    path: String,
}

pub async fn call(core: Rc<Core>, method: String, params: Value) -> CoreResult<Value> {
    let manager = Manager { core: &core };
    match method.as_str() {
        crate::methods::WORKTREES_LIST => {
            let params: WorkspaceParams = parse(params)?;
            let worktrees = manager.with_catalog(|catalog| {
                catalog.list_worktrees(Some(&params.workspace.workspace_id))
            })?;
            Ok(json!({ "worktrees": worktrees }))
        }
        crate::methods::WORKTREES_REFRESH => {
            let params: RefreshParams = parse(params)?;
            let worktrees = manager
                .refresh(&params.workspace, params.claim_path.as_deref())
                .await?;
            Ok(json!({ "worktrees": worktrees }))
        }
        crate::methods::WORKTREES_INSPECT => {
            let params: WorkspaceParams = parse(params)?;
            let path = &params.workspace.path;
            let common_dir = run_git(&[
                "-C",
                path,
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ])
            .await?;
            Ok(json!({
                "canonicalPath": canonical(path),
                "commonDir": canonical(common_dir.trim()),
            }))
        }
        crate::methods::WORKTREES_CREATE => {
            let params: CreateParams = parse(params)?;
            Ok(serde_json::to_value(manager.create(params).await?).expect("entries encode"))
        }
        crate::methods::WORKTREES_REMOVE => {
            let params: RemoveParams = parse(params)?;
            manager
                .remove(&params.workspace, &params.worktree_id, params.force)
                .await?;
            Ok(Value::Null)
        }
        crate::methods::WORKTREES_DESTROY => {
            let params: DestroyParams = parse(params)?;
            manager.destroy(params).await;
            Ok(Value::Null)
        }
        crate::methods::WORKTREES_PRUNE => {
            let params: PruneParams = parse(params)?;
            let (removed, skipped) = prune(params).await;
            Ok(json!({ "removed": removed, "skipped": skipped }))
        }
        crate::methods::WORKTREES_IS_APP_PATH => {
            let params: PathParams = parse(params)?;
            Ok(Value::Bool(manager.is_app_worktree_path(&params.path)?))
        }
        _ => Err(CoreError::new(format!("Unknown RPC method: {method}"))),
    }
}

struct Manager<'a> {
    core: &'a Core,
}

impl Manager<'_> {
    fn with_catalog<T>(
        &self,
        action: impl FnOnce(&mut crate::persistence::catalog::CatalogStore) -> CoreResult<T>,
    ) -> CoreResult<T> {
        let parts = self.core.parts()?;
        let mut catalog = parts.catalog.borrow_mut();
        action(&mut catalog)
    }

    /// Rebuild one folder's worktree rows. Refreshes run one at a time so two folders never
    /// both claim the same app worktree. `claim_path` hands a worktree the folder just created
    /// to that folder, whoever listed it first.
    async fn refresh(
        &self,
        workspace: &WorkspaceRef,
        claim_path: Option<&str>,
    ) -> CoreResult<Vec<WorktreeEntry>> {
        let _turn = self.core.parts()?.worktree_refresh.lock().await;
        let repo_root = resolve_repository_root(&workspace.path).await?;
        if let Some(path) = claim_path.filter(|path| !path.is_empty()) {
            self.release_claims_elsewhere(&workspace.workspace_id, path)?;
        }
        let existing =
            self.with_catalog(|catalog| catalog.list_worktrees(Some(&workspace.workspace_id)))?;
        let listed = list_git_worktrees(&repo_root, workspace, &existing).await?;
        let owned = self.own_linked_worktrees(workspace, listed)?;
        self.with_catalog(|catalog| {
            catalog.replace_workspace_worktrees(&workspace.workspace_id, owned.clone())
        })?;
        Ok(owned)
    }

    fn release_claims_elsewhere(&self, workspace_id: &str, path: &str) -> CoreResult<()> {
        let all = self.with_catalog(|catalog| catalog.list_worktrees(None))?;
        let mut claimants: Vec<&str> = Vec::new();
        for entry in &all {
            if entry.path == path
                && entry.workspace_id != workspace_id
                && !claimants.contains(&entry.workspace_id.as_str())
            {
                claimants.push(&entry.workspace_id);
            }
        }
        for claimant in claimants {
            let kept = all
                .iter()
                .filter(|entry| entry.workspace_id == claimant && entry.path != path)
                .cloned()
                .collect();
            self.with_catalog(|catalog| catalog.replace_workspace_worktrees(claimant, kept))?;
        }
        Ok(())
    }

    /// Keep the folder's own row and the app worktrees no other folder has claimed, so each
    /// app worktree nests under exactly one folder.
    fn own_linked_worktrees(
        &self,
        workspace: &WorkspaceRef,
        listed: Vec<WorktreeEntry>,
    ) -> CoreResult<Vec<WorktreeEntry>> {
        let all = self.with_catalog(|catalog| catalog.list_worktrees(None))?;
        let claimed_elsewhere: HashSet<&str> = all
            .iter()
            .filter(|entry| {
                entry.kind == WorktreeKind::Linked && entry.workspace_id != workspace.workspace_id
            })
            .map(|entry| entry.path.as_str())
            .collect();
        let mut owned = Vec::new();
        for entry in listed {
            if entry.kind == WorktreeKind::Primary
                || (!claimed_elsewhere.contains(entry.path.as_str())
                    && self.is_app_worktree_path(&entry.path)?)
            {
                owned.push(entry);
            }
        }
        Ok(owned)
    }

    /// Worktrees pi-gui creates live under the profile's `<userData>/worktrees` or the legacy
    /// shared `~/.pi/worktrees`. Only those nest under the folder that created them; any other
    /// checkout the user opens is its own sidebar folder.
    fn is_app_worktree_path(&self, path: &str) -> CoreResult<bool> {
        let candidate = canonicalize_nearest(Path::new(path));
        let mut roots = vec![self.core.parts()?.worktree_root.clone()];
        // Read per call, so a test that points HOME elsewhere sees its own legacy root.
        if let Some(home) = home_dir() {
            roots.push(home.join(".pi").join("worktrees"));
        }
        Ok(roots.iter().any(|root| {
            let root = canonicalize_nearest(root);
            candidate != root && candidate.starts_with(&root)
        }))
    }

    async fn create(&self, input: CreateParams) -> CoreResult<WorktreeEntry> {
        let workspace = &input.workspace;
        let repo_root = resolve_repository_root(&workspace.path).await?;
        let trimmed = input.path.trim();
        if trimmed.is_empty() {
            return Err(CoreError::new("Worktree path cannot be empty."));
        }
        let worktree_path = paths::absolute(trimmed);
        if let Some(parent) = worktree_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| CoreError::io(&error, parent))?;
        }
        let worktree_path = paths::display(&worktree_path);
        let mut args = vec!["-C", &repo_root, "worktree", "add"];
        if let Some(branch) = input.branch_name.as_deref().filter(|name| !name.is_empty()) {
            args.extend(["-b", branch]);
        }
        let start_point = input
            .start_point
            .as_deref()
            .map(str::trim)
            .filter(|point| !point.is_empty())
            .unwrap_or("HEAD");
        args.extend([worktree_path.as_str(), start_point]);
        run_git(&args).await?;

        let canonical_path = canonical(&worktree_path);
        let listed = self.refresh(workspace, Some(&canonical_path)).await?;
        let created = listed
            .into_iter()
            .find(|entry| entry.worktree_id == canonical_path)
            .ok_or_else(|| {
                CoreError::new(format!(
                    "Worktree {canonical_path} was created but is missing from the catalog."
                ))
            })?;
        match input.display_name.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => {
                let named = WorktreeEntry {
                    display_name: name.to_owned(),
                    ..created
                };
                self.with_catalog(|catalog| catalog.upsert_worktree(named.clone()))?;
                Ok(named)
            }
            _ => Ok(created),
        }
    }

    async fn remove(
        &self,
        workspace: &WorkspaceRef,
        worktree_id: &str,
        force: bool,
    ) -> CoreResult<()> {
        let repo_root = resolve_repository_root(&workspace.path).await?;
        let resolved_id = canonical(worktree_id);
        let existing = self.with_catalog(|catalog| catalog.get_worktree(&resolved_id))?;
        let target_path = canonical(match &existing {
            Some(entry) if !entry.path.is_empty() => &entry.path,
            _ => &resolved_id,
        });
        let is_primary = match &existing {
            Some(entry) => entry.kind == WorktreeKind::Primary,
            None => target_path == canonical(&workspace.path),
        };
        if is_primary {
            return Err(CoreError::new(
                "The primary workspace cannot be removed as a git worktree.",
            ));
        }
        if !self.is_removable_app_worktree(&target_path).await? {
            return Err(CoreError::new(
                "Only worktrees created by pi-gui can be removed here.",
            ));
        }
        let branch_name = existing.and_then(|entry| entry.branch_name);
        let mut args = vec!["-C", repo_root.as_str(), "worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&target_path);
        if let Err(error) = run_git(&args).await {
            let refreshed = self.refresh(workspace, None).await?;
            if !refreshed
                .iter()
                .any(|entry| entry.worktree_id == target_path)
            {
                delete_app_worktree_branch(&repo_root, branch_name.as_deref()).await;
                return Ok(());
            }
            return Err(error);
        }
        self.refresh(workspace, None).await?;
        delete_app_worktree_branch(&repo_root, branch_name.as_deref()).await;
        Ok(())
    }

    /// Location alone does not prove pi-gui made a checkout, so removal also needs the `pi/*`
    /// branch every app worktree is created on (as the startup prune does).
    async fn is_removable_app_worktree(&self, path: &str) -> CoreResult<bool> {
        if !self.is_app_worktree_path(path)? {
            return Ok(false);
        }
        let info = inspect_linked_worktree(path).await.ok().flatten();
        Ok(info
            .and_then(|info| info.branch_name)
            .is_some_and(|branch| branch.starts_with("pi/")))
    }

    /// Roll back a worktree this app just created when the thread that needed it failed to
    /// start. Force-removes the worktree and deletes its branch, both brand-new artifacts of
    /// the failed call, so nothing that existed before is touched. Best-effort: never fails.
    async fn destroy(&self, input: DestroyParams) {
        let Ok(repo_root) = resolve_repository_root(&input.workspace.path).await else {
            return;
        };
        let target_path = canonical(&input.path);
        // The worktree may not have been fully made; prune and branch cleanup still run.
        let _ = run_git(&[
            "-C",
            &repo_root,
            "worktree",
            "remove",
            "--force",
            &target_path,
        ])
        .await;
        if let Some(branch) = input.branch_name.as_deref().filter(|name| !name.is_empty()) {
            let _ = run_git(&["-C", &repo_root, "branch", "-D", branch]).await;
        }
        let _ = self.refresh(&input.workspace, None).await;
    }
}

/// Startup reconcile pass: remove git worktrees under the app's worktree root that no longer
/// have a catalog or thread reference. Only merged `pi/*` branches qualify. Never
/// force-removes a dirty worktree (a plain `git worktree remove` refuses when the tree is
/// modified), so user work is never destroyed; those are skipped and reported instead.
async fn prune(input: PruneParams) -> (Vec<String>, Vec<String>) {
    let worktree_root = canonical(&input.worktree_root);
    let referenced: HashSet<String> = input.referenced_paths.into_iter().collect();
    let mut removed = Vec::new();
    let mut skipped = Vec::new();
    for candidate in list_app_worktree_candidates(Path::new(&worktree_root)).await {
        if referenced.contains(&candidate) {
            continue;
        }
        let Ok(Some(info)) = inspect_linked_worktree(&candidate).await else {
            skipped.push(candidate);
            continue;
        };
        let Some(branch) = info.branch_name.filter(|branch| branch.starts_with("pi/")) else {
            skipped.push(candidate);
            continue;
        };
        if !is_branch_merged_into_head(&info.repo_root, &branch).await {
            skipped.push(candidate);
            continue;
        }
        // No `--force`: Git refuses to remove a dirty worktree, protecting user work.
        match run_git(&["-C", &info.repo_root, "worktree", "remove", &candidate]).await {
            Ok(_) => {
                removed.push(candidate);
                delete_app_worktree_branch(&info.repo_root, Some(&branch)).await;
            }
            Err(error) => {
                eprintln!(
                    "pi-gui: kept orphaned worktree {candidate}: {}",
                    error.message
                );
                skipped.push(candidate);
            }
        }
    }
    (removed, skipped)
}

/// Delete an app-created worktree branch after its worktree was removed. Only touches `pi/*`
/// branches, with the safe `git branch -d` (which refuses unmerged work): a leaked branch is
/// better than lost commits.
async fn delete_app_worktree_branch(repo_root: &str, branch_name: Option<&str>) {
    let Some(branch) = branch_name.filter(|branch| branch.starts_with("pi/")) else {
        return;
    };
    if let Err(error) = run_git(&["-C", repo_root, "branch", "-d", branch]).await {
        eprintln!(
            "pi-gui: kept branch {branch} after worktree removal: {}",
            error.message
        );
    }
}

async fn is_branch_merged_into_head(repo_root: &str, branch: &str) -> bool {
    let reference = format!("refs/heads/{branch}");
    run_git(&[
        "-C",
        repo_root,
        "merge-base",
        "--is-ancestor",
        &reference,
        "HEAD",
    ])
    .await
    .is_ok()
}

/// Layout: `<worktreeRoot>/<repoName>/<folder>`.
async fn list_app_worktree_candidates(worktree_root: &Path) -> Vec<String> {
    let mut candidates = Vec::new();
    for repo_dir in directories(worktree_root).await {
        for folder in directories(&worktree_root.join(&repo_dir)).await {
            candidates.push(canonical(worktree_root.join(&repo_dir).join(folder)));
        }
    }
    candidates
}

async fn directories(path: &Path) -> Vec<std::ffi::OsString> {
    let mut names = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(path).await else {
        return names;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
            names.push(entry.file_name());
        }
    }
    names
}

struct LinkedWorktree {
    repo_root: String,
    branch_name: Option<String>,
}

/// The main checkout and branch of the linked worktree at `worktree_path`, or `None` when it
/// is not a linked worktree.
async fn inspect_linked_worktree(worktree_path: &str) -> CoreResult<Option<LinkedWorktree>> {
    let output = run_git(&["-C", worktree_path, "worktree", "list", "--porcelain"]).await?;
    let mut repo_root: Option<String> = None;
    let mut branch_name = None;
    for block in porcelain_blocks(&output) {
        let Some(path) = line_value(&block, "worktree ") else {
            continue;
        };
        let entry_path = canonical(path.trim());
        // The first entry is the main worktree.
        if repo_root.is_none() {
            repo_root = Some(entry_path.clone());
        }
        if entry_path == worktree_path {
            if let Some(branch) = line_value(&block, "branch ") {
                branch_name = normalize_branch_name(branch.trim());
            }
        }
    }
    Ok(match repo_root {
        Some(root) if root != worktree_path => Some(LinkedWorktree {
            repo_root: root,
            branch_name,
        }),
        _ => None,
    })
}

async fn resolve_repository_root(workspace_path: &str) -> CoreResult<String> {
    let output = run_git(&["-C", workspace_path, "rev-parse", "--show-toplevel"]).await?;
    Ok(canonical(output.trim()))
}

async fn list_git_worktrees(
    repo_root: &str,
    workspace: &WorkspaceRef,
    existing_entries: &[WorktreeEntry],
) -> CoreResult<Vec<WorktreeEntry>> {
    let output = run_git(&["-C", repo_root, "worktree", "list", "--porcelain"]).await?;
    let existing: HashMap<&str, &WorktreeEntry> = existing_entries
        .iter()
        .map(|entry| (entry.worktree_id.as_str(), entry))
        .collect();
    let workspace_path = canonical(&workspace.path);
    let mut listed: Vec<WorktreeEntry> = porcelain_blocks(&output)
        .iter()
        .filter_map(|block| parse_worktree_block(block, workspace, &workspace_path, &existing))
        .collect();
    if !listed
        .iter()
        .any(|entry| entry.worktree_id == workspace_path)
    {
        let now = now_iso();
        listed.push(WorktreeEntry {
            worktree_id: workspace_path.clone(),
            workspace_id: workspace.workspace_id.clone(),
            path: workspace_path.clone(),
            display_name: default_display_name(workspace, &workspace_path, WorktreeKind::Primary),
            kind: WorktreeKind::Primary,
            status: WorktreeStatus::Ready,
            branch_name: None,
            head_sha: None,
            pinned: None,
            created_at: now.clone(),
            updated_at: now,
            extra: Map::new(),
        });
    }
    // Keyed by id in first-seen order, like a JavaScript `Map`.
    let mut discovered: Vec<WorktreeEntry> = Vec::new();
    for entry in listed {
        let known = existing.get(entry.worktree_id.as_str()).copied();
        let merged = merge_worktree_entry(entry, known);
        match discovered
            .iter_mut()
            .find(|found| found.worktree_id == merged.worktree_id)
        {
            Some(found) => *found = merged,
            None => discovered.push(merged),
        }
    }
    discovered.sort_by(compare_worktrees);
    Ok(discovered)
}

fn parse_worktree_block(
    lines: &[&str],
    workspace: &WorkspaceRef,
    workspace_path: &str,
    existing: &HashMap<&str, &WorktreeEntry>,
) -> Option<WorktreeEntry> {
    let path = canonical(line_value(lines, "worktree ")?.trim());
    let kind = if path == workspace_path {
        WorktreeKind::Primary
    } else {
        WorktreeKind::Linked
    };
    let known = existing.get(path.as_str()).copied();
    let display_name = known
        .map(|entry| entry.display_name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| default_display_name(workspace, &path, kind));
    let now = now_iso();
    Some(WorktreeEntry {
        worktree_id: path.clone(),
        workspace_id: workspace.workspace_id.clone(),
        display_name,
        kind,
        status: if lines.contains(&"prunable") {
            WorktreeStatus::Missing
        } else {
            WorktreeStatus::Ready
        },
        head_sha: line_value(lines, "HEAD ").map(|sha| sha.trim().to_owned()),
        branch_name: line_value(lines, "branch ")
            .and_then(|branch| normalize_branch_name(branch.trim())),
        created_at: known.map_or_else(|| now.clone(), |entry| entry.created_at.clone()),
        updated_at: now,
        pinned: known.and_then(|entry| entry.pinned),
        path,
        extra: Map::new(),
    })
}

fn merge_worktree_entry(next: WorktreeEntry, existing: Option<&WorktreeEntry>) -> WorktreeEntry {
    let Some(existing) = existing else {
        return next;
    };
    let same_identity = existing.workspace_id == next.workspace_id
        && existing.path == next.path
        && existing.kind == next.kind
        && existing.status == next.status
        && existing.branch_name == next.branch_name
        && existing.head_sha == next.head_sha;
    let display_name = match existing.display_name.trim() {
        "" => next.display_name.clone(),
        name => name.to_owned(),
    };
    WorktreeEntry {
        display_name,
        created_at: existing.created_at.clone(),
        updated_at: if same_identity {
            existing.updated_at.clone()
        } else {
            next.updated_at.clone()
        },
        pinned: existing.pinned.or(next.pinned),
        ..next
    }
}

fn default_display_name(workspace: &WorkspaceRef, path: &str, kind: WorktreeKind) -> String {
    if kind == WorktreeKind::Primary {
        if let Some(name) = workspace
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            return name.to_owned();
        }
    }
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned())
}

fn normalize_branch_name(value: &str) -> Option<String> {
    let branch = value.strip_prefix("refs/heads/").unwrap_or(value).trim();
    (!branch.is_empty() && branch != "detached").then(|| branch.to_owned())
}

/// `output.split(/\n\s*\n/)`, each block's lines trimmed and blank ones dropped.
fn porcelain_blocks(output: &str) -> Vec<Vec<&str>> {
    let mut blocks = Vec::new();
    let mut block: Vec<&str> = Vec::new();
    for line in output.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            if !block.is_empty() {
                blocks.push(std::mem::take(&mut block));
            }
        } else {
            block.push(line);
        }
    }
    if !block.is_empty() {
        blocks.push(block);
    }
    blocks
}

fn line_value<'a>(lines: &[&'a str], prefix: &str) -> Option<&'a str> {
    lines.iter().find_map(|line| line.strip_prefix(prefix))
}

/// The worktree commands run Git as the TypeScript manager did: the app's own environment,
/// a 10 MiB output limit, and `execFile`'s error on failure.
async fn run_git(args: &[&str]) -> CoreResult<String> {
    GitCommand::new(args.iter().copied())
        .max_buffer(MAX_BUFFER)
        .text()
        .await
}

fn canonical(path: impl AsRef<Path>) -> String {
    paths::display(&paths::canonical(path))
}

/// The real path of the nearest existing ancestor, so a root that does not exist yet still
/// compares like Git's resolved paths.
fn canonicalize_nearest(path: &Path) -> PathBuf {
    let absolute = paths::absolute(path);
    if let Ok(real) = paths::realpath(&absolute) {
        return real;
    }
    match (absolute.parent(), absolute.file_name()) {
        (Some(parent), Some(name)) => canonicalize_nearest(parent).join(name),
        _ => absolute,
    }
}

fn home_dir() -> Option<PathBuf> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(variable)
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// `new Date().toISOString()`: UTC with milliseconds.
pub fn now_iso() -> String {
    let since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_millis(since_epoch.as_millis() as i64)
}

fn iso_from_millis(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let in_day = millis.rem_euclid(86_400_000);
    // Howard Hinnant's days-to-civil conversion.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_iso_dates_like_javascript() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_767_225_600_000),
            "2026-01-01T00:00:00.000Z"
        );
        assert_eq!(iso_from_millis(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(
            iso_from_millis(1_709_251_199_999),
            "2024-02-29T23:59:59.999Z"
        );
    }

    #[test]
    fn splits_porcelain_into_blocks() {
        let output = "worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n  \n\nworktree /c\nprunable\n";
        let blocks = porcelain_blocks(output);
        assert_eq!(blocks.len(), 3);
        assert_eq!(line_value(&blocks[0], "branch "), Some("refs/heads/main"));
        assert!(blocks[2].contains(&"prunable"));
        assert_eq!(
            normalize_branch_name("refs/heads/pi/x"),
            Some("pi/x".into())
        );
        assert_eq!(normalize_branch_name("detached"), None);
    }
}
