//! Mirrors of `apps/desktop/contracts/desktop-state.ts` (and the scheduled-task records it
//! holds, from `contracts/scheduled-tasks.ts`): the snapshot the renderer draws.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::driver::{
    ExtensionFlagValues, HostUiRequest, ModelSettingsSnapshot, NoticeLevel, RuntimeCommandRecord,
    RuntimeSnapshot, SessionConfig, SessionSchemaInfo, SessionStatus, SessionUsageSnapshot,
    WidgetPlacement,
};
use super::timeline_types::TranscriptMessage;
use crate::js::JsNumber;

pub use crate::persistence::catalog::WorktreeStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppView {
    #[default]
    Threads,
    NewThread,
    Scheduled,
    Skills,
    Extensions,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Primary,
    Worktree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemePresetId {
    #[default]
    Default,
    Catppuccin,
    TokyoNight,
    Nord,
    Dracula,
    Gruvbox,
    Github,
    Vscode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelSettingsScopeMode {
    #[default]
    AppGlobal,
    PerRepo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadGrouping {
    #[default]
    Time,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComposerDraftSyncSource {
    #[default]
    State,
    Selection,
    Persist,
    RemotePersist,
    Command,
    ExtensionEditorText,
    QueuedMessageEdit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    pub background_completion: bool,
    pub background_failure: bool,
    pub attention_needed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ComposerAttachment {
    Image {
        id: String,
        name: String,
        mime_type: String,
        data: String,
    },
    File {
        id: String,
        name: String,
        mime_type: String,
        fs_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size_bytes: Option<JsNumber>,
    },
}

impl ComposerAttachment {
    pub fn name(&self) -> &str {
        match self {
            Self::Image { name, .. } | Self::File { name, .. } => name,
        }
    }

    pub fn mime_type(&self) -> &str {
        match self {
            Self::Image { mime_type, .. } | Self::File { mime_type, .. } => mime_type,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedComposerMessage {
    pub id: String,
    pub mode: super::driver::SessionMessageDeliveryMode,
    pub text: String,
    pub attachments: Vec<ComposerAttachment>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_viewed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_interacted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    pub preview: String,
    pub status: SessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_since: Option<String>,
    pub has_unseen_update: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<SessionConfig>,
}

// ---- Orchestration ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrchestrationChildThreadStatus {
    Queued,
    Running,
    Waiting,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrchestrationSupervisionGate {
    Continue,
    Stop,
    Wake,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrchestrationSupervisionStatus {
    Monitoring,
    Attention,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationEvidenceKind {
    WorkerReport,
    OrchestratorAcceptance,
    OrchestratorObservation,
    OrchestratorAction,
    Command,
    ReviewFinding,
    Blocker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OrchestrationEvidenceSource {
    WorkerReported,
    OrchestratorAccepted,
    OrchestratorObserved,
    OrchestratorAction,
    Command,
    Review,
    Blocker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrchestrationEvidenceStatus {
    Reported,
    Accepted,
    Running,
    Passed,
    Failed,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidenceSeverity {
    P0,
    P1,
    P2,
    P3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationEvidenceGitRef {
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationEvidenceRecord {
    pub id: String,
    pub child_thread_id: String,
    pub kind: OrchestrationEvidenceKind,
    pub source: OrchestrationEvidenceSource,
    pub status: OrchestrationEvidenceStatus,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<EvidenceSeverity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<OrchestrationEvidenceGitRef>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationSupervisionLoop {
    pub id: String,
    pub status: OrchestrationSupervisionStatus,
    pub gate: OrchestrationSupervisionGate,
    pub interval_ms: JsNumber,
    pub iteration_count: JsNumber,
    pub last_checked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    pub reason: String,
    pub last_child_status: OrchestrationChildThreadStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrchestrationChildTranscriptRole {
    Parent,
    Child,
    System,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationChildTranscriptMessage {
    pub id: String,
    pub role: OrchestrationChildTranscriptRole,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationChildThread {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_tool_call_id: Option<String>,
    pub parent_workspace_id: String,
    pub parent_session_id: String,
    pub child_workspace_id: String,
    pub child_session_id: String,
    pub title: String,
    pub goal: String,
    pub status: OrchestrationChildThreadStatus,
    pub latest_transcript: String,
    pub transcript: Vec<OrchestrationChildTranscriptMessage>,
    pub evidence: Vec<OrchestrationEvidenceRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supervision_loop: Option<OrchestrationSupervisionLoop>,
    pub created_at: String,
    pub updated_at: String,
}

// ---- Transcript, worktrees, extensions ----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedTranscriptRecord {
    pub workspace_id: String,
    pub session_id: String,
    pub transcript: Vec<TranscriptMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_info: Option<SessionSchemaInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub id: String,
    pub root_workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_workspace_id: Option<String>,
    pub name: String,
    pub path: String,
    pub status: WorktreeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionExtensionStatusRecord {
    pub key: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionExtensionWidgetRecord {
    pub key: String,
    pub lines: Vec<String>,
    pub placement: WidgetPlacement,
}

/// `SessionExtensionDialogRecord`: a `HostUiRequest` of kind confirm, select, input or editor.
pub type SessionExtensionDialogRecord = HostUiRequest;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExtensionNoticeRecord {
    pub id: String,
    pub level: NoticeLevel,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExtensionUiStateRecord {
    pub instance_id: String,
    pub statuses: Vec<SessionExtensionStatusRecord>,
    pub widgets: Vec<SessionExtensionWidgetRecord>,
    pub pending_dialogs: Vec<SessionExtensionDialogRecord>,
    pub notices: Vec<SessionExtensionNoticeRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionCommandCompatibilityStatus {
    Supported,
    TerminalOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCommandCompatibilityRecord {
    pub command_name: String,
    pub extension_path: String,
    pub status: ExtensionCommandCompatibilityStatus,
    pub message: String,
    pub capability: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub last_opened_at: String,
    pub kind: WorkspaceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    pub sessions: Vec<SessionRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StartupDiagnosticScope {
    Application,
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupDiagnostic {
    pub scope: StartupDiagnosticScope,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

// ---- Scheduled tasks (`contracts/scheduled-tasks.ts`) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledTaskStatus {
    Active,
    Paused,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ScheduledTaskSchedule {
    Once {
        at: String,
    },
    Daily {
        hour: JsNumber,
        minute: JsNumber,
        time_zone: String,
    },
    Weekly {
        /// 0 is Sunday.
        days: Vec<JsNumber>,
        hour: JsNumber,
        minute: JsNumber,
        time_zone: String,
    },
    Interval {
        every_ms: JsNumber,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ScheduledTaskTarget {
    NewThread {
        workspace_id: String,
    },
    ExistingThread {
        workspace_id: String,
        session_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledTaskRunOutcome {
    Started,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskRun {
    pub id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub fired_at: String,
    pub instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<String>,
    pub outcome: ScheduledTaskRunOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskRecord {
    pub id: String,
    pub title: String,
    pub instruction: String,
    pub status: ScheduledTaskStatus,
    pub schedule: ScheduledTaskSchedule,
    pub target: ScheduledTaskTarget,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub runs: Vec<ScheduledTaskRun>,
}

// ---- The snapshot ----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppState {
    pub workspaces: Vec<WorkspaceRecord>,
    pub worktrees_by_workspace: IndexMap<String, Vec<WorktreeRecord>>,
    pub selected_workspace_id: String,
    pub selected_session_id: String,
    pub active_view: AppView,
    pub composer_draft: String,
    pub composer_draft_sync_source: ComposerDraftSyncSource,
    pub composer_draft_sync_nonce: JsNumber,
    pub composer_attachments: Vec<ComposerAttachment>,
    pub queued_composer_messages: Vec<QueuedComposerMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editing_queued_message_id: Option<String>,
    pub runtime_by_workspace: IndexMap<String, RuntimeSnapshot>,
    pub session_commands_by_session: IndexMap<String, Vec<RuntimeCommandRecord>>,
    pub session_usage_by_session: IndexMap<String, SessionUsageSnapshot>,
    pub session_extension_ui_by_session: IndexMap<String, SessionExtensionUiStateRecord>,
    pub extension_command_compatibility_by_workspace:
        IndexMap<String, Vec<ExtensionCommandCompatibilityRecord>>,
    pub extension_flags_by_workspace: IndexMap<String, ExtensionFlagValues>,
    pub extension_flags_by_session: IndexMap<String, ExtensionFlagValues>,
    pub orchestration_children: Vec<OrchestrationChildThread>,
    pub scheduled_tasks: Vec<ScheduledTaskRecord>,
    pub notification_preferences: NotificationPreferences,
    pub integrated_terminal_shell: String,
    pub last_viewed_at_by_session: IndexMap<String, String>,
    pub last_interacted_at_by_session: IndexMap<String, String>,
    pub pinned_at_by_session: IndexMap<String, String>,
    pub pinned_session_order: Vec<String>,
    pub workspace_order: Vec<String>,
    pub model_settings_scope_mode: ModelSettingsScopeMode,
    pub global_model_settings: ModelSettingsSnapshot,
    pub theme_mode: ThemeMode,
    pub theme_preset_id: ThemePresetId,
    pub sidebar_collapsed: bool,
    pub thread_grouping: ThreadGrouping,
    pub collapsed_workspace_ids: Vec<String>,
    pub enable_transparency: bool,
    pub startup_diagnostics: Vec<StartupDiagnostic>,
    pub revision: JsNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// `createEmptyDesktopAppState()`.
pub fn create_empty_desktop_app_state() -> DesktopAppState {
    DesktopAppState {
        workspaces: Vec::new(),
        worktrees_by_workspace: IndexMap::new(),
        selected_workspace_id: String::new(),
        selected_session_id: String::new(),
        active_view: AppView::Threads,
        composer_draft: String::new(),
        composer_draft_sync_source: ComposerDraftSyncSource::State,
        composer_draft_sync_nonce: JsNumber(0.0),
        composer_attachments: Vec::new(),
        queued_composer_messages: Vec::new(),
        editing_queued_message_id: None,
        runtime_by_workspace: IndexMap::new(),
        session_commands_by_session: IndexMap::new(),
        session_usage_by_session: IndexMap::new(),
        session_extension_ui_by_session: IndexMap::new(),
        extension_command_compatibility_by_workspace: IndexMap::new(),
        extension_flags_by_workspace: IndexMap::new(),
        extension_flags_by_session: IndexMap::new(),
        orchestration_children: Vec::new(),
        scheduled_tasks: Vec::new(),
        notification_preferences: NotificationPreferences {
            background_completion: true,
            background_failure: true,
            attention_needed: true,
        },
        integrated_terminal_shell: String::new(),
        last_viewed_at_by_session: IndexMap::new(),
        last_interacted_at_by_session: IndexMap::new(),
        pinned_at_by_session: IndexMap::new(),
        pinned_session_order: Vec::new(),
        workspace_order: Vec::new(),
        model_settings_scope_mode: ModelSettingsScopeMode::AppGlobal,
        global_model_settings: ModelSettingsSnapshot::default(),
        theme_mode: ThemeMode::System,
        theme_preset_id: ThemePresetId::Default,
        sidebar_collapsed: false,
        thread_grouping: ThreadGrouping::Time,
        collapsed_workspace_ids: Vec::new(),
        enable_transparency: false,
        startup_diagnostics: Vec::new(),
        revision: JsNumber(0.0),
        last_error: None,
    }
}
