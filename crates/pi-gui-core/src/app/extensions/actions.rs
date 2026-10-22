//! Card buttons (`extensions/app-operations.ts` and main's `runExtensionAction` handler): the
//! app operations an extension's UI can ask for, one per action type, each with its checks.
//! Extension views reach links and threads through their host actions, which use the same
//! checks.

use super::views::reply_state;
use super::{add_notice, parse_extension_url};
use crate::app::dispatch::{self, MethodTable, Reply};
use crate::app::validation;
use crate::app::{conversation, publish, sessions, workspace, Kernel, WindowId};
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::SessionExtensionNoticeRecord;
use crate::state::driver::{NoticeLevel, SessionRef};
use serde_json::{json, Value};
use std::path::Path;
use std::rc::Rc;

pub fn register(table: &mut MethodTable) {
    // Card buttons carry extension-authored data, so only the app's own frame may send them.
    table.on("runExtensionAction", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::main_frame(&kernel, &call, "pi-gui:run-extension-action")?;
            let request = validation::expect_extension_action_request(call.arg(0))?;
            let target: SessionRef = crate::parse(request["target"].clone())?;
            let action = &request["action"];
            require_card_thread(&kernel, window, &target)?;
            match run_card_action(&kernel, window, &target, action).await {
                Ok(effect) => Ok(Reply::Value(effect.unwrap_or(Value::Null))),
                Err(error) => {
                    dispatch::run_for(&kernel, window, || async {
                        Ok(report_action_failure(&kernel, &target, &error))
                    })
                    .await?;
                    Ok(Reply::Value(Value::Null))
                }
            }
        })
    });
}

/// Main may have switched threads before the renderer redrew; never act on another one.
fn require_card_thread(kernel: &Kernel, window: WindowId, target: &SessionRef) -> CoreResult<()> {
    if kernel.windows.target_for_window(kernel, window).as_ref() != Some(target) {
        return Err(CoreError::new(
            "Return to the card's thread to use its buttons",
        ));
    }
    Ok(())
}

/// `runExtensionAction` for a card button: an effect for the renderer, or `None`.
async fn run_card_action(
    kernel: &Rc<Kernel>,
    window: WindowId,
    target: &SessionRef,
    action: &Value,
) -> CoreResult<Option<Value>> {
    match action["type"].as_str().unwrap_or_default() {
        "openFile" => {
            // Only files inside the thread's checkout; the renderer opens the relative path.
            let requested = action["path"].as_str().unwrap_or_default();
            let path = existing_workspace_file(
                kernel,
                target,
                requested,
                "The thread's folder is unavailable",
                |requested| format!("{requested} is not a file"),
            )
            .await?;
            let mut effect = json!({ "kind": "openFile", "path": path });
            if let Some(line) = action["line"].as_u64().filter(|line| *line > 0) {
                effect["line"] = json!(line);
            }
            Ok(Some(effect))
        }
        // Nothing is sent: the renderer adds the text to the draft and the user decides.
        "composer" => Ok(Some(json!({ "kind": "composer", "text": action["text"] }))),
        "url" => open_link(kernel, action).await.map(|()| None),
        "command" => {
            // Like a typed extension command it may change selection, so it keeps the window's
            // queue, and checks the thread again once its turn in that queue comes. A switch
            // drops the composer's debounced draft, so that is saved first, outside the queue.
            kernel.draft_flush.flush(kernel, &[window]).await;
            let command = action["command"].as_str().unwrap_or_default();
            dispatch::run_for(kernel, window, || async {
                require_card_thread(kernel, window, target)?;
                conversation::submit::run_extension_command(kernel, target, command).await
            })
            .await?;
            Ok(None)
        }
        "openThread" => {
            let session_id = action["sessionId"].as_str().unwrap_or_default();
            // Refuse at once, and again in the queue in case the thread was archived meanwhile.
            thread_in_folder(kernel, target, session_id)?;
            kernel.draft_flush.flush(kernel, &[window]).await;
            let reply = dispatch::run_for(kernel, window, || async {
                require_card_thread(kernel, window, target)?;
                let thread = thread_in_folder(kernel, target, session_id)?;
                workspace::select_session(kernel, &thread).await
            })
            .await?;
            if let Some(error) = reply_state(reply).and_then(|state| state.last_error) {
                return Err(CoreError::new(error));
            }
            Ok(None)
        }
        kind => Err(CoreError::new(format!(
            "Unhandled extension action: {kind}"
        ))),
    }
}

/// `reportExtensionActionFailure`: shows why a card button did nothing, as the same toast an
/// extension's notify uses.
fn report_action_failure(
    kernel: &Kernel,
    session_ref: &SessionRef,
    error: &CoreError,
) -> crate::state::desktop_state::DesktopAppState {
    add_notice(
        kernel,
        session_ref,
        SessionExtensionNoticeRecord {
            id: format!("action-failure:{}", kernel.env().random_uuid()),
            level: NoticeLevel::Error,
            message: format!("Couldn't run that button: {}", error.message),
            created_at: kernel.env().now_iso(),
        },
    );
    {
        let mut data = kernel.data.borrow_mut();
        data.bump();
        sessions::sync_derived_session_state(&mut data, session_ref);
    }
    publish::emit(kernel)
}

/// The `url` operation: https links only, opened by the shell.
pub async fn open_link(kernel: &Kernel, action: &Value) -> CoreResult<()> {
    let Some(url) = action["url"].as_str().and_then(parse_extension_url) else {
        return Err(CoreError::new("Extensions can only open https links"));
    };
    kernel.shell().open_external(url).await
}

/// A pi session id an extension may name.
pub fn is_session_id(value: &str) -> bool {
    (1..=200).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `threadInFolder`: the unarchived thread with this pi session id in the target's folder or
/// one of that folder's pi-gui worktrees. Extensions only reach threads the user sees beside
/// their own.
pub fn thread_in_folder(
    kernel: &Kernel,
    target: &SessionRef,
    session_id: &str,
) -> CoreResult<SessionRef> {
    let data = kernel.data.borrow();
    let workspaces = &data.state.workspaces;
    let folder_of = |workspace: &crate::state::desktop_state::WorkspaceRecord| {
        workspace
            .root_workspace_id
            .clone()
            .unwrap_or_else(|| workspace.id.clone())
    };
    let folder = workspaces
        .iter()
        .find(|workspace| workspace.id == target.workspace_id)
        .map(folder_of);
    let thread = folder.and_then(|folder| {
        workspaces
            .iter()
            .filter(|workspace| folder_of(workspace) == folder)
            .find_map(|workspace| {
                workspace
                    .sessions
                    .iter()
                    .find(|session| session.id == session_id && session.archived_at.is_none())
                    .map(|session| crate::state::driver::session_ref(&workspace.id, &session.id))
            })
    });
    thread.ok_or_else(|| CoreError::new("That thread isn't open in this folder"))
}

/// A file inside the thread's checkout, as a path relative to it. `unavailable` is the error
/// when the thread has no folder, and `not_file` the one for a folder or other non-file.
pub async fn existing_workspace_file(
    kernel: &Kernel,
    target: &SessionRef,
    requested: &str,
    unavailable: &str,
    not_file: impl FnOnce(&str) -> String,
) -> CoreResult<String> {
    let Some(workspace_path) = workspace::workspace_path(kernel, &target.workspace_id) else {
        return Err(CoreError::new(unavailable));
    };
    let file_path =
        crate::paths::resolve_existing_workspace_path(&workspace_path, requested).await?;
    let is_file = tokio::fs::metadata(&file_path)
        .await
        .map_err(|error| CoreError::io(&error, &file_path))?
        .is_file();
    if !is_file {
        return Err(CoreError::new(not_file(requested)));
    }
    Ok(relative_path(Path::new(&workspace_path), &file_path))
}

/// `path.relative(workspacePath, filePath)` for a file inside the folder, whose real path may
/// differ from the folder path by a symlink.
fn relative_path(workspace_path: &Path, file_path: &Path) -> String {
    let root = crate::paths::absolute(workspace_path);
    if let Ok(relative) = file_path.strip_prefix(&root) {
        return crate::paths::display(relative);
    }
    crate::paths::realpath(&root)
        .ok()
        .and_then(|real_root| {
            file_path
                .strip_prefix(real_root)
                .ok()
                .map(crate::paths::display)
        })
        .unwrap_or_else(|| crate::paths::display(file_path))
}
