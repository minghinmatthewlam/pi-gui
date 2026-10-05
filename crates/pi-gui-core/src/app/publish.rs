//! Getting state to the windows: `emit` stamps the revision and pushes each window its own
//! projection (`projectStateForView`), selected transcripts go out as raw JSON with a version
//! per thread, and streaming bursts are coalesced to one publish per 50 ms
//! (`StreamingUiPublisher`).

use super::shell::Push;
use super::{sessions, ui, AppData, Kernel, WindowId};
use crate::js::JsNumber;
use crate::state::desktop_state::{
    AppView, ComposerDraftSyncSource, DesktopAppState, SelectedTranscriptRecord,
};
use crate::state::driver::SessionStatus;
use crate::state::driver::{session_key, SessionDriverEvent, SessionEventKind, SessionRef};
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;
use tokio::task::AbortHandle;

/// `STREAMING_UI_PUBLISH_INTERVAL_MS`.
pub const STREAMING_UI_PUBLISH_INTERVAL: Duration = Duration::from_millis(50);

/// What a window shows: its own thread and view (`WindowViewState`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewState {
    pub selected_workspace_id: String,
    pub selected_session_id: String,
    pub active_view: AppView,
    pub sidebar_collapsed: bool,
}

/// `viewFromState`.
pub fn view_from_state(state: &DesktopAppState) -> ViewState {
    ViewState {
        selected_workspace_id: state.selected_workspace_id.clone(),
        selected_session_id: state.selected_session_id.clone(),
        active_view: state.active_view,
        sidebar_collapsed: state.sidebar_collapsed,
    }
}

/// Publish bookkeeping.
pub struct Publisher {
    /// `publishRevision`.
    revision: Cell<f64>,
    /// Pending coalesced publishes by session key.
    streaming: RefCell<HashMap<String, AbortHandle>>,
    /// Last seen `runningRunId` by session key.
    tracked_run_id: RefCell<HashMap<String, String>>,
    /// The last transcript JSON built for each thread and its version, bumped when it changes.
    transcripts: RefCell<HashMap<String, (u64, Rc<str>)>>,
}

impl Default for Publisher {
    fn default() -> Self {
        Self {
            revision: Cell::new(1.0),
            streaming: RefCell::new(HashMap::new()),
            tracked_run_id: RefCell::new(HashMap::new()),
            transcripts: RefCell::new(HashMap::new()),
        }
    }
}

impl Publisher {
    /// The version of `json` for `key`: the same as last time when nothing changed.
    pub fn transcript_version(&self, key: &str, json: Rc<str>) -> (u64, Rc<str>) {
        let mut transcripts = self.transcripts.borrow_mut();
        match transcripts.get(key) {
            Some((version, previous)) if **previous == *json => (*version, previous.clone()),
            Some((version, _)) => {
                let next = (version + 1, json);
                transcripts.insert(key.to_owned(), next.clone());
                next
            }
            None => {
                let next = (1, json);
                transcripts.insert(key.to_owned(), next.clone());
                next
            }
        }
    }

    /// `shouldDefer`.
    pub fn should_defer(&self, event: &SessionDriverEvent) -> bool {
        should_defer_streaming_ui_publish(
            event,
            self.tracked_run_id
                .borrow()
                .get(&session_key(&event.session_ref))
                .map(String::as_str),
        )
    }

    /// `observe`: records the run id after the defer decision for this event.
    pub fn observe(&self, event: &SessionDriverEvent) {
        let key = session_key(&event.session_ref);
        match &event.kind {
            SessionEventKind::SessionClosed { .. } => {
                self.tracked_run_id.borrow_mut().remove(&key);
            }
            SessionEventKind::SessionUpdated { snapshot }
                if snapshot.status == SessionStatus::Running =>
            {
                if let Some(run_id) = snapshot.running_run_id.as_ref().filter(|id| !id.is_empty()) {
                    self.tracked_run_id.borrow_mut().insert(key, run_id.clone());
                }
            }
            _ => {}
        }
    }

    /// `schedule`: one publish for the thread after the interval, however many events come.
    pub fn schedule(&self, kernel: &Kernel, session_ref: &SessionRef) {
        let key = session_key(session_ref);
        if self.streaming.borrow().contains_key(&key) {
            return;
        }
        let target = kernel.rc();
        let session_ref = session_ref.clone();
        let timer_key = key.clone();
        let task = tokio::task::spawn_local(async move {
            tokio::time::sleep(STREAMING_UI_PUBLISH_INTERVAL).await;
            target.publisher.streaming.borrow_mut().remove(&timer_key);
            emit(&target);
            publish_selected_transcript_for(&target, &session_ref);
        });
        self.streaming.borrow_mut().insert(key, task.abort_handle());
    }

    /// `cancel`: a discrete event is about to publish itself.
    pub fn cancel(&self, session_ref: &SessionRef) {
        if let Some(timer) = self
            .streaming
            .borrow_mut()
            .remove(&session_key(session_ref))
        {
            timer.abort();
        }
    }

    pub fn clear_streaming(&self) {
        for (_, timer) in self.streaming.borrow_mut().drain() {
            timer.abort();
        }
    }

    pub fn has_pending_streaming(&self, session_ref: &SessionRef) -> bool {
        self.streaming
            .borrow()
            .contains_key(&session_key(session_ref))
    }
}

/// `shouldDeferStreamingUiPublish`.
pub fn should_defer_streaming_ui_publish(
    event: &SessionDriverEvent,
    tracked_run_id: Option<&str>,
) -> bool {
    match &event.kind {
        SessionEventKind::AssistantDelta { .. } => true,
        SessionEventKind::SessionUpdated { snapshot }
            if snapshot.status == SessionStatus::Running =>
        {
            match snapshot.running_run_id.as_deref() {
                Some(run_id) if !run_id.is_empty() => Some(run_id) == tracked_run_id,
                _ => false,
            }
        }
        _ => false,
    }
}

/// `emit`: stamps a revision higher than any published before and pushes every window its
/// projection. Returns the published state.
pub fn emit(kernel: &Kernel) -> DesktopAppState {
    let snapshot = {
        let mut data = kernel.data.borrow_mut();
        let revision = kernel.publisher.revision.get().max(data.state.revision.0) + 1.0;
        kernel.publisher.revision.set(revision);
        data.state.revision = JsNumber(revision);
        data.state.clone()
    };
    for window in kernel.windows.ids() {
        kernel.windows.publish_state(kernel, window, &snapshot);
        kernel.windows.publish_transcript_soon(kernel, window);
    }
    ui::after_emit(kernel, &snapshot);
    super::notifications::after_emit(kernel, &snapshot);
    snapshot
}

/// `publishSelectedTranscript`: every window republishes its own thread's transcript.
pub fn publish_selected_transcript(kernel: &Kernel) {
    for window in kernel.windows.ids() {
        kernel.windows.publish_transcript_soon(kernel, window);
    }
}

/// `publishSelectedTranscriptFor`.
pub fn publish_selected_transcript_for(kernel: &Kernel, session_ref: &SessionRef) {
    if kernel.data.borrow().is_selected(session_ref) {
        publish_selected_transcript(kernel);
    }
}

/// `SelectedTranscriptRecord` serialized straight from the caches.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptRecordRef<'a> {
    workspace_id: &'a str,
    session_id: &'a str,
    transcript: &'a [crate::state::timeline_types::TranscriptMessage],
    #[serde(skip_serializing_if = "Option::is_none")]
    schema_info: Option<&'a crate::state::driver::SessionSchemaInfo>,
}

/// `buildSelectedTranscriptRecord` as JSON, with its version.
pub fn selected_transcript_json(kernel: &Kernel, session_ref: &SessionRef) -> (u64, Rc<str>) {
    sessions::ensure_session_schema_info(kernel, session_ref);
    let key = session_key(session_ref);
    let json: Rc<str> = {
        let data = kernel.data.borrow();
        let record = TranscriptRecordRef {
            workspace_id: &session_ref.workspace_id,
            session_id: &session_ref.session_id,
            transcript: data
                .sessions
                .transcript_cache
                .get(&key)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            schema_info: data.session_schema_info.get(&key),
        };
        serde_json::to_string(&record).unwrap_or_default().into()
    };
    kernel.publisher.transcript_version(&key, json)
}

/// `buildSelectedTranscriptRecord`, typed, for callers inside the kernel.
pub fn selected_transcript_record(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> SelectedTranscriptRecord {
    sessions::ensure_session_schema_info(kernel, session_ref);
    let key = session_key(session_ref);
    let data = kernel.data.borrow();
    SelectedTranscriptRecord {
        workspace_id: session_ref.workspace_id.clone(),
        session_id: session_ref.session_id.clone(),
        transcript: data
            .sessions
            .transcript_cache
            .get(&key)
            .cloned()
            .unwrap_or_default(),
        schema_info: data.session_schema_info.get(&key).cloned(),
    }
}

/// Pushes any other JSON message to every window.
pub fn broadcast(kernel: &Kernel, channel: &'static str, payload: &impl Serialize) {
    let json: Rc<str> = serde_json::to_string(payload).unwrap_or_default().into();
    for window in kernel.windows.ids() {
        kernel.shell().send(
            window,
            Push::Json {
                channel,
                json: json.clone(),
            },
        );
    }
}

/// Pushes a JSON message to one window.
pub fn send_to(kernel: &Kernel, window: WindowId, channel: &'static str, payload: &impl Serialize) {
    let json: Rc<str> = serde_json::to_string(payload).unwrap_or_default().into();
    kernel.shell().send(window, Push::Json { channel, json });
}

// ---- projectStateForView ----

/// `resolveViewWorkspaceId`.
pub fn resolve_view_workspace_id(preferred: &str, state: &DesktopAppState) -> String {
    let has = |id: &str| state.workspaces.iter().any(|workspace| workspace.id == id);
    if !preferred.is_empty() && has(preferred) {
        return preferred.to_owned();
    }
    if !state.selected_workspace_id.is_empty() && has(&state.selected_workspace_id) {
        return state.selected_workspace_id.clone();
    }
    state
        .workspaces
        .first()
        .map(|workspace| workspace.id.clone())
        .unwrap_or_default()
}

/// `resolveViewSessionId`.
pub fn resolve_view_session_id(
    workspace_id: &str,
    preferred: &str,
    state: &DesktopAppState,
) -> String {
    let Some(workspace) = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
    else {
        return String::new();
    };
    let has = |id: &str| workspace.sessions.iter().any(|session| session.id == id);
    if !preferred.is_empty() && has(preferred) {
        return preferred.to_owned();
    }
    if state.selected_workspace_id == workspace_id && has(&state.selected_session_id) {
        return state.selected_session_id.clone();
    }
    workspace
        .sessions
        .first()
        .map(|session| session.id.clone())
        .unwrap_or_default()
}

fn targets_session(source: ComposerDraftSyncSource) -> bool {
    matches!(
        source,
        ComposerDraftSyncSource::ExtensionEditorText
            | ComposerDraftSyncSource::Persist
            | ComposerDraftSyncSource::Command
            | ComposerDraftSyncSource::QueuedMessageEdit
    )
}

/// `projectStateForView`: the state as a window showing `view` sees it.
pub fn project_state_for_view(
    data: &mut AppData,
    view: &ViewState,
    state: &DesktopAppState,
    previous_view: Option<&ViewState>,
) -> DesktopAppState {
    let workspace_id = resolve_view_workspace_id(&view.selected_workspace_id, state);
    let session_id = resolve_view_session_id(&workspace_id, &view.selected_session_id, state);
    let (previous_workspace_id, previous_session_id) = match previous_view {
        Some(previous) => {
            let workspace = resolve_view_workspace_id(&previous.selected_workspace_id, state);
            let session = resolve_view_session_id(&workspace, &previous.selected_session_id, state);
            (workspace, session)
        }
        None => (workspace_id.clone(), session_id.clone()),
    };
    let selection_changed =
        workspace_id != previous_workspace_id || session_id != previous_session_id;
    let matches_state_selection =
        workspace_id == state.selected_workspace_id && session_id == state.selected_session_id;
    let sync_targets_projected_session = targets_session(state.composer_draft_sync_source)
        && data
            .composer_draft_sync_target
            .as_ref()
            .is_some_and(|target| {
                target.workspace_id == workspace_id && target.session_id == session_id
            });
    let sync_source = if selection_changed {
        ComposerDraftSyncSource::Selection
    } else if sync_targets_projected_session
        || (matches_state_selection && !targets_session(state.composer_draft_sync_source))
    {
        state.composer_draft_sync_source
    } else {
        ComposerDraftSyncSource::State
    };
    let nonce = if selection_changed
        && !(matches_state_selection
            && state.composer_draft_sync_source == ComposerDraftSyncSource::Selection)
    {
        sessions::allocate_composer_draft_sync_nonce(data, state.composer_draft_sync_nonce.0)
    } else {
        state.composer_draft_sync_nonce.0
    };
    let mut projected = state.clone();
    projected.composer_draft =
        sessions::resolve_composer_draft(data, &workspace_id, &session_id, None);
    projected.composer_draft_sync_source = sync_source;
    projected.composer_draft_sync_nonce = JsNumber(nonce);
    projected.composer_attachments =
        sessions::resolve_composer_attachments(data, &workspace_id, &session_id);
    projected.queued_composer_messages =
        sessions::resolve_queued_composer_messages(data, &workspace_id, &session_id);
    projected.editing_queued_message_id =
        sessions::resolve_editing_queued_message_id(data, &workspace_id, &session_id);
    projected.last_error =
        sessions::resolve_selected_session_error(data, &workspace_id, &session_id, false).or_else(
            || {
                if session_id.is_empty() {
                    state.last_error.clone()
                } else {
                    None
                }
            },
        );
    projected.selected_workspace_id = workspace_id;
    projected.selected_session_id = session_id;
    projected.active_view = view.active_view;
    projected.sidebar_collapsed = view.sidebar_collapsed;
    projected
}

/// `applyView`: makes `view` the store's own selection.
pub fn apply_view(kernel: &Kernel, view: &ViewState) {
    let mut data = kernel.data.borrow_mut();
    let state = data.state.clone();
    let projected = project_state_for_view(&mut data, view, &state, None);
    data.state = projected;
}

/// `getStateForView` without waiting for startup.
pub fn state_for_view(kernel: &Kernel, view: &ViewState) -> DesktopAppState {
    let mut data = kernel.data.borrow_mut();
    let state = data.state.clone();
    project_state_for_view(&mut data, view, &state, None)
}

/// Runs the session event listeners (`emitSessionEvent`), each isolated from the others.
pub async fn emit_session_event(
    kernel: &Kernel,
    event: &SessionDriverEvent,
    snapshot: &DesktopAppState,
) {
    if let Err(error) = super::notifications::on_session_event(kernel, event, snapshot).await {
        eprintln!(
            "[app-store] session event listener failed: {}",
            error.message
        );
    }
    if let Err(error) = super::orchestration::on_session_event(kernel, event, snapshot).await {
        eprintln!(
            "[app-store] session event listener failed: {}",
            error.message
        );
    }
}
