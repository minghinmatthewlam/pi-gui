//! Twin of `apps/desktop/electron/conversation/session-state-map.ts`: every per-session map
//! the app state keeps, pruned and cleared in one place. Also the extension UI state each
//! session keeps (`pi-sdk-driver`'s `extension-ui-state.ts`).

use indexmap::{IndexMap, IndexSet};
use std::collections::HashSet;

use super::app_store_utils::SessionMap;
use super::desktop_state::{
    ComposerAttachment, QueuedComposerMessage, SessionExtensionDialogRecord,
    SessionExtensionNoticeRecord, SessionExtensionStatusRecord, SessionExtensionUiStateRecord,
    SessionExtensionWidgetRecord,
};
use super::driver::{
    ExtensionFlagValues, HostUiRequest, RuntimeCommandRecord, SessionConfig, SessionUsageSnapshot,
    WidgetPlacement,
};
use super::env::StateEnv;
use super::timeline::{RunMetrics, TranscriptCache};

/// `PendingAutoTitle`.
pub struct PendingAutoTitle {
    pub request_token: String,
    pub cancel: Box<dyn Fn()>,
}

/// `QueuedComposerEditState`.
#[derive(Debug, Clone, PartialEq)]
pub struct QueuedComposerEditState {
    pub message_id: String,
    pub restore_draft: String,
    pub restore_attachments: Vec<ComposerAttachment>,
}

/// `MutableSessionExtensionUiState`.
#[derive(Debug, Clone, PartialEq)]
pub struct MutableSessionExtensionUiState {
    pub instance_id: String,
    pub statuses: IndexMap<String, String>,
    pub widgets: IndexMap<String, SessionExtensionWidgetRecord>,
    pub title: Option<String>,
    pub editor_text: Option<String>,
    pub pending_dialogs: Vec<SessionExtensionDialogRecord>,
    pub notices: Vec<SessionExtensionNoticeRecord>,
}

/// `SessionStateMap`.
#[derive(Default)]
pub struct SessionStateMap {
    pub transcript_cache: TranscriptCache,
    pub composer_drafts_by_session: SessionMap<String>,
    pub composer_attachments_by_session: SessionMap<Vec<ComposerAttachment>>,
    pub queued_composer_messages_by_session: SessionMap<Vec<QueuedComposerMessage>>,
    pub queued_composer_edits_by_session: SessionMap<QueuedComposerEditState>,
    pub session_config_by_session: SessionMap<SessionConfig>,
    pub last_viewed_at_by_session: SessionMap<String>,
    pub last_interacted_at_by_session: SessionMap<String>,
    pub pinned_at_by_session: SessionMap<String>,
    /// Flag values each thread's pi session started with; re-applied when it reopens.
    pub extension_flags_by_session: SessionMap<ExtensionFlagValues>,
    pub pinned_session_order: Vec<String>,
    pub session_errors_by_session: SessionMap<String>,
    /// Each subscribed session's unsubscribe.
    pub session_subscriptions: SessionMap<Box<dyn Fn()>>,
    pub active_assistant_message_by_session: SessionMap<String>,
    pub pending_assistant_message_by_session: SessionMap<String>,
    pub running_since_by_session: SessionMap<String>,
    pub run_metrics_by_session: SessionMap<RunMetrics>,
    pub active_working_activity_by_session: SessionMap<String>,
    pub session_commands_by_session: SessionMap<Vec<RuntimeCommandRecord>>,
    pub session_usage_by_session: SessionMap<SessionUsageSnapshot>,
    pub extension_ui_by_session: SessionMap<MutableSessionExtensionUiState>,
    pub pending_auto_title_by_session: SessionMap<PendingAutoTitle>,
    pub loaded_transcript_keys: IndexSet<String>,
}

impl SessionStateMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// `prune`: removes all state for sessions not in `active_keys`, sweeping every map rather
    /// than only subscribed sessions, and unsubscribes stale subscriptions first. Returns
    /// whether saved UI state changed.
    pub fn prune(&mut self, active_keys: &HashSet<String>) -> bool {
        let persisted_ui_changed = self.prune_persisted_ui_state(active_keys);
        for key in self.all_session_keys() {
            if !active_keys.contains(&key) {
                if let Some(unsubscribe) = self.session_subscriptions.get(&key) {
                    unsubscribe();
                }
                self.delete_session(&key);
            }
        }
        persisted_ui_changed
    }

    /// Union of keys across every per-session map and set, in the order TypeScript visits them.
    fn all_session_keys(&self) -> IndexSet<String> {
        let mut keys = IndexSet::new();
        let mut add = |iter: &mut dyn Iterator<Item = &String>| {
            for key in iter {
                keys.insert(key.clone());
            }
        };
        add(&mut self.transcript_cache.keys());
        add(&mut self.composer_drafts_by_session.keys());
        add(&mut self.composer_attachments_by_session.keys());
        add(&mut self.queued_composer_messages_by_session.keys());
        add(&mut self.queued_composer_edits_by_session.keys());
        add(&mut self.session_config_by_session.keys());
        add(&mut self.last_viewed_at_by_session.keys());
        add(&mut self.last_interacted_at_by_session.keys());
        add(&mut self.pinned_at_by_session.keys());
        add(&mut self.extension_flags_by_session.keys());
        add(&mut self.session_errors_by_session.keys());
        add(&mut self.session_subscriptions.keys());
        add(&mut self.active_assistant_message_by_session.keys());
        add(&mut self.pending_assistant_message_by_session.keys());
        add(&mut self.running_since_by_session.keys());
        add(&mut self.run_metrics_by_session.keys());
        add(&mut self.active_working_activity_by_session.keys());
        add(&mut self.session_commands_by_session.keys());
        add(&mut self.session_usage_by_session.keys());
        add(&mut self.extension_ui_by_session.keys());
        add(&mut self.pending_auto_title_by_session.keys());
        add(&mut self.loaded_transcript_keys.iter());
        add(&mut self.pinned_session_order.iter());
        keys
    }

    /// `prunePersistedUiState`: drops saved UI entries for sessions no longer in the catalog.
    pub fn prune_persisted_ui_state(&mut self, active_keys: &HashSet<String>) -> bool {
        let mut changed = false;
        changed |= retain_active(&mut self.composer_drafts_by_session, active_keys);
        changed |= retain_active(&mut self.last_viewed_at_by_session, active_keys);
        changed |= retain_active(&mut self.last_interacted_at_by_session, active_keys);
        changed |= retain_active(&mut self.pinned_at_by_session, active_keys);
        changed |= retain_active(&mut self.extension_flags_by_session, active_keys);
        let before = self.pinned_session_order.len();
        self.pinned_session_order
            .retain(|key| active_keys.contains(key));
        changed |= self.pinned_session_order.len() != before;
        changed
    }

    /// `deleteSession`: removes all state for one session key, cancelling a pending title.
    pub fn delete_session(&mut self, key: &str) {
        let pending_auto_title = self.pending_auto_title_by_session.shift_remove(key);
        self.session_subscriptions.shift_remove(key);
        self.active_assistant_message_by_session.shift_remove(key);
        self.pending_assistant_message_by_session.shift_remove(key);
        self.running_since_by_session.shift_remove(key);
        self.run_metrics_by_session.shift_remove(key);
        self.active_working_activity_by_session.shift_remove(key);
        self.composer_drafts_by_session.shift_remove(key);
        self.composer_attachments_by_session.shift_remove(key);
        self.queued_composer_messages_by_session.shift_remove(key);
        self.queued_composer_edits_by_session.shift_remove(key);
        self.session_config_by_session.shift_remove(key);
        self.last_viewed_at_by_session.shift_remove(key);
        self.last_interacted_at_by_session.shift_remove(key);
        self.pinned_at_by_session.shift_remove(key);
        self.extension_flags_by_session.shift_remove(key);
        self.pinned_session_order.retain(|entry| entry != key);
        self.session_errors_by_session.shift_remove(key);
        self.session_commands_by_session.shift_remove(key);
        self.session_usage_by_session.shift_remove(key);
        self.extension_ui_by_session.shift_remove(key);
        if let Some(pending_auto_title) = pending_auto_title {
            (pending_auto_title.cancel)();
        }
        self.loaded_transcript_keys.shift_remove(key);
        self.transcript_cache.shift_remove(key);
    }
}

/// Keeps only active sessions' entries; true when any were dropped.
fn retain_active<V>(map: &mut SessionMap<V>, active_keys: &HashSet<String>) -> bool {
    let before = map.len();
    map.retain(|key, _| active_keys.contains(key));
    map.len() != before
}

/// `createEmptyExtensionUiState`.
pub fn create_empty_extension_ui_state(env: &dyn StateEnv) -> MutableSessionExtensionUiState {
    MutableSessionExtensionUiState {
        instance_id: env.random_uuid(),
        statuses: IndexMap::new(),
        widgets: IndexMap::new(),
        title: None,
        editor_text: None,
        pending_dialogs: Vec::new(),
        notices: Vec::new(),
    }
}

/// `serializeExtensionUiState`.
pub fn serialize_extension_ui_state(
    state: &MutableSessionExtensionUiState,
) -> SessionExtensionUiStateRecord {
    SessionExtensionUiStateRecord {
        instance_id: state.instance_id.clone(),
        statuses: state
            .statuses
            .iter()
            .map(|(key, text)| SessionExtensionStatusRecord {
                key: key.clone(),
                text: text.clone(),
            })
            .collect(),
        widgets: state.widgets.values().cloned().collect(),
        pending_dialogs: state.pending_dialogs.clone(),
        notices: state.notices.clone(),
        title: state.title.clone().filter(|title| !title.is_empty()),
        editor_text: state.editor_text.clone().filter(|text| !text.is_empty()),
    }
}

/// `applyHostUiRequestToExtensionUiState` (pi-sdk-driver): statuses, widgets, title and
/// editor text. Dialogs and notices are the store's.
pub fn apply_host_ui_request_to_extension_ui_state(
    state: &mut MutableSessionExtensionUiState,
    request: &HostUiRequest,
) {
    match request {
        HostUiRequest::Status { key, text, .. } => match text.as_ref().filter(|t| !t.is_empty()) {
            Some(text) => {
                state.statuses.insert(key.clone(), text.clone());
            }
            None => {
                state.statuses.shift_remove(key);
            }
        },
        HostUiRequest::Widget {
            key,
            lines,
            placement,
            ..
        } => match lines.as_ref().filter(|lines| !lines.is_empty()) {
            Some(lines) => {
                state.widgets.insert(
                    key.clone(),
                    SessionExtensionWidgetRecord {
                        key: key.clone(),
                        lines: lines.clone(),
                        placement: placement.unwrap_or(WidgetPlacement::AboveComposer),
                    },
                );
            }
            None => {
                state.widgets.shift_remove(key);
            }
        },
        HostUiRequest::Title { title, .. } => state.title = Some(title.clone()),
        HostUiRequest::EditorText { text, .. } => state.editor_text = Some(text.clone()),
        _ => {}
    }
}
