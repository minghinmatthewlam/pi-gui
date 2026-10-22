//! Model and runtime settings (the settings half of `app-store.ts`): app-global or per-repo
//! model settings, runtime snapshots, and the settings-file baseline used to notice outside
//! edits. The renderer's settings methods are in `ipc`, their actions in `runtime`, and
//! provider sign-in in `login`.

mod ipc;
pub mod login;
pub mod runtime;

use super::pi::{args, runtime_call};
use super::{AppData, Kernel};
use crate::error::CoreResult;
use crate::persistence::catalog::WorkspaceEntry;
use crate::state::desktop_state::{ModelSettingsScopeMode, WorkspaceRecord};
use crate::state::driver::{ModelSettingsSnapshot, RuntimeSnapshot, WorkspaceRef};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// What the settings part keeps besides the shared maps.
#[derive(Default)]
pub struct SettingsState {}

pub use ipc::register;

/// `hasStoredModelSettings`.
pub fn has_stored_model_settings(settings: &ModelSettingsSnapshot) -> bool {
    !settings.enabled_model_patterns.is_empty()
        || settings
            .default_provider
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || settings
            .default_model_id
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || settings
            .default_thinking_level
            .as_deref()
            .is_some_and(|value| !value.is_empty())
}

pub fn is_per_repo(data: &AppData) -> bool {
    data.state.model_settings_scope_mode == ModelSettingsScopeMode::PerRepo
}

fn entry_ref(entry: &WorkspaceEntry) -> WorkspaceRef {
    WorkspaceRef {
        workspace_id: entry.workspace_id.clone(),
        path: entry.path.clone(),
        display_name: Some(entry.display_name.clone()),
    }
}

pub fn record_ref(workspace: &WorkspaceRecord) -> WorkspaceRef {
    WorkspaceRef {
        workspace_id: workspace.id.clone(),
        path: workspace.path.clone(),
        display_name: Some(workspace.name.clone()),
    }
}

fn fallback_workspace<'a>(
    workspaces: &'a [WorkspaceRef],
    preferred: Option<&str>,
) -> Option<&'a WorkspaceRef> {
    preferred
        .filter(|preferred| !preferred.is_empty())
        .and_then(|preferred| {
            workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == preferred)
        })
        .or_else(|| workspaces.first())
}

/// `loadLiveGlobalModelSettings`.
pub async fn load_live_global_model_settings(
    kernel: &Kernel,
    workspaces: &[WorkspaceEntry],
    preferred_workspace_id: Option<&str>,
) -> CoreResult<ModelSettingsSnapshot> {
    let refs: Vec<WorkspaceRef> = workspaces.iter().map(entry_ref).collect();
    load_live_global_for_refs(kernel, &refs, preferred_workspace_id).await
}

async fn load_live_global_for_refs(
    kernel: &Kernel,
    refs: &[WorkspaceRef],
    preferred_workspace_id: Option<&str>,
) -> CoreResult<ModelSettingsSnapshot> {
    let Some(workspace) = fallback_workspace(refs, preferred_workspace_id) else {
        return Ok(kernel.data.borrow().state.global_model_settings.clone());
    };
    runtime_call(
        kernel.driver(),
        "getGlobalModelSettings",
        args([json!(workspace)]),
    )
    .await
}

/// `restoreGlobalModelSettings`: writes the app's stored settings back to pi.
pub async fn restore_global_model_settings(
    kernel: &Kernel,
    settings: &ModelSettingsSnapshot,
    workspaces: &[WorkspaceEntry],
    preferred_workspace_id: &str,
) -> CoreResult<()> {
    let refs: Vec<WorkspaceRef> = workspaces.iter().map(entry_ref).collect();
    restore_global_model_settings_for(kernel, settings, &refs, Some(preferred_workspace_id)).await
}

/// `restoreGlobalModelSettings` through the first workspace, or the preferred one.
pub async fn restore_global_model_settings_for(
    kernel: &Kernel,
    settings: &ModelSettingsSnapshot,
    refs: &[WorkspaceRef],
    preferred_workspace_id: Option<&str>,
) -> CoreResult<()> {
    if !has_stored_model_settings(settings) {
        return Ok(());
    }
    let Some(workspace) = fallback_workspace(refs, preferred_workspace_id).cloned() else {
        return Ok(());
    };
    let driver = kernel.driver();
    driver
        .runtime(
            "setScopedModelPatterns",
            args([json!(workspace), json!(settings.enabled_model_patterns)]),
        )
        .await?;
    if let Some(level) = settings
        .default_thinking_level
        .as_deref()
        .filter(|level| !level.is_empty())
    {
        driver
            .runtime(
                "setDefaultThinkingLevel",
                args([json!(workspace), json!(level)]),
            )
            .await?;
    }
    if let (Some(provider), Some(model_id)) = (
        settings
            .default_provider
            .as_deref()
            .filter(|value| !value.is_empty()),
        settings
            .default_model_id
            .as_deref()
            .filter(|value| !value.is_empty()),
    ) {
        driver
            .runtime(
                "setDefaultModel",
                args([
                    json!(workspace),
                    json!({ "provider": provider, "modelId": model_id }),
                ]),
            )
            .await?;
    }
    let loaded = kernel
        .data
        .borrow()
        .runtime_by_workspace
        .contains_key(&workspace.workspace_id);
    if loaded {
        let snapshot = refresh_runtime_snapshot(kernel, &workspace).await?;
        kernel
            .data
            .borrow_mut()
            .runtime_by_workspace
            .insert(workspace.workspace_id.clone(), snapshot);
    }
    Ok(())
}

/// `resolveRepoWorkspaceId` (`contracts/workspace-roots.ts`): the primary checkout among the
/// workspaces linked to `workspace_id` as worktrees.
pub fn resolve_repo_workspace_id(
    workspaces: &[WorkspaceRecord],
    workspace_id: &str,
) -> Option<String> {
    if workspace_id.is_empty() {
        return None;
    }
    let by_id: HashMap<&str, &WorkspaceRecord> = workspaces
        .iter()
        .map(|workspace| (workspace.id.as_str(), workspace))
        .collect();
    if !by_id.contains_key(workspace_id) {
        return Some(workspace_id.to_owned());
    }
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for workspace in workspaces {
        if let Some(root) = workspace.root_workspace_id.as_deref() {
            children.entry(root).or_default().push(&workspace.id);
        }
    }
    let mut component: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut pending = vec![workspace_id];
    while let Some(current) = pending.pop() {
        if !seen.insert(current) {
            continue;
        }
        component.push(current);
        let Some(workspace) = by_id.get(current) else {
            continue;
        };
        if let Some(root) = workspace.root_workspace_id.as_deref() {
            if !seen.contains(root) {
                pending.push(root);
            }
        }
        for child in children.get(current).into_iter().flatten() {
            if !seen.contains(child) {
                pending.push(child);
            }
        }
    }
    let mut members: Vec<&WorkspaceRecord> = component
        .iter()
        .filter_map(|id| by_id.get(id).copied())
        .collect();
    members.sort_by(|left, right| {
        let left_primary = left.root_workspace_id.is_none();
        let right_primary = right.root_workspace_id.is_none();
        right_primary
            .cmp(&left_primary)
            .then_with(|| crate::js::length(&left.path).cmp(&crate::js::length(&right.path)))
            .then_with(|| crate::locale::compare(&left.path, &right.path))
    });
    members.first().map(|workspace| workspace.id.clone())
}

/// `readProjectModelSettingsFile`: the repo's `.pi/settings.json`, or `{}`.
async fn read_project_model_settings_file(workspace_path: &str) -> Map<String, Value> {
    let path = Path::new(workspace_path).join(".pi").join("settings.json");
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return Map::new();
    };
    match serde_json::from_str(&raw) {
        Ok(Value::Object(object)) => object,
        _ => Map::new(),
    }
}

/// `mergeModelSettingsSnapshot`: the repo's settings over the global ones.
fn merge_model_settings_snapshot(
    global: &ModelSettingsSnapshot,
    project: &Map<String, Value>,
) -> ModelSettingsSnapshot {
    let text = |key: &str| project.get(key).and_then(Value::as_str).map(str::to_owned);
    let non_empty = |value: Option<String>| value.filter(|value| !value.is_empty());
    ModelSettingsSnapshot {
        enabled_model_patterns: match project.get("enabledModels") {
            Some(Value::Array(values)) => values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect(),
            _ => global.enabled_model_patterns.clone(),
        },
        default_provider: non_empty(
            text("defaultProvider").or_else(|| global.default_provider.clone()),
        ),
        default_model_id: non_empty(
            text("defaultModel").or_else(|| global.default_model_id.clone()),
        ),
        default_thinking_level: non_empty(
            text("defaultThinkingLevel").or_else(|| global.default_thinking_level.clone()),
        ),
    }
}

/// `applyModelSettingsSnapshot`.
fn apply_model_settings_snapshot(
    runtime: &RuntimeSnapshot,
    settings: &ModelSettingsSnapshot,
) -> RuntimeSnapshot {
    let mut runtime = runtime.clone();
    let non_empty = |value: &Option<String>| value.clone().filter(|value| !value.is_empty());
    runtime.settings.default_provider = non_empty(&settings.default_provider);
    runtime.settings.default_model_id = non_empty(&settings.default_model_id);
    runtime.settings.default_thinking_level = non_empty(&settings.default_thinking_level);
    runtime.settings.enabled_model_patterns = settings.enabled_model_patterns.clone();
    runtime
}

/// `loadScopedModelSettingsByWorkspace`: each repo's merged settings, by its primary
/// workspace.
pub async fn load_scoped_model_settings_by_workspace(
    _kernel: &Kernel,
    workspaces: &[WorkspaceRecord],
    workspace_refs: &[WorkspaceEntry],
    global: &ModelSettingsSnapshot,
) -> CoreResult<IndexMap<String, ModelSettingsSnapshot>> {
    let paths: Vec<(String, String)> = workspace_refs
        .iter()
        .map(|entry| (entry.workspace_id.clone(), entry.path.clone()))
        .collect();
    Ok(load_scoped_for_paths(workspaces, &paths, global).await)
}

async fn load_scoped_for_paths(
    workspaces: &[WorkspaceRecord],
    paths: &[(String, String)],
    global: &ModelSettingsSnapshot,
) -> IndexMap<String, ModelSettingsSnapshot> {
    let mut owners: Vec<String> = Vec::new();
    for workspace in workspaces {
        let owner = resolve_repo_workspace_id(workspaces, &workspace.id)
            .unwrap_or_else(|| workspace.id.clone());
        if !owners.contains(&owner) {
            owners.push(owner);
        }
    }
    let loaded = super::futures_join_all(owners.into_iter().map(|owner| async move {
        let (_, path) = paths.iter().find(|(id, _)| *id == owner)?;
        let project = read_project_model_settings_file(path).await;
        Some((owner, merge_model_settings_snapshot(global, &project)))
    }))
    .await;
    loaded.into_iter().flatten().collect()
}

/// `serializeEffectiveRuntimeState`: in per-repo mode each runtime shows its repo's settings.
pub fn serialize_effective_runtime_state(
    data: &AppData,
    workspaces: &[WorkspaceRecord],
    scoped: Option<&IndexMap<String, ModelSettingsSnapshot>>,
) -> IndexMap<String, RuntimeSnapshot> {
    let mut runtime_by_workspace = data.runtime_by_workspace.clone();
    if !is_per_repo(data) {
        return runtime_by_workspace;
    }
    for workspace in workspaces {
        let owner = resolve_repo_workspace_id(workspaces, &workspace.id);
        let settings = owner
            .as_ref()
            .and_then(|owner| scoped.and_then(|scoped| scoped.get(owner)));
        let (Some(runtime), Some(settings)) = (runtime_by_workspace.get(&workspace.id), settings)
        else {
            continue;
        };
        let applied = apply_model_settings_snapshot(runtime, settings);
        runtime_by_workspace.insert(workspace.id.clone(), applied);
    }
    runtime_by_workspace
}

/// `serializeRuntimeStateForCurrentWorkspaces`.
pub async fn serialize_runtime_state_for_current_workspaces(
    kernel: &Kernel,
) -> IndexMap<String, RuntimeSnapshot> {
    let (per_repo, workspaces, global) = {
        let data = kernel.data.borrow();
        (
            is_per_repo(&data),
            data.state.workspaces.clone(),
            data.state.global_model_settings.clone(),
        )
    };
    if !per_repo {
        return kernel.data.borrow().runtime_by_workspace.clone();
    }
    let paths: Vec<(String, String)> = workspaces
        .iter()
        .map(|workspace| (workspace.id.clone(), workspace.path.clone()))
        .collect();
    let scoped = load_scoped_for_paths(&workspaces, &paths, &global).await;
    serialize_effective_runtime_state(&kernel.data.borrow(), &workspaces, Some(&scoped))
}

/// `resolveGlobalSettingsPath`: `$PI_CODING_AGENT_DIR/settings.json`, or
/// `~/.pi/agent/settings.json`.
pub fn global_settings_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let agent_dir = match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(dir) if !dir.is_empty() => match dir.strip_prefix('~') {
            Some(rest) => home.join(rest.trim_start_matches('/')),
            None => PathBuf::from(dir),
        },
        _ => home.join(".pi").join("agent"),
    };
    agent_dir.join("settings.json")
}

/// `statMtimeMs`.
pub async fn stat_mtime_ms(path: &Path) -> Option<f64> {
    let modified = tokio::fs::metadata(path).await.ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_secs_f64() * 1000.0)
}

/// `seedSettingsMtimeBaseline`: remembers the settings files' times so an edit made before the
/// first focus still reads as changed.
pub async fn seed_settings_mtime_baseline(kernel: &Kernel, workspace_path: &str) {
    let files = [
        global_settings_path(),
        Path::new(workspace_path).join(".pi").join("settings.json"),
    ];
    for file in files {
        if kernel
            .data
            .borrow()
            .settings_file_mtimes
            .contains_key(&file)
        {
            continue;
        }
        if let Some(mtime) = stat_mtime_ms(&file).await {
            kernel
                .data
                .borrow_mut()
                .settings_file_mtimes
                .insert(file, mtime);
        }
    }
}

/// `loadEffectiveModelSettingsForWorkspace`.
async fn load_effective_model_settings_for_workspace(
    kernel: &Kernel,
    workspace_id: &str,
) -> CoreResult<Option<ModelSettingsSnapshot>> {
    let (owner, refs, stored) = {
        let data = kernel.data.borrow();
        let owner = if is_per_repo(&data) {
            resolve_repo_workspace_id(&data.state.workspaces, workspace_id)
                .unwrap_or_else(|| workspace_id.to_owned())
        } else {
            workspace_id.to_owned()
        };
        let Some(owner_ref) = data.workspace_ref(&owner) else {
            return Ok(None);
        };
        let refs: Vec<WorkspaceRef> = data.state.workspaces.iter().map(record_ref).collect();
        let stored = (is_per_repo(&data)
            && has_stored_model_settings(&data.state.global_model_settings))
        .then(|| data.state.global_model_settings.clone());
        (owner_ref, refs, stored)
    };
    let global = match stored {
        Some(stored) => stored,
        None => load_live_global_for_refs(kernel, &refs, Some(&owner.workspace_id)).await?,
    };
    let project = read_project_model_settings_file(&owner.path).await;
    Ok(Some(merge_model_settings_snapshot(&global, &project)))
}

/// `buildCreateSessionOptions`: in per-repo mode a new thread starts on its repo's model.
pub async fn build_create_session_options(
    kernel: &Kernel,
    workspace_id: &str,
) -> CoreResult<Option<Map<String, Value>>> {
    if !is_per_repo(&kernel.data.borrow()) {
        return Ok(None);
    }
    let Some(settings) = load_effective_model_settings_for_workspace(kernel, workspace_id).await?
    else {
        return Ok(None);
    };
    let mut options = Map::new();
    if let (Some(provider), Some(model_id)) =
        (&settings.default_provider, &settings.default_model_id)
    {
        options.insert(
            "initialModel".into(),
            json!({ "provider": provider, "modelId": model_id }),
        );
    }
    if let Some(level) = &settings.default_thinking_level {
        options.insert("initialThinkingLevel".into(), json!(level));
    }
    Ok(Some(options))
}

/// `runtimeSupervisor.refreshRuntime`.
pub async fn refresh_runtime_snapshot(
    kernel: &Kernel,
    workspace: &WorkspaceRef,
) -> CoreResult<RuntimeSnapshot> {
    runtime_call(kernel.driver(), "refreshRuntime", args([json!(workspace)])).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::desktop_state::WorkspaceKind;

    fn workspace(id: &str, path: &str, root: Option<&str>) -> WorkspaceRecord {
        WorkspaceRecord {
            id: id.into(),
            name: id.into(),
            path: path.into(),
            last_opened_at: String::new(),
            kind: if root.is_some() {
                WorkspaceKind::Worktree
            } else {
                WorkspaceKind::Primary
            },
            root_workspace_id: root.map(str::to_owned),
            branch_name: None,
            sessions: Vec::new(),
        }
    }

    #[test]
    fn a_worktree_resolves_to_its_primary_checkout() {
        let workspaces = vec![
            workspace("wt", "/repo/.worktrees/a", Some("main")),
            workspace("main", "/repo", None),
        ];
        assert_eq!(
            resolve_repo_workspace_id(&workspaces, "wt").as_deref(),
            Some("main")
        );
        assert_eq!(
            resolve_repo_workspace_id(&workspaces, "gone").as_deref(),
            Some("gone")
        );
        assert_eq!(resolve_repo_workspace_id(&workspaces, ""), None);
    }

    #[test]
    fn project_settings_override_global_ones() {
        let global = ModelSettingsSnapshot {
            default_provider: Some("a".into()),
            default_model_id: Some("m".into()),
            default_thinking_level: None,
            enabled_model_patterns: vec!["x".into()],
        };
        let project = json!({ "defaultModel": "n", "enabledModels": ["y", 1] });
        let merged = merge_model_settings_snapshot(&global, project.as_object().unwrap());
        assert_eq!(merged.default_provider.as_deref(), Some("a"));
        assert_eq!(merged.default_model_id.as_deref(), Some("n"));
        assert_eq!(merged.enabled_model_patterns, vec!["y".to_owned()]);
        assert!(has_stored_model_settings(&merged));
        assert!(!has_stored_model_settings(&ModelSettingsSnapshot::default()));
    }
}
