//! App-level UI state and the shell calls around it: the view, sidebar, grouping, theme,
//! transparency and terminal shell (the "View / UI state" part of `app-store.ts`), plus `ping`,
//! links, relaunch, the window's maximize toggle and the clipboard.

use super::dispatch::{self, MethodTable, Reply};
use super::validation;
use super::{persist, publish, sessions, Kernel};
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{AppView, DesktopAppState, ThemeMode, ThemePresetId};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashSet;

/// What `ThemeManager` keeps, and what the shell last heard about the window chrome.
#[derive(Default)]
pub struct UiState {
    /// The theme manager's mode, which follows `state.themeMode` once startup has run.
    pub theme_mode: ThemeMode,
    appearance: Option<Value>,
}

pub fn register(table: &mut MethodTable) {
    table.on("ping", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(Reply::Value(json!("pi desktop ready")))
        })
    });
    table.on("getState", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            kernel.initialize().await;
            let view = kernel.windows.view_for_window(&kernel, window);
            Ok(publish::state_for_view(&kernel, &view).into())
        })
    });
    table.on("getSelectedTranscript", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let view = kernel.windows.view_for_window(&kernel, window);
            Ok(
                match sessions::selected_transcript_for_view(&kernel, &view).await? {
                    Some((_, _, json)) => Reply::Raw(json),
                    None => Reply::Value(Value::Null),
                },
            )
        })
    });
    table.on("getThemeMode", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(dispatch::value(kernel.data.borrow().ui.theme_mode))
        })
    });
    table.on("getResolvedTheme", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(Reply::Value(json!(resolved_theme(&kernel))))
        })
    });
    table.on("setThemeMode", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let mode = validation::expect_theme_mode(call.arg(0))?;
            set_theme_manager_mode(&kernel, mode);
            dispatch::run(&kernel, &call, || set_theme_mode(&kernel, mode)).await
        })
    });
    table.on("setThemePresetId", |kernel, call| {
        Box::pin(async move {
            let preset = validation::expect_theme_preset_id(call.arg(0))?;
            dispatch::run(&kernel, &call, || set_theme_preset_id(&kernel, preset)).await
        })
    });
    table.on("openExternal", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let url = validation::expect_string(call.arg(0), "url")?;
            open_external_link(&kernel, &url).await?;
            Ok(Reply::Undefined)
        })
    });
    table.on("relaunchApplication", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            kernel.shell().relaunch();
            Ok(Reply::Undefined)
        })
    });
    table.on("toggleWindowMaximize", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            kernel.shell().toggle_maximize(window);
            Ok(Reply::Undefined)
        })
    });
    table.on("readClipboardImage", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(Reply::Value(kernel.shell().read_clipboard_image()))
        })
    });
    table.on("setActiveView", |kernel, call| {
        Box::pin(async move {
            let view = validation::expect_app_view(call.arg(0))?;
            dispatch::run(&kernel, &call, || set_active_view(&kernel, view)).await
        })
    });
    table.on("setSidebarCollapsed", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let collapsed = validation::expect_boolean(call.arg(0), "collapsed")?;
                set_flag(&kernel, |state| &mut state.sidebar_collapsed, collapsed).await
            })
            .await
        })
    });
    table.on("setThreadGrouping", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let grouping = validation::expect_thread_grouping(call.arg(0))?;
                set_flag(&kernel, |state| &mut state.thread_grouping, grouping).await
            })
            .await
        })
    });
    table.on("setWorkspaceCollapsed", |kernel, call| {
        Box::pin(async move {
            let workspace_id = validation::expect_non_empty_string(call.arg(0), "workspaceId")?;
            let collapsed = validation::expect_boolean(call.arg(1), "collapsed")?;
            dispatch::run(&kernel, &call, || {
                set_workspace_collapsed(&kernel, &workspace_id, collapsed)
            })
            .await
        })
    });
    table.on("setNotificationPreferences", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let preferences = validation::expect_notification_preferences(call.arg(0))?;
                set_notification_preferences(&kernel, &preferences).await
            })
            .await
        })
    });
    table.on("setIntegratedTerminalShell", |kernel, call| {
        Box::pin(async move {
            dispatch::run(&kernel, &call, || async {
                let shell = validation::expect_string(call.arg(0), "shellPath")?;
                let shell = crate::js::trim(&shell).to_owned();
                set_flag(&kernel, |state| &mut state.integrated_terminal_shell, shell).await
            })
            .await
        })
    });
    table.on("setEnableTransparency", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            let enabled = validation::expect_boolean(call.arg(0), "enabled")?;
            dispatch::unscoped(&kernel, &call, async {
                set_flag(&kernel, |state| &mut state.enable_transparency, enabled).await
            })
            .await
        })
    });
    table.on("pendingComposerDraftFlushed", |kernel, call| {
        Box::pin(async move {
            let window =
                dispatch::main_frame(&kernel, &call, "pi-gui:pending-composer-draft-flushed")?;
            let request_id = call
                .arg(0)
                .and_then(Value::as_f64)
                .filter(|id| id.fract() == 0.0 && *id >= 1.0 && *id <= 9_007_199_254_740_991.0)
                .ok_or_else(|| {
                    CoreError::named("TypeError", "requestId must be a positive integer")
                })?;
            kernel.draft_flush.acknowledge(window, request_id as u64);
            Ok(Reply::Undefined)
        })
    });
}

/// `ThemeManager.getResolvedTheme`. No native theme is read, so "system" resolves to light,
/// as a headless Electron does.
pub fn resolved_theme(kernel: &Kernel) -> &'static str {
    match kernel.data.borrow().ui.theme_mode {
        ThemeMode::Dark => "dark",
        ThemeMode::Light => "light",
        ThemeMode::System if kernel.shell().system_theme_dark() => "dark",
        ThemeMode::System => "light",
    }
}

/// `nativeTheme`'s `updated`: the OS appearance changed, so every window hears the resolved
/// theme again.
pub fn system_theme_changed(kernel: &Kernel) {
    publish::broadcast(
        kernel,
        super::methods::push::THEME_CHANGED,
        &resolved_theme(kernel),
    );
}

/// `ThemeManager.setMode`: tells every window the resolved theme.
pub fn set_theme_manager_mode(kernel: &Kernel, mode: ThemeMode) {
    kernel.data.borrow_mut().ui.theme_mode = mode;
    publish::broadcast(
        kernel,
        super::methods::push::THEME_CHANGED,
        &resolved_theme(kernel),
    );
}

/// `openExternalLink`: http and https only.
pub async fn open_external_link(kernel: &Kernel, url: &str) -> CoreResult<()> {
    if !is_external_web_url(url) {
        return Err(CoreError::new(format!(
            "Refusing to open unsupported URL: {url}"
        )));
    }
    kernel.shell().open_external(url.to_owned()).await
}

/// `parseExternalWebUrl`: an absolute http or https URL with a host.
pub fn is_external_web_url(url: &str) -> bool {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("https:") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http:") {
        rest
    } else {
        return false;
    };
    let host = rest.trim_start_matches(['/', '\\']);
    let host = host.split(['/', '?', '#', '\\']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or("");
    !host.is_empty() && !host.contains(char::is_whitespace)
}

/// The shared tail of each setter: clear the error, bump, save, emit.
async fn commit(kernel: &Kernel) -> CoreResult<DesktopAppState> {
    {
        let mut data = kernel.data.borrow_mut();
        data.state.last_error = None;
        data.bump();
    }
    persist::persist_ui_state(kernel).await?;
    Ok(publish::emit(kernel))
}

/// Sets one field, or answers the snapshot when it already has that value.
async fn set_flag<T: PartialEq>(
    kernel: &Kernel,
    field: impl FnOnce(&mut DesktopAppState) -> &mut T,
    value: T,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    {
        let mut data = kernel.data.borrow_mut();
        let slot = field(&mut data.state);
        if *slot == value {
            return Ok(data.state.clone());
        }
        *slot = value;
    }
    commit(kernel).await
}

/// `setActiveView`.
pub async fn set_active_view(kernel: &Kernel, view: AppView) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let leaving = {
        let data = kernel.data.borrow();
        (data.state.active_view == AppView::Threads && view != AppView::Threads)
            .then(|| data.selected_session_ref())
            .flatten()
    };
    if let Some(session_ref) = leaving {
        sessions::cancel_pending_dialogs_for_session(kernel, &session_ref, false).await?;
    }
    {
        let mut data = kernel.data.borrow_mut();
        data.state.active_view = view;
        data.state.last_error = None;
        data.bump();
    }
    if view == AppView::Threads {
        sessions::mark_selected_session_viewed_if_visible(kernel);
    }
    persist::persist_ui_state(kernel).await?;
    Ok(publish::emit(kernel))
}

/// `setThemeMode`.
pub async fn set_theme_mode(kernel: &Kernel, mode: ThemeMode) -> CoreResult<DesktopAppState> {
    set_flag(kernel, |state| &mut state.theme_mode, mode).await
}

/// `setThemePresetId`.
pub async fn set_theme_preset_id(
    kernel: &Kernel,
    preset: ThemePresetId,
) -> CoreResult<DesktopAppState> {
    set_flag(kernel, |state| &mut state.theme_preset_id, preset).await
}

/// `setWorkspaceCollapsed`.
pub async fn set_workspace_collapsed(
    kernel: &Kernel,
    workspace_id: &str,
    collapsed: bool,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    {
        let mut data = kernel.data.borrow_mut();
        let ids = &mut data.state.collapsed_workspace_ids;
        if ids.iter().any(|id| id == workspace_id) == collapsed {
            return Ok(data.state.clone());
        }
        if collapsed {
            ids.push(workspace_id.to_owned());
        } else {
            ids.retain(|id| id != workspace_id);
        }
    }
    commit(kernel).await
}

/// `setNotificationPreferences`: merges the flags given.
pub async fn set_notification_preferences(
    kernel: &Kernel,
    preferences: &Value,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    {
        let mut data = kernel.data.borrow_mut();
        let current = &mut data.state.notification_preferences;
        let flag = |key: &str| preferences.get(key).and_then(Value::as_bool);
        if let Some(value) = flag("backgroundCompletion") {
            current.background_completion = value;
        }
        if let Some(value) = flag("backgroundFailure") {
            current.background_failure = value;
        }
        if let Some(value) = flag("attentionNeeded") {
            current.attention_needed = value;
        }
    }
    commit(kernel).await
}

/// `reconcilePinnedSessionOrder`: the preferred order first, then the other pinned threads,
/// newest pin first.
pub fn reconcile_pinned_session_order(
    pinned_at_by_session: &IndexMap<String, String>,
    preferred_order: &[String],
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ordered: Vec<String> = preferred_order
        .iter()
        .filter(|key| pinned_at_by_session.contains_key(*key) && seen.insert((*key).clone()))
        .cloned()
        .collect();
    let mut missing: Vec<&String> = pinned_at_by_session
        .keys()
        .filter(|key| !seen.contains(*key))
        .collect();
    missing.sort_by(|left, right| {
        crate::locale::compare(&pinned_at_by_session[*right], &pinned_at_by_session[*left])
    });
    ordered.extend(missing.into_iter().cloned());
    ordered
}

/// Runs after every emit, as main's store listener did: the window chrome follows the theme,
/// preset and transparency.
pub fn after_emit(kernel: &Kernel, state: &DesktopAppState) {
    let appearance = json!({
        "themeMode": state.theme_mode,
        "themePresetId": state.theme_preset_id,
        "enableTransparency": state.enable_transparency,
    });
    {
        let mut data = kernel.data.borrow_mut();
        if data.ui.appearance.as_ref() == Some(&appearance) {
            return;
        }
        data.ui.appearance = Some(appearance.clone());
    }
    kernel.shell().set_appearance(appearance);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_open() {
        assert!(is_external_web_url("https://example.com/a?b"));
        assert!(is_external_web_url("HTTP://localhost:3000"));
        assert!(!is_external_web_url("file:///etc/passwd"));
        assert!(!is_external_web_url("javascript:alert(1)"));
        assert!(!is_external_web_url("https://"));
        assert!(!is_external_web_url("not a url"));
    }

    #[test]
    fn pinned_order_keeps_preferred_then_newest() {
        let pinned: IndexMap<String, String> = [
            ("a".to_owned(), "2024-01-01".to_owned()),
            ("b".to_owned(), "2024-03-01".to_owned()),
            ("c".to_owned(), "2024-02-01".to_owned()),
        ]
        .into_iter()
        .collect();
        let order =
            reconcile_pinned_session_order(&pinned, &["c".into(), "gone".into(), "c".into()]);
        assert_eq!(order, ["c", "b", "a"]);
    }
}
