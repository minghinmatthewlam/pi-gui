//! Mirrors of `apps/desktop/contracts/timeline-types.ts`: the rows the conversation timeline
//! draws. pi's own items pass through; activity, tool and summary rows are built by the app.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::driver::{
    SessionTranscriptCard, SessionTranscriptCustomMessage, SessionTranscriptMessage,
    SessionTranscriptPin,
};
use super::present;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineTone {
    Neutral,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineToolStatus {
    Running,
    Success,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineSummaryPresentation {
    Inline,
    Divider,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineActivity {
    pub id: String,
    pub created_at: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<TimelineTone>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineToolCall {
    pub id: String,
    pub call_id: String,
    pub tool_name: String,
    pub status: TimelineToolStatus,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
    pub created_at: String,
    /// `null` is kept as `Some(Value::Null)`; only a missing value is `None`.
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSummary {
    pub id: String,
    pub created_at: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
    pub presentation: TimelineSummaryPresentation,
}

/// `TranscriptMessage`: one row of a thread's transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TranscriptMessage {
    Message(SessionTranscriptMessage),
    Custom(SessionTranscriptCustomMessage),
    Card(SessionTranscriptCard),
    Pin(SessionTranscriptPin),
    Activity(TimelineActivity),
    Tool(TimelineToolCall),
    Summary(TimelineSummary),
}

impl TranscriptMessage {
    pub fn id(&self) -> &str {
        match self {
            Self::Message(item) => &item.id,
            Self::Custom(item) => &item.id,
            Self::Card(item) => &item.id,
            Self::Pin(item) => &item.id,
            Self::Activity(item) => &item.id,
            Self::Tool(item) => &item.id,
            Self::Summary(item) => &item.id,
        }
    }

    pub fn created_at(&self) -> &str {
        match self {
            Self::Message(item) => &item.created_at,
            Self::Custom(item) => &item.created_at,
            Self::Card(item) => &item.created_at,
            Self::Pin(item) => &item.created_at,
            Self::Activity(item) => &item.created_at,
            Self::Tool(item) => &item.created_at,
            Self::Summary(item) => &item.created_at,
        }
    }
}

/// `isCardEntryItem`: a card, or the row that says why a card or pin entry was not drawn.
pub fn is_card_entry_item(item: &TranscriptMessage) -> bool {
    match item {
        TranscriptMessage::Card(_) => true,
        TranscriptMessage::Custom(custom) => {
            custom.custom_type == super::driver::EXTENSION_CARD_CUSTOM_TYPE
                || custom.custom_type == super::driver::EXTENSION_PIN_CUSTOM_TYPE
        }
        _ => false,
    }
}
