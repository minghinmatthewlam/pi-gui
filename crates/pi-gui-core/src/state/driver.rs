//! Mirrors of `@pi-gui/session-driver`'s types (`packages/session-driver/src/types.ts`,
//! `transcript.ts`, `usage.ts`, `runtime-types.ts`, `extension-actions.ts`) as they cross the
//! wire as JSON. The TypeScript types stay the source of truth.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::js::JsNumber;
use super::present;

pub use crate::persistence::catalog::{SessionRef, SessionStatus};

/// `sessionKey(sessionRef)`.
pub fn session_key(session_ref: &SessionRef) -> String {
    session_ref.key()
}

pub fn session_ref(workspace_id: &str, session_id: &str) -> SessionRef {
    SessionRef {
        workspace_id: workspace_id.into(),
        session_id: session_id.into(),
        extra: Map::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRef {
    pub workspace_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionMessageDeliveryMode {
    Steer,
    FollowUp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQueuedMessage {
    pub id: String,
    pub mode: SessionMessageDeliveryMode,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<SessionAttachment>>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    #[serde(rename = "ref")]
    pub session_ref: SessionRef,
    pub workspace: WorkspaceRef,
    pub title: String,
    pub status: SessionStatus,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<SessionConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_messages: Option<Vec<SessionQueuedMessage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SessionUsageSnapshot>,
}

/// `SessionAttachment`, also `SessionTranscriptAttachment` (the same shapes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionAttachment {
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    File {
        name: String,
        mime_type: String,
        fs_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size_bytes: Option<JsNumber>,
    },
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

/// `ExtensionFlagValues`: flag values by flag name.
pub type ExtensionFlagValues = IndexMap<String, ExtensionFlagValue>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExtensionFlagValue {
    Bool(bool),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionErrorInfo {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCompatibilityIssue {
    pub capability: String,
    /// Always "terminal-only".
    pub classification: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WidgetPlacement {
    AboveComposer,
    BelowComposer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostUiRequest {
    Confirm {
        request_id: String,
        title: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_value: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<JsNumber>,
    },
    Input {
        request_id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_value: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<JsNumber>,
    },
    Select {
        request_id: String,
        title: String,
        options: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allow_multiple: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<JsNumber>,
    },
    Editor {
        request_id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_value: Option<String>,
    },
    Notify {
        request_id: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<NoticeLevel>,
    },
    Status {
        request_id: String,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Widget {
        request_id: String,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placement: Option<WidgetPlacement>,
    },
    Title {
        request_id: String,
        title: String,
    },
    EditorText {
        request_id: String,
        text: String,
    },
    Reset {
        request_id: String,
    },
    Dismiss {
        request_id: String,
    },
}

impl HostUiRequest {
    /// `isExtensionUiDialogRequest`.
    pub fn is_dialog(&self) -> bool {
        matches!(
            self,
            Self::Confirm { .. } | Self::Input { .. } | Self::Select { .. } | Self::Editor { .. }
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionClosedReason {
    Manual,
    Ended,
    Failed,
}

/// `SessionDriverEvent`: the shared fields, then the event's own fields by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDriverEvent {
    #[serde(flatten)]
    pub kind: SessionEventKind,
    pub session_ref: SessionRef,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionEventKind {
    SessionOpened {
        snapshot: SessionSnapshot,
    },
    SessionUpdated {
        snapshot: SessionSnapshot,
    },
    AssistantDelta {
        text: String,
    },
    AssistantMessageEnded {},
    AssistantMessagePersisted {
        source_message_id: String,
    },
    TranscriptItemAppended {
        item: AppendedTranscriptItem,
    },
    QueuedMessageStarted {
        message: SessionQueuedMessage,
    },
    ToolStarted {
        tool_name: String,
        call_id: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        input: Option<Value>,
    },
    ToolUpdated {
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        progress: Option<JsNumber>,
    },
    ToolFinished {
        call_id: String,
        success: bool,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        output: Option<Value>,
    },
    RunCompleted {
        snapshot: SessionSnapshot,
    },
    RunFailed {
        error: SessionErrorInfo,
    },
    HostUiRequest {
        request: HostUiRequest,
    },
    ExtensionCompatibilityIssue {
        issue: ExtensionCompatibilityIssue,
    },
    SessionClosed {
        reason: SessionClosedReason,
    },
}

impl SessionEventKind {
    /// The event's `type`, as TypeScript names it.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::SessionOpened { .. } => "sessionOpened",
            Self::SessionUpdated { .. } => "sessionUpdated",
            Self::AssistantDelta { .. } => "assistantDelta",
            Self::AssistantMessageEnded {} => "assistantMessageEnded",
            Self::AssistantMessagePersisted { .. } => "assistantMessagePersisted",
            Self::TranscriptItemAppended { .. } => "transcriptItemAppended",
            Self::QueuedMessageStarted { .. } => "queuedMessageStarted",
            Self::ToolStarted { .. } => "toolStarted",
            Self::ToolUpdated { .. } => "toolUpdated",
            Self::ToolFinished { .. } => "toolFinished",
            Self::RunCompleted { .. } => "runCompleted",
            Self::RunFailed { .. } => "runFailed",
            Self::HostUiRequest { .. } => "hostUiRequest",
            Self::ExtensionCompatibilityIssue { .. } => "extensionCompatibilityIssue",
            Self::SessionClosed { .. } => "sessionClosed",
        }
    }
}

// ---- Transcript items (`transcript.ts`) ----

pub const EXTENSION_CARD_CUSTOM_TYPE: &str = "pi-gui.card";
pub const EXTENSION_PIN_CUSTOM_TYPE: &str = "pi-gui.pin";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionTranscriptRole {
    User,
    Assistant,
    BranchSummary,
    CompactionSummary,
}

/// `SessionTranscriptMessage`. Fields this version does not know ride along in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptMessage {
    pub role: SessionTranscriptRole,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<SessionAttachment>>,
    pub created_at: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionToolStatus {
    Success,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptToolCall {
    pub id: String,
    pub call_id: String,
    pub tool_name: String,
    pub status: SessionToolStatus,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub input: Option<Value>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub output: Option<Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptCustomMessage {
    pub id: String,
    pub created_at: String,
    pub custom_type: String,
    pub text: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionCardTone {
    Neutral,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionCardRow {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCard {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub tone: ExtensionCardTone,
    pub rows: Vec<ExtensionCardRow>,
    pub actions: Vec<ExtensionAction>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `ExtensionAction`: already checked by `parseExtensionAction` before it reaches the app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExtensionAction {
    OpenFile {
        label: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<JsNumber>,
    },
    Composer {
        label: String,
        text: String,
    },
    Url {
        label: String,
        url: String,
    },
    Command {
        label: String,
        command: String,
    },
    OpenThread {
        label: String,
        session_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptCard {
    pub id: String,
    pub created_at: String,
    pub card: ExtensionCard,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptPin {
    pub id: String,
    pub created_at: String,
    /// `null` once the extension removed it.
    pub card: Option<ExtensionCard>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `SessionTranscriptItem`: what pi-sdk-driver projects from a session file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionTranscriptItem {
    Message(SessionTranscriptMessage),
    Tool(SessionTranscriptToolCall),
    Custom(SessionTranscriptCustomMessage),
    Card(SessionTranscriptCard),
    Pin(SessionTranscriptPin),
}

/// `TranscriptItemAppendedEvent["item"]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppendedTranscriptItem {
    Custom(SessionTranscriptCustomMessage),
    Card(SessionTranscriptCard),
    Pin(SessionTranscriptPin),
}

// ---- Usage (`usage.ts`) ----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokenCounts {
    pub input: JsNumber,
    pub output: JsNumber,
    pub cache_read: JsNumber,
    pub cache_write: JsNumber,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTotals {
    pub input: JsNumber,
    pub output: JsNumber,
    pub cache_read: JsNumber,
    pub cache_write: JsNumber,
    pub cost: JsNumber,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextUsage {
    /// `null` right after compaction until the model replies.
    pub tokens: Option<JsNumber>,
    pub context_window: JsNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_at_tokens: Option<JsNumber>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptCache {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime_seconds: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_refresh_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlanLimit {
    pub window_minutes: JsNumber,
    pub used_percent: JsNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlanLimits {
    pub provider: String,
    pub limits: Vec<SessionPlanLimit>,
    pub reported_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<SessionContextUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<SessionTokenCounts>,
    pub cache: SessionPromptCache,
    pub totals: SessionTotals,
    pub subscription: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_limits: Option<SessionPlanLimits>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSchemaInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_schema_version: Option<JsNumber>,
    pub runtime_schema_version: JsNumber,
    pub written_by_newer_runtime: bool,
}

// ---- Runtime (`runtime-types.ts`) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeAuthType {
    Oauth,
    ApiKey,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProviderAuthSource {
    None,
    Oauth,
    AuthFile,
    Env,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSourceScope {
    User,
    Project,
    Temporary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeSourceOrigin {
    Package,
    TopLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeCommandSource {
    Extension,
    Prompt,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSourceInfo {
    pub path: String,
    pub source: String,
    pub scope: RuntimeSourceScope,
    pub origin: RuntimeSourceOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProviderRecord {
    pub id: String,
    pub name: String,
    pub has_auth: bool,
    pub auth_type: RuntimeAuthType,
    pub auth_source: RuntimeProviderAuthSource,
    pub oauth_supported: bool,
    pub api_key_setup_supported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelRecord {
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub label: String,
    pub available: bool,
    pub auth_type: RuntimeAuthType,
    pub reasoning: bool,
    pub supports_images: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSkillRecord {
    pub name: String,
    pub description: String,
    pub file_path: String,
    pub base_dir: String,
    pub source: String,
    pub scope: RuntimeSourceScope,
    pub enabled: bool,
    pub disable_model_invocation: bool,
    pub slash_command: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeDiagnosticType {
    Warning,
    Error,
    Collision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeExtensionDiagnostic {
    #[serde(rename = "type")]
    pub kind: RuntimeDiagnosticType,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeFlagType {
    Boolean,
    String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeExtensionFlag {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub kind: RuntimeFlagType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<ExtensionFlagValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExtensionTool {
    pub name: String,
    /// Empty when the extension gave none.
    pub label: String,
    pub replaces_pi_tool: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExtensionRecord {
    pub path: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    pub source_info: RuntimeSourceInfo,
    pub commands: Vec<String>,
    pub tools: Vec<RuntimeExtensionTool>,
    pub flags: Vec<String>,
    pub flag_details: Vec<RuntimeExtensionFlag>,
    pub shortcuts: Vec<String>,
    pub diagnostics: Vec<RuntimeExtensionDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommandRecord {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: RuntimeCommandSource,
    pub source_info: RuntimeSourceInfo,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingsSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model_id: Option<String>,
    /// "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_thinking_level: Option<String>,
    pub enable_skill_commands: bool,
    pub enabled_model_patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettingsSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_thinking_level: Option<String>,
    pub enabled_model_patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub workspace: WorkspaceRef,
    pub providers: Vec<RuntimeProviderRecord>,
    pub models: Vec<RuntimeModelRecord>,
    pub skills: Vec<RuntimeSkillRecord>,
    pub extensions: Vec<RuntimeExtensionRecord>,
    pub settings: RuntimeSettingsSnapshot,
}
