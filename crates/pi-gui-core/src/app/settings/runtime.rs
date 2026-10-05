//! The settings actions (`app-store.ts` "Runtime / model / provider settings" and "MCP
//! servers"): each asks pi to change its settings, records the write so focus does not take
//! it for an outside edit, reloads open threads that must see it, and refreshes the state.

use super::super::pi::{args, runtime_call, Args, LoginCallbacks};
use super::super::refresh::{refresh_state, RefreshOptions};
use super::super::sessions::{refresh_session_commands, with_error, with_error_handling};
use super::super::{futures_join_all, persist, publish, AppData, Kernel};
use super::{is_per_repo, record_ref, restore_global_model_settings_for, stat_mtime_ms};
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{DesktopAppState, ModelSettingsScopeMode};
use crate::state::driver::{session_key, session_ref, RuntimeSnapshot, SessionRef, WorkspaceRef};
use serde_json::{json, Map, Value};
use std::future::Future;
use std::rc::Rc;

const RELOAD_FAILED: &str =
    "Some open threads could not reload; they pick up the change when reopened.";

/// What `withRuntimeUpdate` does besides the action.
#[derive(Default, Clone, Copy)]
pub struct UpdateOptions {
    pub reload_sessions: bool,
    pub refresh_all_workspaces: bool,
}

/// `resolveModelSettingsWorkspaceId`: in per-repo mode, the repo's primary checkout.
pub fn resolve_model_settings_workspace_id(data: &AppData, workspace_id: &str) -> String {
    if !is_per_repo(data) {
        return workspace_id.to_owned();
    }
    super::resolve_repo_workspace_id(&data.state.workspaces, workspace_id)
        .unwrap_or_else(|| workspace_id.to_owned())
}

fn workspace_ref(kernel: &Kernel, workspace_id: &str) -> Option<WorkspaceRef> {
    kernel.data.borrow().workspace_ref(workspace_id)
}

fn all_workspace_ids(kernel: &Kernel) -> Vec<String> {
    let data = kernel.data.borrow();
    data.state
        .workspaces
        .iter()
        .map(|workspace| workspace.id.clone())
        .collect()
}

async fn unknown_workspace(kernel: &Kernel, workspace_id: &str) -> CoreResult<DesktopAppState> {
    with_error(kernel, format!("Unknown workspace: {workspace_id}")).await
}

async fn refresh_clearing_error(kernel: &Kernel) -> CoreResult<DesktopAppState> {
    refresh_state(
        kernel,
        RefreshOptions {
            clear_last_error: true,
            ..Default::default()
        },
    )
    .await
}

/// The refreshed state, or `message` when an open thread could not reload.
async fn reloaded_or(
    kernel: &Kernel,
    reloaded: bool,
    state: DesktopAppState,
    message: &str,
) -> CoreResult<DesktopAppState> {
    if reloaded {
        Ok(state)
    } else {
        with_error(kernel, message.to_owned()).await
    }
}

async fn runtime_snapshot(
    kernel: &Kernel,
    method: &'static str,
    call_args: Args,
) -> CoreResult<RuntimeSnapshot> {
    runtime_call(kernel.driver(), method, call_args).await
}

/// `recordSettingsSelfWrite`: the app just wrote pi's settings files, so their new times are
/// not an outside edit on the next focus (which would bring back models just turned off).
pub async fn record_settings_self_write(kernel: &Kernel) {
    let files: Vec<_> = kernel
        .data
        .borrow()
        .settings_file_mtimes
        .keys()
        .cloned()
        .collect();
    for file in files {
        if let Some(mtime) = stat_mtime_ms(&file).await {
            kernel
                .data
                .borrow_mut()
                .settings_file_mtimes
                .insert(file, mtime);
        }
    }
}

/// `sessionRefsForWorkspace`: the workspace's threads that are open (selected, subscribed
/// or with commands loaded).
fn session_refs_for_workspace(data: &AppData, workspace_id: &str) -> Vec<SessionRef> {
    let Some(workspace) = data
        .state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
    else {
        return Vec::new();
    };
    workspace
        .sessions
        .iter()
        .map(|session| session_ref(workspace_id, &session.id))
        .filter(|session_ref| {
            let key = session_key(session_ref);
            (data.state.selected_workspace_id == workspace_id
                && data.state.selected_session_id == session_ref.session_id)
                || data.sessions.session_commands_by_session.contains_key(&key)
                || data.sessions.session_subscriptions.contains_key(&key)
        })
        .collect()
}

/// `reloadOpenSessions`: open threads re-read their config; one failing does not stop the
/// others. A thread mid-turn or mid-compaction reloads when that ends.
async fn reload_open_sessions(kernel: &Kernel, workspace_ids: &[String]) -> bool {
    let refs: Vec<SessionRef> = {
        let data = kernel.data.borrow();
        workspace_ids
            .iter()
            .flat_map(|workspace_id| session_refs_for_workspace(&data, workspace_id))
            .collect()
    };
    let driver = kernel.driver();
    let reloads = futures_join_all(
        refs.iter()
            .map(|session_ref| driver.call("reloadSessionWhenIdle", args([json!(session_ref)]))),
    )
    .await;
    let mut reloaded = true;
    for result in reloads {
        if let Err(error) = result {
            eprintln!(
                "[app-store] reloading open threads failed: {}",
                error.message
            );
            reloaded = false;
        }
    }
    reloaded
}

/// `refreshSessionCommandsForWorkspace`.
async fn refresh_session_commands_for_workspace(
    kernel: &Kernel,
    workspace_id: &str,
) -> CoreResult<()> {
    let refs = session_refs_for_workspace(&kernel.data.borrow(), workspace_id);
    for result in futures_join_all(
        refs.iter()
            .map(|session_ref| refresh_session_commands(kernel, session_ref)),
    )
    .await
    {
        result?;
    }
    Ok(())
}

/// `refreshSessionCommandsForAllWorkspaces`: a workspace that fails is only logged.
async fn refresh_session_commands_for_all_workspaces(kernel: &Kernel) {
    let workspaces: Vec<(String, String)> = kernel
        .data
        .borrow()
        .state
        .workspaces
        .iter()
        .map(|workspace| (workspace.id.clone(), workspace.path.clone()))
        .collect();
    let results = futures_join_all(
        workspaces
            .iter()
            .map(|(id, _)| refresh_session_commands_for_workspace(kernel, id)),
    )
    .await;
    for ((_, path), result) in workspaces.iter().zip(results) {
        if let Err(error) = result {
            eprintln!(
                "[pi-gui] Failed to refresh session commands for {path} after custom provider update: {}",
                error.message
            );
        }
    }
}

/// `refreshRuntimeForAllWorkspaces`: the updated workspace's snapshot, and a fresh one for
/// every other workspace; one that fails keeps its old snapshot.
async fn refresh_runtime_for_all_workspaces(
    kernel: &Kernel,
    updated_workspace_id: &str,
    updated: RuntimeSnapshot,
) {
    let others: Vec<WorkspaceRef> = {
        let mut data = kernel.data.borrow_mut();
        data.runtime_by_workspace
            .insert(updated_workspace_id.to_owned(), updated);
        data.state
            .workspaces
            .iter()
            .filter(|workspace| workspace.id != updated_workspace_id)
            .map(record_ref)
            .collect()
    };
    let snapshots = futures_join_all(
        others
            .iter()
            .map(|workspace| super::refresh_runtime_snapshot(kernel, workspace)),
    )
    .await;
    for (workspace, result) in others.iter().zip(snapshots) {
        match result {
            Ok(snapshot) => {
                kernel
                    .data
                    .borrow_mut()
                    .runtime_by_workspace
                    .insert(workspace.workspace_id.clone(), snapshot);
            }
            Err(error) => eprintln!(
                "[pi-gui] Failed to refresh runtime for {} after custom provider update: {}",
                workspace.path, error.message
            ),
        }
    }
}

/// `withRuntimeUpdate`.
pub async fn with_runtime_update<F, Fut>(
    kernel: &Kernel,
    workspace_id: &str,
    options: UpdateOptions,
    action: F,
) -> CoreResult<DesktopAppState>
where
    F: FnOnce(WorkspaceRef) -> Fut,
    Fut: Future<Output = CoreResult<RuntimeSnapshot>>,
{
    kernel.initialize().await;
    let Some(ws) = workspace_ref(kernel, workspace_id) else {
        return unknown_workspace(kernel, workspace_id).await;
    };
    with_error_handling(kernel, async {
        let snapshot = action(ws).await?;
        record_settings_self_write(kernel).await;
        if options.refresh_all_workspaces {
            refresh_runtime_for_all_workspaces(kernel, workspace_id, snapshot).await;
        } else {
            kernel
                .data
                .borrow_mut()
                .runtime_by_workspace
                .insert(workspace_id.to_owned(), snapshot);
        }
        let reloaded = if options.reload_sessions {
            let ids = if options.refresh_all_workspaces {
                all_workspace_ids(kernel)
            } else {
                vec![workspace_id.to_owned()]
            };
            reload_open_sessions(kernel, &ids).await
        } else {
            true
        };
        if options.refresh_all_workspaces {
            refresh_session_commands_for_all_workspaces(kernel).await;
        } else {
            refresh_session_commands_for_workspace(kernel, workspace_id).await?;
        }
        let state = refresh_clearing_error(kernel).await?;
        reloaded_or(kernel, reloaded, state, RELOAD_FAILED).await
    })
    .await
}

/// A runtime call that answers a snapshot, as `withRuntimeUpdate` actions are.
pub async fn update_runtime(
    kernel: &Kernel,
    workspace_id: &str,
    options: UpdateOptions,
    method: &'static str,
    rest: Vec<Option<Value>>,
) -> CoreResult<DesktopAppState> {
    with_runtime_update(kernel, workspace_id, options, |ws| {
        let mut call_args = vec![Some(json!(ws))];
        call_args.extend(rest);
        runtime_snapshot(kernel, method, call_args)
    })
    .await
}

/// `setModelSettingsScopeMode`.
pub async fn set_model_settings_scope_mode(
    kernel: &Kernel,
    mode: ModelSettingsScopeMode,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let (current, global, refs) = {
        let data = kernel.data.borrow();
        (
            data.state.model_settings_scope_mode,
            data.state.global_model_settings.clone(),
            data.state
                .workspaces
                .iter()
                .map(record_ref)
                .collect::<Vec<_>>(),
        )
    };
    if current == mode {
        return Ok(publish::emit(kernel));
    }
    if mode == ModelSettingsScopeMode::AppGlobal {
        restore_global_model_settings_for(kernel, &global, &refs, None).await?;
    }
    {
        let mut data = kernel.data.borrow_mut();
        data.state.model_settings_scope_mode = mode;
        data.state.last_error = None;
        data.bump();
    }
    persist::persist_ui_state(kernel).await?;
    refresh_clearing_error(kernel).await
}

/// `refreshRuntime`.
pub async fn refresh_runtime(
    kernel: &Kernel,
    workspace_id: Option<String>,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let workspace_id = workspace_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| kernel.data.borrow().state.selected_workspace_id.clone());
    let Some(ws) = workspace_ref(kernel, &workspace_id) else {
        return Ok(publish::emit(kernel));
    };
    with_error_handling(kernel, async {
        let snapshot = super::refresh_runtime_snapshot(kernel, &ws).await?;
        kernel
            .data
            .borrow_mut()
            .runtime_by_workspace
            .insert(ws.workspace_id.clone(), snapshot);
        let reloaded = reload_open_sessions(kernel, std::slice::from_ref(&ws.workspace_id)).await;
        refresh_session_commands_for_workspace(kernel, &ws.workspace_id).await?;
        let state = refresh_clearing_error(kernel).await?;
        reloaded_or(kernel, reloaded, state, RELOAD_FAILED).await
    })
    .await
}

/// `setDefaultModel`, `setDefaultThinkingLevel` and `setScopedModelPatterns`: pi's global
/// settings in app-global mode, the repo's `.pi/settings.json` in per-repo mode.
pub async fn set_model_setting(
    kernel: &Kernel,
    workspace_id: &str,
    global_method: &'static str,
    project_method: &'static str,
    value: Option<Value>,
) -> CoreResult<DesktopAppState> {
    let (target, per_repo) = {
        let data = kernel.data.borrow();
        (
            resolve_model_settings_workspace_id(&data, workspace_id),
            is_per_repo(&data),
        )
    };
    if !per_repo {
        return update_runtime(
            kernel,
            &target,
            UpdateOptions::default(),
            global_method,
            vec![value],
        )
        .await;
    }
    kernel.initialize().await;
    let Some(ws) = workspace_ref(kernel, &target) else {
        return unknown_workspace(kernel, &target).await;
    };
    with_error_handling(kernel, async {
        let snapshot =
            runtime_snapshot(kernel, project_method, vec![Some(json!(ws)), value]).await?;
        record_settings_self_write(kernel).await;
        kernel
            .data
            .borrow_mut()
            .runtime_by_workspace
            .insert(ws.workspace_id.clone(), snapshot);
        refresh_clearing_error(kernel).await
    })
    .await
}

/// `loginProvider`.
pub async fn login_provider(
    kernel: &Kernel,
    workspace_id: &str,
    provider_id: &str,
    callbacks: Rc<dyn LoginCallbacks>,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let target = resolve_model_settings_workspace_id(&kernel.data.borrow(), workspace_id);
    let Some(ws) = workspace_ref(kernel, workspace_id) else {
        return unknown_workspace(kernel, workspace_id).await;
    };
    with_error_handling(kernel, async {
        let value = kernel.driver().login(&ws, provider_id, callbacks).await?;
        let snapshot: RuntimeSnapshot = serde_json::from_value(value).map_err(|error| {
            CoreError::new(format!("pi returned an unexpected login result: {error}"))
        })?;
        kernel
            .data
            .borrow_mut()
            .runtime_by_workspace
            .insert(workspace_id.to_owned(), snapshot.clone());
        auto_enable_models_for_connected_provider(kernel, &target, provider_id, &snapshot).await?;
        refresh_session_commands_for_workspace(kernel, workspace_id).await?;
        refresh_clearing_error(kernel).await
    })
    .await
}

/// `mergeEnabledModelPatterns`.
fn merge_enabled_model_patterns(existing: &[String], provider: &[String]) -> Vec<String> {
    let mut merged = existing.to_vec();
    for pattern in provider {
        if !merged.contains(pattern) {
            merged.push(pattern.clone());
        }
    }
    merged
}

/// `autoEnableModelsForConnectedProvider`: a newly connected provider's models join an
/// enabled-model list the user has narrowed; an empty list already means every model.
async fn auto_enable_models_for_connected_provider(
    kernel: &Kernel,
    workspace_id: &str,
    provider_id: &str,
    snapshot: &RuntimeSnapshot,
) -> CoreResult<()> {
    let mut provider_patterns: Vec<String> = Vec::new();
    for model in &snapshot.models {
        if model.available && model.provider_id == provider_id {
            let pattern = format!("{}/{}", model.provider_id, model.model_id);
            if !provider_patterns.contains(&pattern) {
                provider_patterns.push(pattern);
            }
        }
    }
    if provider_patterns.is_empty() {
        return Ok(());
    }
    let current = &snapshot.settings.enabled_model_patterns;
    if current.is_empty() {
        return Ok(());
    }
    let next = merge_enabled_model_patterns(current, &provider_patterns);
    if next.len() == current.len() {
        return Ok(());
    }
    let (Some(owner), per_repo) = (
        workspace_ref(kernel, workspace_id),
        is_per_repo(&kernel.data.borrow()),
    ) else {
        return Ok(());
    };
    let method = if per_repo {
        "setProjectScopedModelPatterns"
    } else {
        "setScopedModelPatterns"
    };
    let updated = runtime_snapshot(kernel, method, args([json!(owner), json!(next)])).await?;
    kernel
        .data
        .borrow_mut()
        .runtime_by_workspace
        .insert(workspace_id.to_owned(), updated);
    Ok(())
}

/// `listCustomProviders`: only the fields the renderer shows.
pub async fn list_custom_providers(kernel: &Kernel) -> CoreResult<Value> {
    kernel.initialize().await;
    let entries: Vec<Value> =
        runtime_call(kernel.driver(), "listCustomProviders", Vec::new()).await?;
    Ok(Value::Array(
        entries
            .iter()
            .map(|entry| {
                let mut config = Map::new();
                config.insert("providerId".into(), entry["providerId"].clone());
                config.insert("baseUrl".into(), entry["baseUrl"].clone());
                if let Some(api_key) = entry.get("apiKey") {
                    config.insert("apiKey".into(), api_key.clone());
                }
                let models = entry["models"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|model| {
                        let mut out = Map::new();
                        out.insert("id".into(), model["id"].clone());
                        if let Some(window) = model.get("contextWindow") {
                            out.insert("contextWindow".into(), window.clone());
                        }
                        Value::Object(out)
                    })
                    .collect();
                config.insert("models".into(), Value::Array(models));
                Value::Object(config)
            })
            .collect(),
    ))
}

/// `setExtensionEnabled`: pi-gui's own built-ins are switched app-wide; pi's add-ons
/// (`builtin:mcp` …) in pi's global settings, which every workspace reads.
pub async fn set_extension_enabled(
    kernel: &Kernel,
    workspace_id: &str,
    file_path: &str,
    enabled: bool,
) -> CoreResult<DesktopAppState> {
    let builtin: Option<String> = runtime_call(
        kernel.driver(),
        "builtinExtensionName",
        args([json!(file_path)]),
    )
    .await?;
    if let Some(name) = builtin.filter(|name| !name.is_empty()) {
        return set_builtin_extension_enabled(kernel, workspace_id, &name, enabled).await;
    }
    let global = file_path.starts_with("builtin:");
    update_runtime(
        kernel,
        workspace_id,
        UpdateOptions {
            reload_sessions: true,
            refresh_all_workspaces: global,
        },
        "setExtensionEnabled",
        vec![Some(json!(file_path)), Some(json!(enabled))],
    )
    .await
}

/// `setBuiltinExtensionEnabled`: the switch lives in ui-state, which new sessions read, so
/// a change that cannot be saved is undone.
async fn set_builtin_extension_enabled(
    kernel: &Kernel,
    workspace_id: &str,
    name: &str,
    enabled: bool,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(ws) = workspace_ref(kernel, workspace_id) else {
        return unknown_workspace(kernel, workspace_id).await;
    };
    let set_disabled = |disabled: bool| {
        let mut data = kernel.data.borrow_mut();
        if disabled {
            data.disabled_builtin_extensions.insert(name.to_owned());
        } else {
            data.disabled_builtin_extensions.remove(name);
        }
    };
    let was_disabled = kernel
        .data
        .borrow()
        .disabled_builtin_extensions
        .contains(name);
    set_disabled(!enabled);
    if let Err(error) = persist::persist_ui_state(kernel).await {
        set_disabled(was_disabled);
        return super::super::sessions::with_core_error(kernel, error).await;
    }
    with_error_handling(kernel, async {
        let snapshot = super::refresh_runtime_snapshot(kernel, &ws).await?;
        refresh_runtime_for_all_workspaces(kernel, workspace_id, snapshot).await;
        let reloaded = reload_open_sessions(kernel, &all_workspace_ids(kernel)).await;
        refresh_session_commands_for_all_workspaces(kernel).await;
        let state = refresh_clearing_error(kernel).await?;
        reloaded_or(
            kernel,
            reloaded,
            state,
            "Some open threads could not reload; they pick up the pi-gui tools change when reopened.",
        )
        .await
    })
    .await
}

/// Shows a path under the home folder as `~/…`, as pi's docs and terminal name it.
fn with_home_as_tilde(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let separator = std::path::MAIN_SEPARATOR;
    match path.strip_prefix(&format!("{home}{separator}")) {
        Some(rest) if !home.is_empty() => format!("~{separator}{rest}"),
        _ => path.to_owned(),
    }
}

/// `listMcpServers`.
pub async fn list_mcp_servers(kernel: &Kernel, workspace_id: &str) -> CoreResult<Value> {
    kernel.initialize().await;
    let ws = workspace_ref(kernel, workspace_id)
        .ok_or_else(|| CoreError::new(format!("Unknown workspace: {workspace_id}")))?;
    let listing: Value = runtime_call(kernel.driver(), "listMcpServers", args([json!(ws)])).await?;
    let always_on: bool =
        runtime_call(kernel.driver(), "getCodemodeAlwaysOn", args([json!(ws)])).await?;
    Ok(json!({
        "globalConfigPath": with_home_as_tilde(listing["globalConfigPath"].as_str().unwrap_or_default()),
        "servers": listing["servers"],
        "errors": listing["errors"],
        "codemodeAlwaysOn": always_on,
    }))
}

/// `withMcpConfigChange`: pi reads mcp.json when a thread starts, so open threads reload
/// (restarting their MCP servers): every workspace's for the global file, else only the
/// workspace whose `.pi/mcp.json` changed. Threads mid-turn reload when the turn ends.
async fn with_mcp_config_change<F, Fut>(
    kernel: &Kernel,
    workspace_id: &str,
    global: bool,
    change: F,
) -> CoreResult<DesktopAppState>
where
    F: FnOnce(WorkspaceRef) -> Fut,
    Fut: Future<Output = CoreResult<Option<Value>>>,
{
    kernel.initialize().await;
    let Some(ws) = workspace_ref(kernel, workspace_id) else {
        return unknown_workspace(kernel, workspace_id).await;
    };
    with_error_handling(kernel, async {
        change(ws).await?;
        let ids = if global {
            all_workspace_ids(kernel)
        } else {
            vec![workspace_id.to_owned()]
        };
        let reloaded = reload_open_sessions(kernel, &ids).await;
        for result in futures_join_all(
            ids.iter()
                .map(|id| refresh_session_commands_for_workspace(kernel, id)),
        )
        .await
        {
            result?;
        }
        let state = refresh_clearing_error(kernel).await?;
        reloaded_or(
            kernel,
            reloaded,
            state,
            "Some open threads could not reload; they pick up the MCP change when reopened.",
        )
        .await
    })
    .await
}

/// `addMcpServer`: the global file reaches every folder, so a clash with any folder's
/// project file counts.
pub async fn add_mcp_server(
    kernel: &Kernel,
    workspace_id: &str,
    server: Value,
) -> CoreResult<DesktopAppState> {
    with_mcp_config_change(kernel, workspace_id, true, |ws| async move {
        let others: Vec<WorkspaceRef> = {
            let data = kernel.data.borrow();
            data.state
                .workspaces
                .iter()
                .filter_map(|workspace| data.workspace_ref(&workspace.id))
                .filter(|other| other.workspace_id != ws.workspace_id)
                .collect()
        };
        kernel
            .driver()
            .runtime("addMcpServer", args([json!(ws), server, json!(others)]))
            .await
    })
    .await
}

pub async fn remove_mcp_server(
    kernel: &Kernel,
    workspace_id: &str,
    name: &str,
) -> CoreResult<DesktopAppState> {
    with_mcp_config_change(kernel, workspace_id, true, |_| {
        kernel
            .driver()
            .runtime("removeMcpServer", args([json!(name)]))
    })
    .await
}

pub async fn set_mcp_server_enabled(
    kernel: &Kernel,
    workspace_id: &str,
    scope: &str,
    name: &str,
    enabled: bool,
) -> CoreResult<DesktopAppState> {
    with_mcp_config_change(kernel, workspace_id, scope == "global", |ws| {
        kernel.driver().runtime(
            "setMcpServerEnabled",
            args([json!(ws), json!(scope), json!(name), json!(enabled)]),
        )
    })
    .await
}

/// `setCodemodeAlwaysOn`: writes `+codemode` in pi's `defaultTools`. pi's reload turns on
/// tools newly added there but leaves removed ones on, so only switching on reloads open
/// threads (a thread mid-turn picks it up when it ends).
pub async fn set_codemode_always_on(
    kernel: &Kernel,
    workspace_id: &str,
    always_on: bool,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(ws) = workspace_ref(kernel, workspace_id) else {
        return unknown_workspace(kernel, workspace_id).await;
    };
    with_error_handling(kernel, async {
        kernel
            .driver()
            .runtime("setCodemodeAlwaysOn", args([json!(ws), json!(always_on)]))
            .await?;
        record_settings_self_write(kernel).await;
        let reloaded = if always_on {
            reload_open_sessions(kernel, &all_workspace_ids(kernel)).await
        } else {
            true
        };
        let state = refresh_clearing_error(kernel).await?;
        reloaded_or(
            kernel,
            reloaded,
            state,
            "Some open threads could not reload; they get code mode when reopened.",
        )
        .await
    })
    .await
}

/// `getSkillFilePath` / `getExtensionFilePath`: a path the workspace's runtime lists.
pub fn owned_file_path(
    kernel: &Kernel,
    workspace_id: &str,
    file_path: &str,
    skill: bool,
) -> Option<String> {
    let data = kernel.data.borrow();
    let runtime = data.runtime_by_workspace.get(workspace_id)?;
    if skill {
        runtime
            .skills
            .iter()
            .find(|entry| entry.file_path == file_path)
            .map(|entry| entry.file_path.clone())
    } else {
        runtime
            .extensions
            .iter()
            .find(|entry| entry.path == file_path)
            .map(|entry| entry.path.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_patterns_join_after_existing_ones() {
        let merged = merge_enabled_model_patterns(
            &["a/x".into(), "b/y".into()],
            &["b/y".into(), "b/z".into()],
        );
        assert_eq!(merged, ["a/x", "b/y", "b/z"]);
    }
}
