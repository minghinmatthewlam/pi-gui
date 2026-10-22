//! A folder's files for the side panel: the file list and previews, changed files and their
//! diffs, staging, and revealing a file (`registerWorkspaceFileIpc`). Git and file reads run in
//! the core's `workspaceFiles.*` calls; the kernel resolves the folder and checks the sender.

use super::super::dispatch::{self, MethodTable, Reply};
use super::super::validation;
use super::workspace_path;
use crate::error::{CoreError, CoreResult};
use crate::methods;
use serde_json::{json, Value};

pub fn register(table: &mut MethodTable) {
    table.on("listWorkspaceFiles", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let workspace_id = validation::expect_non_empty_string(call.arg(0), "workspaceId")?;
            let Some(path) = workspace_path(&kernel, &workspace_id) else {
                return Ok(Reply::Value(json!([])));
            };
            let mut params = json!({ "workspacePath": path });
            if let Some(Value::Object(options)) =
                validation::expect_workspace_file_list_options(call.arg(1))?
            {
                params
                    .as_object_mut()
                    .expect("params are an object")
                    .extend(options);
            }
            let files = kernel
                .core_call(methods::WORKSPACE_FILES_LIST, params)
                .await?;
            Ok(Reply::Value(files))
        })
    });
    table.on("readWorkspaceFile", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let path = known_workspace_path(&kernel, call.arg(0))?;
            let file_path = validation::expect_string(call.arg(1), "filePath")?;
            let preview = kernel
                .core_call(
                    methods::WORKSPACE_FILES_READ,
                    json!({ "workspacePath": path, "filePath": file_path }),
                )
                .await?;
            Ok(Reply::Value(preview))
        })
    });
    table.on("revealWorkspaceFile", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let path = known_workspace_path(&kernel, call.arg(0))?;
            let file_path = validation::expect_string(call.arg(1), "filePath")?;
            let resolved = crate::paths::resolve_existing_workspace_path(&path, &file_path).await?;
            kernel.shell().reveal_path(resolved, false).await?;
            Ok(Reply::Undefined)
        })
    });
    table.on("getChangedFiles", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let workspace_id = validation::expect_non_empty_string(call.arg(0), "workspaceId")?;
            let Some(path) = workspace_path(&kernel, &workspace_id) else {
                return Ok(Reply::Value(json!({
                    "state": "unavailable",
                    "error": {
                        "code": "workspace-unavailable",
                        "message":
                            "Changed files are unavailable because this workspace could not be found.",
                    },
                })));
            };
            let changed = kernel
                .core_call(
                    methods::WORKSPACE_FILES_CHANGED,
                    json!({ "workspacePath": path }),
                )
                .await?;
            Ok(Reply::Value(changed))
        })
    });
    table.on("getFileDiff", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let workspace_id = validation::expect_non_empty_string(call.arg(0), "workspaceId")?;
            let Some(path) = workspace_path(&kernel, &workspace_id) else {
                return Ok(Reply::Value(json!("")));
            };
            let file_path = validation::expect_string(call.arg(1), "filePath")?;
            let diff = kernel
                .core_call(
                    methods::WORKSPACE_FILES_DIFF,
                    json!({ "workspacePath": path, "filePath": file_path }),
                )
                .await?;
            Ok(Reply::Value(diff))
        })
    });
    table.on("stageFile", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let path = known_workspace_path(&kernel, call.arg(0))?;
            let file_path = validation::expect_string(call.arg(1), "filePath")?;
            let source_path = validation::expect_optional_string(call.arg(2), "stagingSourcePath")?;
            let mut params = json!({ "workspacePath": path, "filePath": file_path });
            if let Some(source_path) = source_path {
                params["sourcePath"] = json!(source_path);
            }
            kernel
                .core_call(methods::WORKSPACE_FILES_STAGE, params)
                .await?;
            Ok(Reply::Undefined)
        })
    });
}

/// The folder's path, or "Unknown workspace" for a folder the app does not have.
fn known_workspace_path(
    kernel: &super::super::Kernel,
    workspace_id: validation::Arg,
) -> CoreResult<String> {
    let workspace_id = validation::expect_non_empty_string(workspace_id, "workspaceId")?;
    workspace_path(kernel, &workspace_id)
        .ok_or_else(|| CoreError::new(format!("Unknown workspace: {workspace_id}")))
}
