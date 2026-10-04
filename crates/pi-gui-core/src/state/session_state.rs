//! Twin of `apps/desktop/electron/conversation/app-store-session-state.ts`: a session event's
//! effect on the thread's sidebar record.

use super::app_store_utils::{has_unseen_session_update, preview_from_transcript, SessionMap};
use super::desktop_state::{DesktopAppState, SessionRecord};
use super::driver::{
    session_key, SessionConfig, SessionDriverEvent, SessionEventKind, SessionSnapshot,
    SessionStatus,
};
use super::js::JsNumber;
use super::timeline::TranscriptCache;
use super::timeline_types::TranscriptMessage;

/// `NEW_THREAD_PLACEHOLDER_TITLE` from `conversation/thread-title-constants.ts`.
pub const NEW_THREAD_PLACEHOLDER_TITLE: &str = "New thread";

/// `applySessionEventState`: updates the event's thread record and bumps the revision. The
/// TypeScript returns a new state object; this changes `state` in place.
pub fn apply_session_event_state(
    state: &mut DesktopAppState,
    event: &SessionDriverEvent,
    transcript_cache: &TranscriptCache,
    running_since_by_session: &SessionMap<String>,
    last_viewed_at_by_session: &SessionMap<String>,
) {
    let key = session_key(&event.session_ref);
    let transcript = transcript_cache
        .get(&key)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let preview = preview_from_transcript(transcript);
    let last_viewed_at = last_viewed_at_by_session.get(&key);

    for workspace in &mut state.workspaces {
        if workspace.id != event.session_ref.workspace_id {
            continue;
        }
        for session in &mut workspace.sessions {
            if session.id != event.session_ref.session_id {
                continue;
            }
            let status = status_for_event(session.status, event);
            *session = update_session_record(
                session,
                SessionRecordUpdate {
                    snapshot: snapshot_for_event(event).map(SnapshotFields::from),
                    status: Some(status),
                    transcript,
                    preview: preview.clone(),
                    running_since: running_since_by_session.get(&key).cloned(),
                    last_viewed_at: last_viewed_at.cloned(),
                },
            );
        }
    }
    state.revision = JsNumber(state.revision.0 + 1.0);
}

/// The snapshot fields `updateSessionRecord` reads (`Partial<Pick<SessionSnapshot, …>>`).
#[derive(Debug, Clone, Default)]
pub struct SnapshotFields {
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub archived_at: Option<String>,
    pub preview: Option<String>,
    pub status: Option<SessionStatus>,
    pub config: Option<SessionConfig>,
}

impl From<&SessionSnapshot> for SnapshotFields {
    fn from(snapshot: &SessionSnapshot) -> Self {
        Self {
            title: Some(snapshot.title.clone()),
            updated_at: Some(snapshot.updated_at.clone()),
            archived_at: snapshot.archived_at.clone(),
            preview: snapshot.preview.clone(),
            status: Some(snapshot.status),
            config: snapshot.config.clone(),
        }
    }
}

/// The options of `updateSessionRecord`.
pub struct SessionRecordUpdate<'a> {
    pub snapshot: Option<SnapshotFields>,
    pub status: Option<SessionStatus>,
    pub transcript: &'a [TranscriptMessage],
    pub preview: Option<String>,
    pub running_since: Option<String>,
    pub last_viewed_at: Option<String>,
}

/// `updateSessionRecord`.
pub fn update_session_record(
    session: &SessionRecord,
    options: SessionRecordUpdate<'_>,
) -> SessionRecord {
    let snapshot = options.snapshot.unwrap_or_default();
    let updated_at = snapshot
        .updated_at
        .unwrap_or_else(|| session.updated_at.clone());
    let next_status = options.status.or(snapshot.status).unwrap_or(session.status);
    // Queued session events may predate a rename; the placeholder must not replace a
    // resolved title.
    let title = match snapshot.title {
        Some(title)
            if title == NEW_THREAD_PLACEHOLDER_TITLE
                && session.title != NEW_THREAD_PLACEHOLDER_TITLE =>
        {
            session.title.clone()
        }
        Some(title) => title,
        None => session.title.clone(),
    };
    SessionRecord {
        id: session.id.clone(),
        title,
        has_unseen_update: has_unseen_session_update(
            next_status,
            &updated_at,
            options.last_viewed_at.as_deref(),
            options.transcript,
        ),
        updated_at,
        pinned_at: session.pinned_at.clone(),
        last_viewed_at: options.last_viewed_at,
        last_interacted_at: session.last_interacted_at.clone(),
        archived_at: snapshot.archived_at.or_else(|| session.archived_at.clone()),
        preview: options
            .preview
            .or(snapshot.preview)
            .unwrap_or_else(|| session.preview.clone()),
        status: next_status,
        running_since: options.running_since,
        config: snapshot.config.or_else(|| session.config.clone()),
    }
}

fn snapshot_for_event(event: &SessionDriverEvent) -> Option<&SessionSnapshot> {
    match &event.kind {
        SessionEventKind::SessionOpened { snapshot }
        | SessionEventKind::SessionUpdated { snapshot }
        | SessionEventKind::RunCompleted { snapshot } => Some(snapshot),
        _ => None,
    }
}

fn status_for_event(session_status: SessionStatus, event: &SessionDriverEvent) -> SessionStatus {
    match &event.kind {
        SessionEventKind::SessionOpened { snapshot }
        | SessionEventKind::SessionUpdated { snapshot }
        | SessionEventKind::RunCompleted { snapshot } => snapshot.status,
        SessionEventKind::RunFailed { .. } => SessionStatus::Failed,
        SessionEventKind::SessionClosed { .. } => SessionStatus::Idle,
        _ => session_status,
    }
}
