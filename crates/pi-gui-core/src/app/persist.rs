//! ui-state.json: reading it at startup, writing it after changes (`persistUiState`), and the
//! 250 ms debounce (`schedulePersistUiState`). The file format lives in
//! `persistence::ui_state`; this builds the payload in the order the TypeScript store wrote it.

use super::{orchestration, publish, Kernel, Readiness};
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{
    AppView, ExtensionCommandCompatibilityRecord, ModelSettingsScopeMode, NotificationPreferences,
    ThemeMode, ThemePresetId, ThreadGrouping,
};
use crate::state::driver::{ExtensionFlagValues, ModelSettingsSnapshot};
use crate::state::extension_command_compatibility::{
    restore_compatibility_by_workspace, serialize_compatibility_by_workspace,
};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::time::Duration;
use tokio::task::AbortHandle;

/// How long a scheduled save waits for more changes.
pub const PERSIST_DEBOUNCE: Duration = Duration::from_millis(250);

/// `LegacyPersistedUiState`: what `uiState.read` returns, already validated by the core.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedUiState {
    pub task_workbench_templates_by_session: Option<IndexMap<String, Value>>,
    pub selected_workspace_id: Option<String>,
    pub selected_session_id: Option<String>,
    pub active_view: Option<AppView>,
    pub composer_draft: Option<String>,
    pub composer_drafts_by_session: Option<IndexMap<String, String>>,
    /// Legacy inline attachments, moved to their own files at startup.
    pub composer_attachments_by_session: Option<IndexMap<String, Vec<Value>>>,
    pub extension_command_compatibility_by_workspace:
        Option<IndexMap<String, Vec<ExtensionCommandCompatibilityRecord>>>,
    pub extension_flags_by_workspace: Option<IndexMap<String, ExtensionFlagValues>>,
    pub extension_flags_by_session: Option<IndexMap<String, ExtensionFlagValues>>,
    pub notification_preferences: Option<Map<String, Value>>,
    pub disabled_builtin_extensions: Option<Vec<String>>,
    pub integrated_terminal_shell: Option<String>,
    pub last_viewed_at_by_session: Option<IndexMap<String, String>>,
    pub last_interacted_at_by_session: Option<IndexMap<String, String>>,
    pub pinned_at_by_session: Option<IndexMap<String, String>>,
    pub pinned_session_order: Option<Vec<String>>,
    pub workspace_order: Option<Vec<String>>,
    pub model_settings_scope_mode: Option<ModelSettingsScopeMode>,
    pub app_global_model_settings: Option<ModelSettingsSnapshot>,
    pub theme_mode: Option<ThemeMode>,
    pub theme_preset_id: Option<ThemePresetId>,
    pub sidebar_collapsed: Option<bool>,
    pub thread_grouping: Option<ThreadGrouping>,
    pub collapsed_workspace_ids: Option<Vec<String>>,
    pub enable_transparency: Option<bool>,
    pub orchestration_children: Option<Value>,
}

/// `readUiState`.
pub async fn read_ui_state(kernel: &Kernel) -> CoreResult<PersistedUiState> {
    let value = kernel
        .core_call(crate::methods::UI_STATE_READ, Value::Null)
        .await?;
    serde_json::from_value(value).map_err(|error| CoreError::new(error.to_string()))
}

/// `restorePersistedUiState`.
pub fn restore_persisted_ui_state(kernel: &Kernel, persisted: &PersistedUiState) -> CoreResult<()> {
    let orchestration_children = match &persisted.orchestration_children {
        Some(children) => serde_json::from_value(children.clone())
            .map_err(|error| CoreError::new(error.to_string()))?,
        None => Vec::new(),
    };
    let mut data = kernel.data.borrow_mut();
    let data = &mut *data;
    data.disabled_builtin_extensions = persisted
        .disabled_builtin_extensions
        .iter()
        .flatten()
        .cloned()
        .collect();
    data.task_workbench_templates_by_session = persisted
        .task_workbench_templates_by_session
        .clone()
        .unwrap_or_default();
    let state = &mut data.state;
    if let Some(id) = &persisted.selected_workspace_id {
        state.selected_workspace_id = id.clone();
    }
    if let Some(id) = &persisted.selected_session_id {
        state.selected_session_id = id.clone();
    }
    if let Some(view) = persisted.active_view {
        state.active_view = view;
    }
    if let Some(draft) = &persisted.composer_draft {
        state.composer_draft = draft.clone();
    }
    if let Some(mode) = persisted.model_settings_scope_mode {
        state.model_settings_scope_mode = mode;
    }
    if let Some(settings) = &persisted.app_global_model_settings {
        state.global_model_settings = settings.clone();
    }
    if let Some(preferences) = &persisted.notification_preferences {
        let mut merged = serde_json::to_value(&state.notification_preferences)
            .unwrap_or_default()
            .as_object()
            .cloned()
            .unwrap_or_default();
        for (key, value) in preferences {
            merged.insert(key.clone(), value.clone());
        }
        state.notification_preferences =
            serde_json::from_value::<NotificationPreferences>(Value::Object(merged))
                .map_err(|error| CoreError::new(error.to_string()))?;
    }
    if let Some(shell) = &persisted.integrated_terminal_shell {
        state.integrated_terminal_shell = shell.clone();
    }
    state.last_viewed_at_by_session = persisted
        .last_viewed_at_by_session
        .clone()
        .unwrap_or_default();
    state.last_interacted_at_by_session = persisted
        .last_interacted_at_by_session
        .clone()
        .unwrap_or_default();
    state.pinned_at_by_session = persisted.pinned_at_by_session.clone().unwrap_or_default();
    state.pinned_session_order = persisted.pinned_session_order.clone().unwrap_or_default();
    state.workspace_order = persisted.workspace_order.clone().unwrap_or_default();
    if let Some(mode) = persisted.theme_mode {
        state.theme_mode = mode;
    }
    if let Some(preset) = persisted.theme_preset_id {
        state.theme_preset_id = preset;
    }
    if let Some(collapsed) = persisted.sidebar_collapsed {
        state.sidebar_collapsed = collapsed;
    }
    state.thread_grouping = persisted.thread_grouping.unwrap_or(ThreadGrouping::Time);
    state.collapsed_workspace_ids = persisted
        .collapsed_workspace_ids
        .clone()
        .unwrap_or_default();
    if let Some(enabled) = persisted.enable_transparency {
        state.enable_transparency = enabled;
    }
    state.orchestration_children = orchestration_children;

    let sessions = &mut data.sessions;
    let non_empty = |map: &Option<IndexMap<String, String>>| -> IndexMap<String, String> {
        map.iter()
            .flatten()
            .filter(|(_, value)| !value.is_empty())
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    };
    sessions.last_viewed_at_by_session = non_empty(&persisted.last_viewed_at_by_session);
    sessions.last_interacted_at_by_session = non_empty(&persisted.last_interacted_at_by_session);
    sessions.pinned_at_by_session = non_empty(&persisted.pinned_at_by_session);
    sessions.pinned_session_order = super::ui::reconcile_pinned_session_order(
        &sessions.pinned_at_by_session,
        persisted
            .pinned_session_order
            .as_deref()
            .unwrap_or_default(),
    );
    sessions.composer_drafts_by_session = non_empty(&persisted.composer_drafts_by_session);
    sessions.extension_flags_by_session = persisted
        .extension_flags_by_session
        .clone()
        .unwrap_or_default();
    data.extension_flags_by_workspace = persisted
        .extension_flags_by_workspace
        .clone()
        .unwrap_or_default();
    data.compatibility_by_workspace = restore_compatibility_by_workspace(
        persisted
            .extension_command_compatibility_by_workspace
            .as_ref(),
    );
    Ok(())
}

/// Inserts `value` unless it is `undefined`.
fn put(payload: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        payload.insert(key.into(), value);
    }
}

fn to_json(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The `PersistedUiState` payload, in the TypeScript store's key order.
fn persisted_payload(kernel: &Kernel) -> Map<String, Value> {
    let data = kernel.data.borrow();
    let state = &data.state;
    let sessions = &data.sessions;
    let mut payload = Map::new();
    put(
        &mut payload,
        "taskWorkbenchTemplatesBySession",
        Some(to_json(&data.task_workbench_templates_by_session)),
    );
    put(
        &mut payload,
        "selectedWorkspaceId",
        (!state.selected_workspace_id.is_empty()).then(|| json!(state.selected_workspace_id)),
    );
    put(
        &mut payload,
        "selectedSessionId",
        (!state.selected_session_id.is_empty()).then(|| json!(state.selected_session_id)),
    );
    put(&mut payload, "activeView", Some(to_json(state.active_view)));
    put(
        &mut payload,
        "composerDraft",
        (!state.composer_draft.is_empty()).then(|| json!(state.composer_draft)),
    );
    put(
        &mut payload,
        "composerDraftsBySession",
        Some(to_json(&sessions.composer_drafts_by_session)),
    );
    put(
        &mut payload,
        "extensionCommandCompatibilityByWorkspace",
        Some(to_json(serialize_compatibility_by_workspace(
            &data.compatibility_by_workspace,
        ))),
    );
    put(
        &mut payload,
        "extensionFlagsByWorkspace",
        Some(to_json(&data.extension_flags_by_workspace)),
    );
    put(
        &mut payload,
        "extensionFlagsBySession",
        Some(to_json(&sessions.extension_flags_by_session)),
    );
    put(
        &mut payload,
        "notificationPreferences",
        Some(to_json(&state.notification_preferences)),
    );
    put(
        &mut payload,
        "disabledBuiltinExtensions",
        (!data.disabled_builtin_extensions.is_empty())
            .then(|| to_json(&data.disabled_builtin_extensions)),
    );
    put(
        &mut payload,
        "integratedTerminalShell",
        (!state.integrated_terminal_shell.is_empty())
            .then(|| json!(state.integrated_terminal_shell)),
    );
    put(
        &mut payload,
        "lastViewedAtBySession",
        Some(to_json(&sessions.last_viewed_at_by_session)),
    );
    put(
        &mut payload,
        "lastInteractedAtBySession",
        Some(to_json(&sessions.last_interacted_at_by_session)),
    );
    put(
        &mut payload,
        "pinnedAtBySession",
        Some(to_json(&sessions.pinned_at_by_session)),
    );
    put(
        &mut payload,
        "pinnedSessionOrder",
        (!sessions.pinned_session_order.is_empty())
            .then(|| to_json(&sessions.pinned_session_order)),
    );
    put(
        &mut payload,
        "workspaceOrder",
        (!state.workspace_order.is_empty()).then(|| to_json(&state.workspace_order)),
    );
    put(
        &mut payload,
        "modelSettingsScopeMode",
        Some(to_json(state.model_settings_scope_mode)),
    );
    put(
        &mut payload,
        "appGlobalModelSettings",
        super::settings::has_stored_model_settings(&state.global_model_settings)
            .then(|| to_json(&state.global_model_settings)),
    );
    put(&mut payload, "themeMode", Some(to_json(state.theme_mode)));
    put(
        &mut payload,
        "themePresetId",
        Some(to_json(state.theme_preset_id)),
    );
    put(
        &mut payload,
        "sidebarCollapsed",
        state.sidebar_collapsed.then(|| json!(true)),
    );
    put(
        &mut payload,
        "threadGrouping",
        Some(to_json(state.thread_grouping)),
    );
    put(
        &mut payload,
        "collapsedWorkspaceIds",
        (!state.collapsed_workspace_ids.is_empty())
            .then(|| to_json(&state.collapsed_workspace_ids)),
    );
    put(
        &mut payload,
        "enableTransparency",
        Some(json!(state.enable_transparency)),
    );
    put(
        &mut payload,
        "orchestrationChildren",
        orchestration::to_persisted_children(&state.orchestration_children),
    );
    payload
}

/// `persistUiState`: writes now, replacing any scheduled save.
pub async fn persist_ui_state(kernel: &Kernel) -> CoreResult<()> {
    kernel.saves.cancel();
    if kernel.data.borrow().persistence != Readiness::Ready {
        return Ok(());
    }
    let payload = persisted_payload(kernel);
    kernel
        .core_call(
            crate::methods::UI_STATE_WRITE,
            json!({ "state": Value::Object(payload) }),
        )
        .await?;
    Ok(())
}

/// `schedulePersistUiState`: one save 250 ms after the last change.
pub fn schedule_persist_ui_state(kernel: &Kernel) {
    if kernel.data.borrow().persistence != Readiness::Ready || kernel.is_stopping() {
        return;
    }
    let target = kernel.rc();
    let task = tokio::task::spawn_local(async move {
        tokio::time::sleep(PERSIST_DEBOUNCE).await;
        target.saves.timer.borrow_mut().take();
        if let Err(error) = persist_ui_state(&target).await {
            eprintln!("[app-store] persistUiState failed: {}", error.message);
        }
    });
    kernel.saves.replace(task.abort_handle());
}

/// `blockPersistence`.
pub fn block_persistence(kernel: &Kernel) {
    kernel.data.borrow_mut().persistence = Readiness::Blocked;
    kernel.saves.cancel();
}

/// The pending debounced save, if any.
#[derive(Default)]
pub struct Saves {
    timer: RefCell<Option<AbortHandle>>,
}

impl Saves {
    fn replace(&self, next: AbortHandle) {
        if let Some(previous) = self.timer.borrow_mut().replace(next) {
            previous.abort();
        }
    }

    pub fn cancel(&self) {
        if let Some(timer) = self.timer.borrow_mut().take() {
            timer.abort();
        }
    }

    pub fn is_scheduled(&self) -> bool {
        self.timer.borrow().is_some()
    }
}

/// `withError` and friends persist and emit; this is their shared tail.
pub async fn persist_and_emit(
    kernel: &Kernel,
) -> CoreResult<crate::state::desktop_state::DesktopAppState> {
    persist_ui_state(kernel).await?;
    Ok(publish::emit(kernel))
}
