//! Folders, threads and worktrees (`workspace/app-store-workspace.ts`,
//! `workspace/app-store-worktree.ts`, `workspace/extension-flags.ts`). So far: adding, picking
//! and selecting folders, creating, selecting and starting threads, and the worktree catalog
//! sync every refresh uses. The rest answers "not ported".

use super::dispatch::{self, MethodTable, Reply};
use super::pi::args;
use super::refresh::{self, RefreshOptions};
use super::shell::PickPaths;
use super::{conversation, persist, publish, sessions, settings, Kernel, WorktreesSnapshot};
use crate::error::{CoreError, CoreResult};
use crate::persistence::catalog::{WorkspaceEntry, WorktreeEntry};
use crate::state::desktop_state::{AppView, ComposerAttachment, DesktopAppState};
use crate::state::driver::{
    session_key, ExtensionFlagValue, ExtensionFlagValues, RuntimeFlagType, SessionRef,
    SessionSnapshot, WorkspaceRef,
};
use crate::state::session_state::NEW_THREAD_PLACEHOLDER_TITLE;
use crate::state::session_state_map::PendingAutoTitle;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::rc::Rc;

/// What the workspace part keeps besides the shared state.
#[derive(Default)]
pub struct WorkspaceState {}

pub fn register(table: &mut MethodTable) {
    table.on("addWorkspacePath", |kernel, call| {
        Box::pin(async move {
            let path = call.arg(0).cloned();
            dispatch::run(&kernel, &call, || async {
                let path =
                    super::validation::expect_non_empty_string(path.as_ref(), "workspacePath")?;
                add_workspace(&kernel, &path).await
            })
            .await
        })
    });
    table.on("pickWorkspace", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            pick_workspace(&kernel, window).await.map(Reply::from)
        })
    });
    table.on("selectWorkspace", |kernel, call| {
        Box::pin(async move {
            let id = call.arg(0).cloned();
            dispatch::run(&kernel, &call, || async {
                let id = super::validation::expect_non_empty_string(id.as_ref(), "workspaceId")?;
                select_workspace(&kernel, &id).await
            })
            .await
        })
    });
    table.on("openWorkspaceInFinder", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let workspace_id =
                super::validation::expect_non_empty_string(call.arg(0), "workspaceId")?;
            let path = workspace_path(&kernel, &workspace_id)
                .ok_or_else(|| CoreError::new(format!("Unknown workspace: {workspace_id}")))?;
            kernel
                .shell()
                .reveal_path(PathBuf::from(path), true)
                .await?;
            Ok(Reply::Undefined)
        })
    });
    table.on("selectSession", |kernel, call| {
        Box::pin(async move {
            let target = super::validation::expect_session_target(call.arg(0), "target")?;
            dispatch::run(&kernel, &call, || select_session(&kernel, &target)).await
        })
    });
    table.on("createSession", |kernel, call| {
        Box::pin(async move {
            let input = call.arg(0).cloned();
            dispatch::run(&kernel, &call, || async {
                let input = super::validation::expect_create_session_input(input.as_ref())?;
                create_session(&kernel, &input).await
            })
            .await
        })
    });
    table.on("startThread", |kernel, call| {
        Box::pin(async move {
            let input = super::validation::expect_start_thread_input(call.arg(0))?;
            if let Some(Value::Array(attachments)) = input.get("attachments") {
                if !attachments.is_empty() {
                    conversation::attachments::assert_pixels(attachments)?;
                }
            }
            dispatch::run(&kernel, &call, || start_thread(&kernel, input)).await
        })
    });
}

/// `getWorkspacePath`.
pub fn workspace_path(kernel: &Kernel, workspace_id: &str) -> Option<String> {
    kernel
        .data
        .borrow()
        .state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .map(|workspace| workspace.path.clone())
}

/// `addWorkspace`.
pub async fn add_workspace(kernel: &Kernel, path: &str) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let normalized = crate::js::trim(path).to_owned();
    if normalized.is_empty() {
        return Ok(publish::emit(kernel));
    }
    let (had_no_workspaces, existing, selected_session_id) = {
        let state = &kernel.data.borrow().state;
        (
            state.workspaces.is_empty(),
            state
                .workspaces
                .iter()
                .find(|workspace| workspace.path == normalized)
                .map(|workspace| workspace.id.clone()),
            state.selected_session_id.clone(),
        )
    };
    if let Some(existing) = existing {
        return sync_workspace(
            kernel,
            &existing,
            RefreshOptions {
                selected_workspace_id: Some(existing.clone()),
                selected_session_id: Some(selected_session_id),
                clear_last_error: true,
                refresh_worktrees: true,
                ..Default::default()
            },
        )
        .await;
    }
    sessions::with_error_handling(kernel, async {
        let synced = sessions::sync_workspace(kernel, &normalized, None).await?;
        let first = synced
            .sessions
            .first()
            .map(|entry| entry.session_ref.clone());
        if let Some(first) = &first {
            Box::pin(sessions::ensure_session_ready(kernel, first)).await?;
        }
        if had_no_workspaces {
            let snapshot = settings::refresh_runtime_snapshot(kernel, &synced.workspace).await?;
            kernel
                .data
                .borrow_mut()
                .runtime_by_workspace
                .insert(synced.workspace.workspace_id.clone(), snapshot);
        }
        refresh::refresh_state(
            kernel,
            RefreshOptions {
                selected_workspace_id: Some(synced.workspace.workspace_id.clone()),
                selected_session_id: Some(first.map(|first| first.session_id).unwrap_or_default()),
                composer_draft: Some(String::new()),
                clear_last_error: true,
                refresh_worktrees: true,
                ..Default::default()
            },
        )
        .await
    })
    .await
}

/// `pickWorkspaceViaDialog` and `addPickedWorkspace`.
pub async fn pick_workspace(
    kernel: &Kernel,
    window: super::WindowId,
) -> CoreResult<DesktopAppState> {
    let picked = kernel
        .shell()
        .pick_paths(
            Some(window),
            PickPaths {
                title: Some("Open workspace folder".into()),
                directories: true,
                multiple: false,
            },
        )
        .await?;
    let Some(path) = picked.and_then(|paths| paths.into_iter().next()) else {
        kernel.initialize().await;
        let view = kernel.windows.view_for_window(kernel, window);
        return Ok(publish::state_for_view(kernel, &view));
    };
    let path = path.to_string_lossy().into_owned();
    match dispatch::run_for(kernel, window, || async {
        let next = add_workspace(kernel, &path).await?;
        if next.selected_workspace_id.is_empty() {
            return Ok(next);
        }
        let new_thread = if next.active_view == AppView::NewThread {
            next.clone()
        } else {
            super::ui::set_active_view(kernel, AppView::NewThread).await?
        };
        publish::send_to(
            kernel,
            window,
            super::methods::push::WORKSPACE_PICKED,
            &next.selected_workspace_id,
        );
        Ok(new_thread)
    })
    .await?
    {
        Reply::State(state) => Ok(*state),
        _ => unreachable!("run_for answers a state"),
    }
}

/// `selectWorkspace`.
pub async fn select_workspace(kernel: &Kernel, workspace_id: &str) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let (known, selected_workspace_id, selected_session_id) = {
        let state = &kernel.data.borrow().state;
        (
            state
                .workspaces
                .iter()
                .any(|workspace| workspace.id == workspace_id),
            state.selected_workspace_id.clone(),
            state.selected_session_id.clone(),
        )
    };
    if !known {
        return Ok(publish::emit(kernel));
    }
    let current = kernel.data.borrow().selected_session_ref();
    if let Some(current) = current.filter(|current| current.workspace_id != workspace_id) {
        sessions::cancel_pending_dialogs_for_session(kernel, &current, false).await?;
    }
    sync_workspace(
        kernel,
        workspace_id,
        RefreshOptions {
            selected_workspace_id: Some(workspace_id.to_owned()),
            selected_session_id: Some(if selected_workspace_id == workspace_id {
                selected_session_id
            } else {
                String::new()
            }),
            clear_last_error: true,
            refresh_worktrees: true,
            active_view: Some(AppView::Threads),
            ..Default::default()
        },
    )
    .await
}

/// `selectSession`.
pub async fn select_session(kernel: &Kernel, target: &SessionRef) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let current = kernel.data.borrow().selected_session_ref();
    if let Some(current) = current.filter(|current| current != target) {
        sessions::cancel_pending_dialogs_for_session(kernel, &current, false).await?;
    }
    sessions::select_session_fast(kernel, target).await
}

/// `syncWorkspace`: rescans the folder's sessions, then refreshes.
async fn sync_workspace(
    kernel: &Kernel,
    workspace_id: &str,
    options: RefreshOptions,
) -> CoreResult<DesktopAppState> {
    let workspace = {
        let state = &kernel.data.borrow().state;
        state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .map(|workspace| (workspace.path.clone(), workspace.name.clone()))
    };
    let Some((path, name)) = workspace else {
        return Ok(publish::emit(kernel));
    };
    sessions::with_error_handling(kernel, async {
        sessions::sync_workspace(kernel, &path, Some(&name)).await?;
        refresh::refresh_state(kernel, options).await
    })
    .await
}

/// `setActiveSession`: selects the thread before the refresh that shows it.
pub(crate) fn set_active_session(kernel: &Kernel, session_ref: &SessionRef) {
    let mut data = kernel.data.borrow_mut();
    data.state.selected_workspace_id = session_ref.workspace_id.clone();
    data.state.selected_session_id = session_ref.session_id.clone();
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionInput {
    workspace_id: String,
    title: Option<String>,
}

/// `createSession`.
pub async fn create_session(kernel: &Kernel, input: &Value) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let input: CreateSessionInput = crate::parse(input.clone())?;
    let Some(workspace) = kernel.data.borrow().workspace_ref(&input.workspace_id) else {
        return sessions::with_error(kernel, format!("Unknown workspace: {}", input.workspace_id))
            .await;
    };
    sessions::with_error_handling(kernel, async {
        let mut options = settings::build_create_session_options(kernel, &input.workspace_id)
            .await?
            .unwrap_or_default();
        let title = input
            .title
            .as_deref()
            .map(crate::js::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(NEW_THREAD_PLACEHOLDER_TITLE);
        options.insert("title".into(), json!(title));
        let snapshot: SessionSnapshot = super::pi::driver_call(
            kernel.driver(),
            "createSession",
            args([json!(workspace), Value::Object(options)]),
        )
        .await?;
        sessions::seed_session(&mut kernel.data.borrow_mut(), &snapshot);
        set_active_session(kernel, &snapshot.session_ref);
        refresh::refresh_state(
            kernel,
            RefreshOptions {
                selected_workspace_id: Some(snapshot.session_ref.workspace_id.clone()),
                selected_session_id: Some(snapshot.session_ref.session_id.clone()),
                composer_draft: Some(String::new()),
                clear_last_error: true,
                active_view: Some(AppView::Threads),
                ..Default::default()
            },
        )
        .await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartThreadInput {
    root_workspace_id: String,
    environment: String,
    prompt: Option<String>,
    #[serde(default)]
    attachments: Vec<ComposerAttachment>,
    provider: Option<String>,
    model_id: Option<String>,
    thinking_level: Option<String>,
    extension_flags: Option<ExtensionFlagValues>,
}

/// `startThread`: creates the thread (in a new worktree when asked), shows it, then sends the
/// prompt and names the thread in the background.
pub async fn start_thread(kernel: &Kernel, input: Value) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let input: StartThreadInput = crate::parse(input)?;
    let Some(root) = kernel.data.borrow().workspace_ref(&input.root_workspace_id) else {
        return sessions::with_error(
            kernel,
            format!("Unknown workspace: {}", input.root_workspace_id),
        )
        .await;
    };
    sessions::with_error_handling(kernel, async {
        // Checked against the folder the user chose the flags in; a new worktree has the
        // same committed extensions.
        let (chosen, applied) = resolve_extension_flags(
            kernel,
            &input.root_workspace_id,
            input.extension_flags.as_ref(),
        )
        .await?;
        let mut target = root.clone();
        let mut rollback: Option<Value> = None;
        if input.environment == "worktree" {
            let options = build_worktree_options(kernel, &root, input.prompt.as_deref());
            let created: WorktreeEntry = crate::parse(
                kernel
                    .core_call(
                        crate::methods::WORKTREES_CREATE,
                        json!({
                            "workspace": root,
                            "path": options.path,
                            "displayName": options.display_name,
                            "branchName": options.branch_name,
                            "startPoint": "HEAD",
                        }),
                    )
                    .await?,
            )?;
            let destroy = json!({
                "workspace": root,
                "path": options.path,
                "branchName": options.branch_name,
            });
            match sessions::sync_workspace(kernel, &created.path, Some(&created.display_name)).await
            {
                Ok(synced) => target = synced.workspace,
                Err(error) => {
                    rollback_worktree(kernel, destroy).await;
                    return Err(error);
                }
            }
            rollback = Some(destroy);
        }
        let prompt = input
            .prompt
            .as_deref()
            .map(crate::js::trim)
            .unwrap_or("")
            .to_owned();
        let created = async {
            let mut options = settings::build_create_session_options(kernel, &target.workspace_id)
                .await?
                .unwrap_or_default();
            let initial_model = match (&input.provider, &input.model_id) {
                (Some(provider), Some(model_id)) => {
                    Some(json!({ "provider": provider, "modelId": model_id }))
                }
                _ => options.get("initialModel").cloned(),
            };
            let thinking_level = input
                .thinking_level
                .clone()
                .map(Value::String)
                .or_else(|| options.get("initialThinkingLevel").cloned());
            options.insert("title".into(), json!(NEW_THREAD_PLACEHOLDER_TITLE));
            if let Some(model) = &initial_model {
                options.insert("initialModel".into(), model.clone());
            }
            if let Some(level) = &thinking_level {
                options.insert("initialThinkingLevel".into(), level.clone());
            }
            options.insert("extensionFlagValues".into(), json!(applied));
            let session: SessionSnapshot = super::pi::driver_call(
                kernel.driver(),
                "createSession",
                args([json!(target), Value::Object(options)]),
            )
            .await?;
            Ok::<_, CoreError>((session, initial_model, thinking_level))
        }
        .await;
        let (session, initial_model, thinking_level) = match created {
            Ok(created) => created,
            Err(error) => {
                if let Some(destroy) = rollback {
                    rollback_worktree(kernel, destroy).await;
                }
                return Err(error);
            }
        };
        let session_ref = session.session_ref.clone();
        sessions::seed_session(&mut kernel.data.borrow_mut(), &session);
        // Only a start that chose flags (New thread) replaces the workspace's defaults.
        record_extension_flags(
            kernel,
            &session_ref,
            applied,
            input
                .extension_flags
                .is_some()
                .then(|| (input.root_workspace_id.clone(), chosen)),
        );
        let request_token = kernel.env().random_uuid();
        let cancel = Rc::new(tokio::sync::Notify::new());
        let cancel_title = cancel.clone();
        sessions::set_pending_auto_title(
            kernel,
            &session_ref,
            PendingAutoTitle {
                request_token: request_token.clone(),
                cancel: Box::new(move || cancel_title.notify_one()),
            },
        );

        // Show the thread at once so streamed replies render live. Selecting it first means
        // replayed subscription events read the new thread.
        set_active_session(kernel, &session_ref);
        let state = refresh::refresh_state(
            kernel,
            RefreshOptions {
                selected_workspace_id: Some(session_ref.workspace_id.clone()),
                selected_session_id: Some(session_ref.session_id.clone()),
                composer_draft: Some(String::new()),
                clear_last_error: true,
                refresh_worktrees: input.environment == "worktree",
                active_view: Some(AppView::Threads),
                ..Default::default()
            },
        )
        .await?;

        if !prompt.is_empty() || !input.attachments.is_empty() {
            let send_kernel = kernel.rc();
            let send_ref = session_ref.clone();
            let send_prompt = prompt.clone();
            let attachments = input.attachments.clone();
            tokio::task::spawn_local(async move {
                if let Err(error) = conversation::send_message_to_session(
                    &send_kernel,
                    &send_ref,
                    &send_prompt,
                    &attachments,
                    false,
                )
                .await
                {
                    if let Err(error) = sessions::with_core_error(&send_kernel, error).await {
                        eprintln!("[app-store-worktree] withError failed: {}", error.message);
                    }
                }
            });
        }
        if prompt.is_empty() {
            sessions::clear_pending_auto_title(kernel, &session_ref);
        } else {
            let mut options = serde_json::Map::new();
            options.insert("prompt".into(), json!(prompt));
            if let Some(model) = initial_model {
                options.insert("model".into(), model);
            }
            if let Some(level) = thinking_level {
                options.insert("thinkingLevel".into(), level);
            }
            let title_kernel = kernel.rc();
            tokio::task::spawn_local(async move {
                generate_and_apply_auto_title(
                    &title_kernel,
                    &session_ref,
                    &target,
                    Value::Object(options),
                    &request_token,
                    cancel,
                )
                .await;
            });
        }
        Ok(state)
    })
    .await
}

pub(crate) async fn rollback_worktree(kernel: &Kernel, destroy: Value) {
    let _ = kernel
        .core_call(crate::methods::WORKTREES_DESTROY, destroy)
        .await;
}

/// `generateAndApplyAutoTitle`: best effort; a failure leaves the placeholder title.
async fn generate_and_apply_auto_title(
    kernel: &Kernel,
    session_ref: &SessionRef,
    workspace: &WorkspaceRef,
    options: Value,
    request_token: &str,
    cancel: Rc<tokio::sync::Notify>,
) {
    let label = format!("{}:{}", session_ref.workspace_id, session_ref.session_id);
    let clear_matching = || {
        let matches = kernel
            .data
            .borrow()
            .sessions
            .pending_auto_title_by_session
            .get(&session_key(session_ref))
            .is_some_and(|pending| pending.request_token == request_token);
        if matches {
            sessions::clear_pending_auto_title(kernel, session_ref);
        }
    };
    let generated = tokio::select! {
        generated = kernel.driver().generate_thread_title(workspace, options) => generated,
        _ = cancel.notified() => Err(CoreError::named("AbortError", "This operation was aborted")),
    };
    let title = match generated {
        Ok(Some(title)) if !title.is_empty() => title,
        Ok(_) => {
            eprintln!("[app-store] auto-title skipped for {label}: generation returned empty");
            clear_matching();
            return;
        }
        Err(error) => {
            eprintln!(
                "[app-store] auto-title failed for {label}: {}",
                error.message
            );
            clear_matching();
            return;
        }
    };
    let (pending, token_match, current_title) = {
        let data = kernel.data.borrow();
        let pending = data
            .sessions
            .pending_auto_title_by_session
            .get(&session_key(session_ref));
        (
            pending.is_some(),
            pending.is_some_and(|pending| pending.request_token == request_token),
            data.session(session_ref)
                .map(|session| session.title.clone()),
        )
    };
    if !pending || !token_match || current_title.as_deref() != Some(NEW_THREAD_PLACEHOLDER_TITLE) {
        eprintln!(
            "[app-store] auto-title skipped for {label}: pending={pending} tokenMatch={token_match} title={}",
            current_title
                .map(|title| serde_json::to_string(&title).unwrap_or_default())
                .unwrap_or_else(|| "undefined".into())
        );
        return;
    }
    sessions::clear_pending_auto_title(kernel, session_ref);
    let renamed = async {
        kernel
            .driver()
            .call("renameSession", args([json!(session_ref), json!(title)]))
            .await?;
        refresh::refresh_state(
            kernel,
            RefreshOptions {
                clear_last_error: true,
                ..Default::default()
            },
        )
        .await
    }
    .await;
    if let Err(error) = renamed {
        eprintln!(
            "[app-store] auto-title failed for {label}: {}",
            error.message
        );
        clear_matching();
    }
}

pub(crate) struct WorktreeOptions {
    pub path: String,
    pub display_name: String,
    pub branch_name: String,
}

/// `buildWorktreeOptions` for a new thread.
pub(crate) fn build_worktree_options(
    kernel: &Kernel,
    workspace: &WorkspaceRef,
    title_hint: Option<&str>,
) -> WorktreeOptions {
    let preferred = short_display_title(title_hint.map(crate::js::trim).unwrap_or(""), 44);
    let suffix: String = kernel.env().random_uuid().chars().take(6).collect();
    let base = match &preferred {
        Some(title) => clamp_slug(&slugify(title), 18),
        None => "wt".into(),
    };
    let folder = format!("{base}-{suffix}");
    let base_name = std::path::Path::new(&workspace.path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let repo = clamp_slug(
        &slugify(if base_name.is_empty() {
            "repo"
        } else {
            &base_name
        }),
        20,
    );
    let root = kernel.deps.user_data_dir.join("worktrees");
    WorktreeOptions {
        path: root.join(repo).join(&folder).to_string_lossy().into_owned(),
        display_name: preferred.unwrap_or_else(|| format!("Worktree {suffix}")),
        branch_name: format!("pi/{folder}"),
    }
}

/// `slugify`.
fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for character in value.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(character);
        } else {
            gap = true;
        }
    }
    if slug.is_empty() {
        "worktree".into()
    } else {
        slug
    }
}

/// `clampSlug`.
fn clamp_slug(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let trimmed = value[..limit].trim_end_matches('-');
    if trimmed.is_empty() {
        "worktree".into()
    } else {
        trimmed.to_owned()
    }
}

/// `shortDisplayTitle`.
fn short_display_title(value: &str, limit: usize) -> Option<String> {
    let collapsed = crate::js::collapse_whitespace(value);
    let trimmed = crate::js::trim(&collapsed);
    if trimmed.is_empty() {
        return None;
    }
    if crate::js::length(trimmed) > limit {
        let head = crate::js::utf16_prefix(trimmed, limit - 3);
        return Some(format!("{}...", head.trim_end()));
    }
    Some(trimmed.to_owned())
}

/// `resolveExtensionFlags`: keeps the requested flags the folder's enabled extensions
/// registered, with the right types. Booleans reach pi only when on.
async fn resolve_extension_flags(
    kernel: &Kernel,
    workspace_id: &str,
    requested: Option<&ExtensionFlagValues>,
) -> CoreResult<(ExtensionFlagValues, ExtensionFlagValues)> {
    if requested.is_some_and(|requested| !requested.is_empty()) {
        sessions::ensure_runtime_loaded(kernel, workspace_id, None).await?;
    }
    let data = kernel.data.borrow();
    let runtime = data.runtime_by_workspace.get(workspace_id);
    let type_of = |name: &str| {
        runtime
            .into_iter()
            .flat_map(|runtime| &runtime.extensions)
            .filter(|extension| extension.enabled)
            .flat_map(|extension| &extension.flag_details)
            .rfind(|flag| flag.name == name)
            .map(|flag| flag.kind)
    };
    let mut chosen = ExtensionFlagValues::new();
    let mut applied = ExtensionFlagValues::new();
    for (name, value) in requested.into_iter().flatten() {
        let matches = matches!(
            (value, type_of(name)),
            (ExtensionFlagValue::Bool(_), Some(RuntimeFlagType::Boolean))
                | (ExtensionFlagValue::String(_), Some(RuntimeFlagType::String))
        );
        if !matches {
            continue;
        }
        chosen.insert(name.clone(), value.clone());
        match value {
            ExtensionFlagValue::Bool(true) => {
                applied.insert(name.clone(), ExtensionFlagValue::Bool(true));
            }
            ExtensionFlagValue::String(text) if !crate::js::trim(text).is_empty() => {
                applied.insert(name.clone(), value.clone());
            }
            _ => {}
        }
    }
    Ok((chosen, applied))
}

/// `recordExtensionFlags`.
pub(crate) fn record_extension_flags(
    kernel: &Kernel,
    session_ref: &SessionRef,
    applied: ExtensionFlagValues,
    workspace_defaults: Option<(String, ExtensionFlagValues)>,
) {
    {
        let mut data = kernel.data.borrow_mut();
        let key = session_key(session_ref);
        if applied.is_empty() {
            data.sessions.extension_flags_by_session.shift_remove(&key);
        } else {
            data.sessions
                .extension_flags_by_session
                .insert(key, applied);
        }
        if let Some((workspace_id, chosen)) = workspace_defaults {
            if chosen.is_empty() {
                data.extension_flags_by_workspace
                    .shift_remove(&workspace_id);
            } else {
                data.extension_flags_by_workspace
                    .insert(workspace_id, chosen);
            }
        }
    }
    persist::schedule_persist_ui_state(kernel);
}

// ---- Worktrees every refresh uses ----

/// `catalogStore.worktrees.listWorktrees()`.
pub async fn list_worktrees(kernel: &Kernel) -> CoreResult<Vec<WorktreeEntry>> {
    let value = kernel
        .catalog_call("worktrees.listWorktrees", vec![])
        .await?
        .unwrap_or(Value::Null);
    let snapshot: WorktreesSnapshot = crate::parse(value)?;
    Ok(snapshot.worktrees)
}

/// `syncAndListWorktrees`: each folder claims its app worktrees, main checkouts first.
pub async fn sync_and_list_worktrees(
    kernel: &Kernel,
    workspaces: &[WorkspaceEntry],
) -> CoreResult<Vec<WorktreeEntry>> {
    let inspected = super::futures_join_all(workspaces.iter().map(|workspace| async move {
        let workspace_ref = sessions::workspace_ref_of(workspace);
        let inspection = kernel
            .core_call(
                crate::methods::WORKTREES_INSPECT,
                json!({ "workspace": workspace_ref }),
            )
            .await
            .ok();
        let is_app_worktree = kernel
            .core_call(
                crate::methods::WORKTREES_IS_APP_PATH,
                json!({ "path": workspace.path }),
            )
            .await?
            .as_bool()
            .unwrap_or(false);
        let is_main_checkout = inspection.is_some_and(|inspection| {
            let canonical = inspection["canonicalPath"].as_str().unwrap_or_default();
            let common = inspection["commonDir"].as_str().unwrap_or_default();
            std::path::Path::new(canonical).join(".git") == std::path::Path::new(common)
        });
        Ok::<_, CoreError>((workspace, is_app_worktree, is_main_checkout))
    }))
    .await
    .into_iter()
    .collect::<CoreResult<Vec<_>>>()?;

    // App worktrees opened as folders never own rows; their owner lists them.
    super::futures_join_all(
        inspected
            .iter()
            .filter(|(_, is_app_worktree, _)| *is_app_worktree)
            .map(|(workspace, _, _)| {
                kernel.catalog_call(
                    "worktrees.replaceWorkspaceWorktrees",
                    vec![json!(workspace.workspace_id), json!([])],
                )
            }),
    )
    .await;

    // One at a time, main checkouts first: an unclaimed app worktree goes to the first folder
    // that refreshes, and existing claims are kept.
    let mut owners: Vec<_> = inspected
        .iter()
        .filter(|(_, is_app_worktree, _)| !is_app_worktree)
        .collect();
    owners.sort_by(|(left, _, left_main), (right, _, right_main)| {
        right_main
            .cmp(left_main)
            .then_with(|| {
                left.sort_order
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&right.sort_order.as_f64().unwrap_or(0.0))
            })
            .then_with(|| crate::locale::compare(&left.last_opened_at, &right.last_opened_at))
            .then_with(|| crate::locale::compare(&left.path, &right.path))
    });
    for (workspace, _, _) in owners {
        let _ = kernel
            .core_call(
                crate::methods::WORKTREES_REFRESH,
                json!({ "workspace": sessions::workspace_ref_of(workspace) }),
            )
            .await;
    }
    list_worktrees(kernel).await
}

/// `reconcileWorktrees`: removes app worktrees nothing refers to any more.
pub async fn reconcile_worktrees(kernel: &Kernel) {
    let result = async {
        let mut referenced = Vec::new();
        for worktree in list_worktrees(kernel).await? {
            referenced.push(canonical_path(&worktree.path).await);
        }
        let paths: Vec<String> = kernel
            .data
            .borrow()
            .state
            .workspaces
            .iter()
            .map(|workspace| workspace.path.clone())
            .collect();
        for path in paths {
            referenced.push(canonical_path(&path).await);
        }
        kernel
            .core_call(
                crate::methods::WORKTREES_PRUNE,
                json!({
                    "worktreeRoot": kernel.deps.user_data_dir.join("worktrees"),
                    "referencedPaths": referenced,
                }),
            )
            .await?;
        Ok::<_, CoreError>(())
    }
    .await;
    if let Err(error) = result {
        eprintln!("pi-gui: worktree reconcile skipped: {}", error.message);
    }
}

async fn canonical_path(path: &str) -> String {
    let resolved = std::path::absolute(path).unwrap_or_else(|_| PathBuf::from(path));
    tokio::fs::canonicalize(&resolved)
        .await
        .unwrap_or(resolved)
        .to_string_lossy()
        .into_owned()
}

/// `reconcileWorkspaceOnFocus`: picks up sessions and settings changed outside the app.
/// Not ported yet: focusing a window does not rescan the folder.
pub fn reconcile_on_focus(_kernel: &Kernel, _workspace_id: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_names_slug_like_the_typescript() {
        assert_eq!(slugify("Fix the Login bug!"), "fix-the-login-bug");
        assert_eq!(slugify("***"), "worktree");
        assert_eq!(clamp_slug("abcdefghij-klmnop", 11), "abcdefghij");
        assert_eq!(
            short_display_title("  a   very\nlong  title ", 44).as_deref(),
            Some("a very long title")
        );
    }
}
