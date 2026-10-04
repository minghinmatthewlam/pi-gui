//! Twin of the pure helpers in `apps/desktop/electron/application/app-store-utils.ts`.

use std::cmp::Ordering;

use indexmap::IndexMap;
use serde_json::Value;

use super::desktop_state::{
    ComposerAttachment, QueuedComposerMessage, SessionRecord, WorkspaceKind, WorkspaceRecord,
    WorktreeRecord,
};
use super::driver::{
    session_ref, SessionAttachment, SessionConfig, SessionQueuedMessage, SessionRef, SessionStatus,
    SessionTranscriptMessage, SessionTranscriptRole,
};
use super::env::StateEnv;
use super::js::{self, JsNumber};
use super::timeline_types::{
    TimelineActivity, TimelineSummary, TimelineSummaryPresentation, TimelineTone, TimelineToolCall,
    TimelineToolStatus, TranscriptMessage,
};
use crate::persistence::catalog::{
    compare_display_names, SessionEntry, WorkspaceEntry, WorktreeEntry, WorktreeKind,
};

pub const LEGACY_TRANSCRIPT_HISTORY_LIMIT: usize = 180;

/// Per-session maps keyed by `sessionKey`, in insertion order like a JavaScript `Map`.
pub type SessionMap<V> = IndexMap<String, V>;

/// The per-session caches `buildWorkspaceRecords` reads.
pub struct SessionRecordSources<'a> {
    pub transcript_cache: &'a SessionMap<Vec<TranscriptMessage>>,
    pub running_since_by_session: &'a SessionMap<String>,
    pub session_config_by_session: &'a SessionMap<SessionConfig>,
    pub last_viewed_at_by_session: &'a SessionMap<String>,
    pub last_interacted_at_by_session: &'a SessionMap<String>,
    pub pinned_at_by_session: &'a SessionMap<String>,
}

/// `buildWorkspaceRecords`: the sidebar's folders and threads from the catalog and caches.
pub fn build_workspace_records(
    workspaces: &[WorkspaceEntry],
    worktrees: &[WorktreeEntry],
    sessions: &[SessionEntry],
    sources: &SessionRecordSources<'_>,
) -> Vec<WorkspaceRecord> {
    let workspace_roots = resolve_workspace_roots(workspaces, worktrees);
    workspaces
        .iter()
        .map(|workspace| {
            let root_workspace_id = workspace_roots
                .get(&workspace.workspace_id)
                .cloned()
                .flatten();
            let branch_name = root_workspace_id
                .as_deref()
                .and_then(|root| linked_worktree_branch_name(workspace, worktrees, root));
            WorkspaceRecord {
                id: workspace.workspace_id.clone(),
                name: workspace.display_name.clone(),
                path: workspace.path.clone(),
                last_opened_at: workspace.last_opened_at.clone(),
                kind: if root_workspace_id.is_some() {
                    WorkspaceKind::Worktree
                } else {
                    WorkspaceKind::Primary
                },
                root_workspace_id,
                branch_name,
                sessions: sessions
                    .iter()
                    .filter(|session| session.workspace_id == workspace.workspace_id)
                    .map(|session| build_session_record(session, sources))
                    .collect(),
            }
        })
        .collect()
}

/// `buildWorktreeRecords`: each folder's app worktrees, newest first.
pub fn build_worktree_records(
    workspaces: &[WorkspaceEntry],
    worktrees: &[WorktreeEntry],
) -> IndexMap<String, Vec<WorktreeRecord>> {
    let owner_by_path = resolve_worktree_owners(worktrees);
    let mut linked_workspace_ids_by_path: IndexMap<&str, &str> = IndexMap::new();
    for workspace in workspaces {
        linked_workspace_ids_by_path.insert(&workspace.path, &workspace.workspace_id);
    }
    let mut groups: IndexMap<String, Vec<WorktreeRecord>> = IndexMap::new();
    for worktree in worktrees {
        if worktree.kind != WorktreeKind::Linked
            || owner_by_path.get(worktree.path.as_str()) != Some(&worktree.workspace_id.as_str())
        {
            continue;
        }
        groups
            .entry(worktree.workspace_id.clone())
            .or_default()
            .push(WorktreeRecord {
                id: worktree.worktree_id.clone(),
                root_workspace_id: worktree.workspace_id.clone(),
                linked_workspace_id: linked_workspace_ids_by_path
                    .get(worktree.path.as_str())
                    .map(|id| id.to_string()),
                name: worktree.display_name.clone(),
                path: worktree.path.clone(),
                status: worktree.status,
                branch_name: worktree.branch_name.clone(),
                updated_at: worktree.updated_at.clone(),
            });
    }
    for entries in groups.values_mut() {
        entries.sort_by(|left, right| {
            if left.updated_at != right.updated_at {
                return compare_display_names(&right.updated_at, &left.updated_at);
            }
            compare_display_names(&left.name, &right.name)
        });
    }
    groups
}

/// The folder that lists each app worktree; the first row wins if an older catalog has two.
fn resolve_worktree_owners(worktrees: &[WorktreeEntry]) -> IndexMap<&str, &str> {
    let mut owner_by_path = IndexMap::new();
    for worktree in worktrees {
        if worktree.kind == WorktreeKind::Linked {
            owner_by_path
                .entry(worktree.path.as_str())
                .or_insert(worktree.workspace_id.as_str());
        }
    }
    owner_by_path
}

fn resolve_workspace_roots(
    workspaces: &[WorkspaceEntry],
    worktrees: &[WorktreeEntry],
) -> IndexMap<String, Option<String>> {
    let owner_by_path = resolve_worktree_owners(worktrees);
    workspaces
        .iter()
        .map(|workspace| {
            let owner = owner_by_path.get(workspace.path.as_str()).copied();
            let root = owner
                .filter(|owner| *owner != workspace.workspace_id)
                .map(str::to_string);
            (workspace.workspace_id.clone(), root)
        })
        .collect()
}

fn linked_worktree_branch_name(
    workspace: &WorkspaceEntry,
    worktrees: &[WorktreeEntry],
    root_workspace_id: &str,
) -> Option<String> {
    worktrees
        .iter()
        .find(|worktree| {
            worktree.kind == WorktreeKind::Linked
                && worktree.path == workspace.path
                && worktree.workspace_id == root_workspace_id
        })
        .and_then(|worktree| worktree.branch_name.clone())
}

fn build_session_record(
    session: &SessionEntry,
    sources: &SessionRecordSources<'_>,
) -> SessionRecord {
    let key = session.session_ref.key();
    let transcript = sources
        .transcript_cache
        .get(&key)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let preview = preview_from_transcript(transcript)
        .or_else(|| session.preview_snippet.clone())
        .unwrap_or_else(|| session.title.clone());
    let last_viewed_at = sources.last_viewed_at_by_session.get(&key).cloned();
    SessionRecord {
        id: session.session_ref.session_id.clone(),
        title: session.title.clone(),
        updated_at: session.updated_at.clone(),
        pinned_at: sources.pinned_at_by_session.get(&key).cloned(),
        last_interacted_at: sources.last_interacted_at_by_session.get(&key).cloned(),
        archived_at: session.archived_at.clone(),
        preview,
        status: session.status,
        running_since: sources.running_since_by_session.get(&key).cloned(),
        has_unseen_update: has_unseen_session_update(
            session.status,
            &session.updated_at,
            last_viewed_at.as_deref(),
            transcript,
        ),
        last_viewed_at,
        config: sources.session_config_by_session.get(&key).cloned(),
    }
}

/// `hasUnseenSessionUpdate`.
pub fn has_unseen_session_update(
    status: SessionStatus,
    updated_at: &str,
    last_viewed_at: Option<&str>,
    transcript: &[TranscriptMessage],
) -> bool {
    let Some(last_viewed_at) = last_viewed_at.filter(|value| !value.is_empty()) else {
        return false;
    };
    if status == SessionStatus::Running {
        return false;
    }
    js::js_string_cmp(
        latest_session_activity_at(updated_at, transcript),
        last_viewed_at,
    ) == Ordering::Greater
}

/// `latestSessionActivityAt`: the latest of `updatedAt` and every row's `createdAt`, compared
/// as strings.
pub fn latest_session_activity_at<'a>(
    updated_at: &'a str,
    transcript: &'a [TranscriptMessage],
) -> &'a str {
    let mut latest = updated_at;
    for item in transcript {
        if js::js_string_cmp(item.created_at(), latest) == Ordering::Greater {
            latest = item.created_at();
        }
    }
    latest
}

/// `toSessionRef`.
pub fn to_session_ref(workspace_id: &str, session_id: &str) -> SessionRef {
    session_ref(workspace_id, session_id)
}

/// `makeTranscriptMessage`.
pub fn make_transcript_message(
    env: &dyn StateEnv,
    role: SessionTranscriptRole,
    text: &str,
) -> SessionTranscriptMessage {
    SessionTranscriptMessage {
        role,
        text: text.to_string(),
        attachments: None,
        created_at: env.now_iso(),
        id: env.random_uuid(),
        source_message_id: None,
        extra: Default::default(),
    }
}

/// `makeTranscriptMessageWithAttachments`.
pub fn make_transcript_message_with_attachments(
    env: &dyn StateEnv,
    role: SessionTranscriptRole,
    text: &str,
    attachments: &[SessionAttachment],
) -> SessionTranscriptMessage {
    let mut message = make_transcript_message(env, role, text);
    if !attachments.is_empty() {
        message.attachments = Some(attachments.to_vec());
    }
    message
}

/// `cloneComposerAttachments`: the attachments that still have a usable shape, from saved
/// data that may be older or hand-edited.
pub fn clone_composer_attachments(attachments: &[Value]) -> Vec<ComposerAttachment> {
    attachments
        .iter()
        .filter_map(normalize_composer_attachment)
        .collect()
}

fn normalize_composer_attachment(value: &Value) -> Option<ComposerAttachment> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let kind = value.get("kind");
    // A missing kind is an image, from before file attachments existed.
    if kind.is_none() || kind.and_then(Value::as_str) == Some("image") {
        if let (Some(id), Some(name), Some(mime_type), Some(data)) =
            (text("id"), text("name"), text("mimeType"), text("data"))
        {
            return Some(ComposerAttachment::Image {
                id,
                name,
                mime_type,
                data,
            });
        }
    }
    if kind.and_then(Value::as_str) == Some("file") {
        if let (Some(id), Some(name), Some(mime_type), Some(fs_path)) =
            (text("id"), text("name"), text("mimeType"), text("fsPath"))
        {
            return Some(ComposerAttachment::File {
                id,
                name,
                mime_type,
                fs_path,
                size_bytes: value.get("sizeBytes").and_then(Value::as_f64).map(JsNumber),
            });
        }
    }
    None
}

/// `toSessionAttachments`, also `toTranscriptAttachments` (the same shapes).
pub fn to_session_attachments(attachments: &[ComposerAttachment]) -> Vec<SessionAttachment> {
    attachments
        .iter()
        .map(|attachment| match attachment {
            ComposerAttachment::Image {
                name,
                mime_type,
                data,
                ..
            } => SessionAttachment::Image {
                mime_type: mime_type.clone(),
                data: data.clone(),
                name: Some(name.clone()),
            },
            ComposerAttachment::File {
                name,
                mime_type,
                fs_path,
                size_bytes,
                ..
            } => SessionAttachment::File {
                name: name.clone(),
                mime_type: mime_type.clone(),
                fs_path: fs_path.clone(),
                size_bytes: *size_bytes,
            },
        })
        .collect()
}

/// `toTranscriptAttachments`.
pub fn to_transcript_attachments(attachments: &[ComposerAttachment]) -> Vec<SessionAttachment> {
    to_session_attachments(attachments)
}

/// `toSessionQueuedMessages`.
pub fn to_session_queued_messages(messages: &[QueuedComposerMessage]) -> Vec<SessionQueuedMessage> {
    messages
        .iter()
        .map(|message| SessionQueuedMessage {
            id: message.id.clone(),
            mode: message.mode,
            text: message.text.clone(),
            attachments: (!message.attachments.is_empty())
                .then(|| to_session_attachments(&message.attachments)),
            created_at: message.created_at.clone(),
            updated_at: message.updated_at.clone(),
        })
        .collect()
}

/// `mergeQueuedComposerMessages`: pi's queue, keeping the composer's attachment ids where an
/// attachment is unchanged.
pub fn merge_queued_composer_messages(
    env: &dyn StateEnv,
    previous: Option<&[QueuedComposerMessage]>,
    next: Option<&[SessionQueuedMessage]>,
) -> Vec<QueuedComposerMessage> {
    let Some(next) = next.filter(|next| !next.is_empty()) else {
        return Vec::new();
    };
    let mut previous_by_id: IndexMap<&str, &QueuedComposerMessage> = IndexMap::new();
    for message in previous.unwrap_or_default() {
        previous_by_id.insert(&message.id, message);
    }
    next.iter()
        .map(|message| {
            let existing = previous_by_id.get(message.id.as_str());
            QueuedComposerMessage {
                id: message.id.clone(),
                mode: message.mode,
                text: message.text.clone(),
                attachments: merge_queued_composer_attachments(
                    env,
                    existing.map(|existing| existing.attachments.as_slice()),
                    message.attachments.as_deref(),
                    &message.id,
                ),
                created_at: message.created_at.clone(),
                updated_at: message.updated_at.clone(),
            }
        })
        .collect()
}

fn merge_queued_composer_attachments(
    env: &dyn StateEnv,
    previous: Option<&[ComposerAttachment]>,
    next: Option<&[SessionAttachment]>,
    message_id: &str,
) -> Vec<ComposerAttachment> {
    let Some(next) = next.filter(|next| !next.is_empty()) else {
        return Vec::new();
    };
    next.iter()
        .enumerate()
        .map(|(index, attachment)| {
            let existing = previous.and_then(|previous| previous.get(index));
            match (existing, attachment) {
                (
                    Some(
                        existing @ ComposerAttachment::Image {
                            name,
                            mime_type,
                            data: kept,
                            ..
                        },
                    ),
                    SessionAttachment::Image {
                        mime_type: next_mime,
                        data,
                        name: next_name,
                    },
                ) if next_name.as_deref() == Some(name.as_str())
                    && next_mime == mime_type
                    && data == kept =>
                {
                    return existing.clone();
                }
                (
                    Some(
                        existing @ ComposerAttachment::File {
                            name,
                            mime_type,
                            fs_path: kept_path,
                            size_bytes: kept_size,
                            ..
                        },
                    ),
                    SessionAttachment::File {
                        name: next_name,
                        mime_type: next_mime,
                        fs_path,
                        size_bytes,
                    },
                ) if next_name == name
                    && next_mime == mime_type
                    && fs_path == kept_path
                    && size_bytes == kept_size =>
                {
                    return existing.clone();
                }
                _ => {}
            }
            match attachment {
                SessionAttachment::Image {
                    mime_type,
                    data,
                    name,
                } => ComposerAttachment::Image {
                    id: format!("{message_id}:image:{index}:{}", env.random_uuid()),
                    name: name
                        .clone()
                        .unwrap_or_else(|| format!("Image {}", index + 1)),
                    mime_type: mime_type.clone(),
                    data: data.clone(),
                },
                SessionAttachment::File {
                    name,
                    mime_type,
                    fs_path,
                    size_bytes,
                } => ComposerAttachment::File {
                    id: format!("{message_id}:file:{index}:{}", env.random_uuid()),
                    name: name.clone(),
                    mime_type: mime_type.clone(),
                    fs_path: fs_path.clone(),
                    size_bytes: *size_bytes,
                },
            }
        })
        .collect()
}

/// Options for `makeActivityItem`.
#[derive(Default)]
pub struct ActivityOptions {
    pub detail: Option<String>,
    pub metadata: Option<String>,
    pub tone: Option<TimelineTone>,
}

/// `makeActivityItem`.
pub fn make_activity_item(
    env: &dyn StateEnv,
    label: &str,
    options: ActivityOptions,
) -> TranscriptMessage {
    TranscriptMessage::Activity(TimelineActivity {
        id: env.random_uuid(),
        created_at: env.now_iso(),
        label: label.to_string(),
        detail: options.detail,
        metadata: options.metadata,
        tone: options.tone,
    })
}

/// `makeSummaryItem`. An empty `metadata` is left out, as the TypeScript does.
pub fn make_summary_item(
    env: &dyn StateEnv,
    label: &str,
    presentation: Option<TimelineSummaryPresentation>,
    metadata: Option<String>,
) -> TranscriptMessage {
    TranscriptMessage::Summary(TimelineSummary {
        id: env.random_uuid(),
        created_at: env.now_iso(),
        label: label.to_string(),
        metadata: metadata.filter(|metadata| !metadata.is_empty()),
        presentation: presentation.unwrap_or(TimelineSummaryPresentation::Inline),
    })
}

/// Options for `makeToolItem`.
#[derive(Default)]
pub struct ToolItemOptions {
    pub detail: Option<String>,
    pub metadata: Option<String>,
    pub input: Option<Value>,
    pub output: Option<Value>,
}

/// `makeToolItem`: a tool row, identified by its call id.
pub fn make_tool_item(
    env: &dyn StateEnv,
    call_id: &str,
    tool_name: &str,
    status: TimelineToolStatus,
    label: String,
    options: ToolItemOptions,
) -> TimelineToolCall {
    TimelineToolCall {
        id: call_id.to_string(),
        call_id: call_id.to_string(),
        tool_name: tool_name.to_string(),
        status,
        label,
        detail: options.detail,
        metadata: options.metadata,
        created_at: env.now_iso(),
        input: options.input,
        output: options.output,
    }
}

/// `previewFromTranscript`: the latest assistant reply, else the latest message, tool or
/// activity label.
pub fn preview_from_transcript(transcript: &[TranscriptMessage]) -> Option<String> {
    for item in transcript.iter().rev() {
        if let TranscriptMessage::Message(message) = item {
            if message.role == SessionTranscriptRole::Assistant {
                return Some(message.text.clone());
            }
        }
    }
    for item in transcript.iter().rev() {
        match item {
            TranscriptMessage::Message(message) => return Some(message.text.clone()),
            TranscriptMessage::Tool(tool) => return Some(tool.label.clone()),
            TranscriptMessage::Activity(activity) => return Some(activity.label.clone()),
            _ => {}
        }
    }
    None
}

/// `formatElapsedDuration`: "42s", "3m" or "3m 5s", at least one second.
pub fn format_elapsed_duration(env: &dyn StateEnv, started_at: &str, ended_at: &str) -> String {
    let diff_ms = js::js_max(0.0, env.date_parse(ended_at) - env.date_parse(started_at));
    let seconds = js::js_max(1.0, js::js_round(diff_ms / 1000.0));
    if seconds < 60.0 {
        return format!("{}s", js::number_to_string(seconds));
    }
    let minutes = (seconds / 60.0).floor();
    let remaining = seconds % 60.0;
    if remaining == 0.0 {
        format!("{}m", js::number_to_string(minutes))
    } else {
        format!(
            "{}m {}s",
            js::number_to_string(minutes),
            js::number_to_string(remaining)
        )
    }
}
