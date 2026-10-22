//! The renderer's settings methods, dispatched as `register-desktop-ipc.ts` does: argument
//! checks, then the action on the sender's view.

use super::login::WindowLoginCallbacks;
use super::runtime::{self, UpdateOptions};
use crate::app::dispatch::{self, MethodTable, Reply};
use crate::app::validation::{
    expect_boolean, expect_custom_provider_config, expect_custom_provider_probe_input,
    expect_mcp_server_scope, expect_model_settings_scope_mode, expect_new_mcp_server_input,
    expect_non_empty_string, expect_optional_string, expect_optional_thinking_level, expect_string,
    expect_string_array,
};
use crate::app::Kernel;
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::ModelSettingsScopeMode;
use serde_json::{json, Value};
use std::path::Path;
use std::rc::Rc;

pub fn register(table: &mut MethodTable) {
    table.on("refreshRuntime", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_optional_string(call.arg(0), "workspaceId")?;
                runtime::refresh_runtime(&kernel, workspace_id).await
            })
            .await
        })
    });
    table.on("setModelSettingsScopeMode", |kernel, call| {
        Box::pin(async move {
            let mode = match expect_model_settings_scope_mode(call.arg(0))?.as_str() {
                "per-repo" => ModelSettingsScopeMode::PerRepo,
                _ => ModelSettingsScopeMode::AppGlobal,
            };
            dispatch::run(&kernel, &call, || {
                runtime::set_model_settings_scope_mode(&kernel, mode)
            })
            .await
        })
    });
    table.on("setDefaultModel", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let provider = expect_non_empty_string(call.arg(1), "provider")?;
                let model_id = expect_non_empty_string(call.arg(2), "modelId")?;
                runtime::set_model_setting(
                    &kernel,
                    &workspace_id,
                    "setDefaultModel",
                    "setProjectDefaultModel",
                    Some(json!({ "provider": provider, "modelId": model_id })),
                )
                .await
            })
            .await
        })
    });
    table.on("setDefaultThinkingLevel", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let level = expect_optional_thinking_level(call.arg(1))?;
                runtime::set_model_setting(
                    &kernel,
                    &workspace_id,
                    "setDefaultThinkingLevel",
                    "setProjectDefaultThinkingLevel",
                    level.map(Value::String),
                )
                .await
            })
            .await
        })
    });
    table.on("setScopedModelPatterns", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let patterns = expect_string_array(call.arg(1), "patterns")?;
                runtime::set_model_setting(
                    &kernel,
                    &workspace_id,
                    "setScopedModelPatterns",
                    "setProjectScopedModelPatterns",
                    Some(json!(patterns)),
                )
                .await
            })
            .await
        })
    });
    table.on("loginProvider", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            dispatch::unscoped(&kernel, &call, async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let provider_id = expect_non_empty_string(call.arg(1), "providerId")?;
                let callbacks = Rc::new(WindowLoginCallbacks {
                    kernel: kernel.clone(),
                    window: Some(window),
                });
                runtime::login_provider(&kernel, &workspace_id, &provider_id, callbacks).await
            })
            .await
        })
    });
    table.on("logoutProvider", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let provider_id = expect_non_empty_string(call.arg(1), "providerId")?;
                runtime::update_runtime(
                    &kernel,
                    &workspace_id,
                    UpdateOptions::default(),
                    "logout",
                    vec![Some(json!(provider_id))],
                )
                .await
            })
            .await
        })
    });
    table.on("setProviderApiKey", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let provider_id = expect_non_empty_string(call.arg(1), "providerId")?;
                let api_key = expect_string(call.arg(2), "apiKey")?;
                runtime::update_runtime(
                    &kernel,
                    &workspace_id,
                    UpdateOptions::default(),
                    "setProviderApiKey",
                    vec![Some(json!(provider_id)), Some(json!(api_key))],
                )
                .await
            })
            .await
        })
    });
    table.on("listCustomProviders", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(Reply::Value(runtime::list_custom_providers(&kernel).await?))
        })
    });
    table.on("setCustomProvider", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let config = expect_custom_provider_config(call.arg(1))?;
                runtime::update_runtime(
                    &kernel,
                    &workspace_id,
                    UpdateOptions {
                        refresh_all_workspaces: true,
                        ..Default::default()
                    },
                    "setCustomProvider",
                    vec![Some(config)],
                )
                .await
            })
            .await
        })
    });
    table.on("deleteCustomProvider", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let provider_id = expect_non_empty_string(call.arg(1), "providerId")?;
                runtime::update_runtime(
                    &kernel,
                    &workspace_id,
                    UpdateOptions {
                        refresh_all_workspaces: true,
                        ..Default::default()
                    },
                    "deleteCustomProvider",
                    vec![Some(json!(provider_id))],
                )
                .await
            })
            .await
        })
    });
    table.on("probeCustomProviderModels", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let input = expect_custom_provider_probe_input(call.arg(0))?;
            let result = kernel.driver().probe_custom_provider_models(input).await?;
            Ok(Reply::Value(result))
        })
    });
    table.on("setEnableSkillCommands", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let enabled = expect_boolean(call.arg(1), "enabled")?;
                runtime::update_runtime(
                    &kernel,
                    &workspace_id,
                    UpdateOptions {
                        reload_sessions: true,
                        ..Default::default()
                    },
                    "setEnableSkillCommands",
                    vec![Some(json!(enabled))],
                )
                .await
            })
            .await
        })
    });
    table.on("setSkillEnabled", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let file_path = expect_non_empty_string(call.arg(1), "filePath")?;
                let enabled = expect_boolean(call.arg(2), "enabled")?;
                runtime::update_runtime(
                    &kernel,
                    &workspace_id,
                    UpdateOptions {
                        reload_sessions: true,
                        ..Default::default()
                    },
                    "setSkillEnabled",
                    vec![Some(json!(file_path)), Some(json!(enabled))],
                )
                .await
            })
            .await
        })
    });
    table.on("setExtensionEnabled", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let file_path = expect_non_empty_string(call.arg(1), "filePath")?;
                let enabled = expect_boolean(call.arg(2), "enabled")?;
                runtime::set_extension_enabled(&kernel, &workspace_id, &file_path, enabled).await
            })
            .await
        })
    });
    table.on("listMcpServers", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
            Ok(Reply::Value(
                runtime::list_mcp_servers(&kernel, &workspace_id).await?,
            ))
        })
    });
    table.on("addMcpServer", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let server = expect_new_mcp_server_input(call.arg(1))?;
                runtime::add_mcp_server(&kernel, &workspace_id, server).await
            })
            .await
        })
    });
    table.on("removeMcpServer", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let name = expect_non_empty_string(call.arg(1), "name")?;
                runtime::remove_mcp_server(&kernel, &workspace_id, &name).await
            })
            .await
        })
    });
    table.on("setMcpServerEnabled", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let scope = expect_mcp_server_scope(call.arg(1))?;
                let name = expect_non_empty_string(call.arg(2), "name")?;
                let enabled = expect_boolean(call.arg(3), "enabled")?;
                runtime::set_mcp_server_enabled(&kernel, &workspace_id, &scope, &name, enabled)
                    .await
            })
            .await
        })
    });
    table.on("setCodemodeAlwaysOn", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
                let always_on = expect_boolean(call.arg(1), "alwaysOn")?;
                runtime::set_codemode_always_on(&kernel, &workspace_id, always_on).await
            })
            .await
        })
    });
    table.on("openSkillInFinder", |kernel, call| {
        Box::pin(async move { open_owned_file_in_finder(&kernel, &call, true).await })
    });
    table.on("openExtensionInFinder", |kernel, call| {
        Box::pin(async move { open_owned_file_in_finder(&kernel, &call, false).await })
    });
}

/// `openOwnedFileInFinder`: opens the folder of a skill or extension the workspace's runtime
/// lists, and nothing else.
async fn open_owned_file_in_finder(
    kernel: &Rc<Kernel>,
    call: &dispatch::InvokeCall,
    skill: bool,
) -> CoreResult<Reply> {
    dispatch::sender(kernel, call)?;
    let workspace_id = expect_non_empty_string(call.arg(0), "workspaceId")?;
    let file_path = expect_non_empty_string(call.arg(1), "filePath")?;
    let Some(resolved) = runtime::owned_file_path(kernel, &workspace_id, &file_path, skill) else {
        let kind = if skill { "skill" } else { "extension" };
        return Err(CoreError::new(format!("Unknown {kind}: {file_path}")));
    };
    let folder = Path::new(&resolved)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    kernel.shell().reveal_path(folder, true).await?;
    Ok(Reply::Undefined)
}
