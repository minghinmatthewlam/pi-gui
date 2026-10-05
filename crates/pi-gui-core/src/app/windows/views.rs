//! `WindowOwner`: each window's own thread and view, which window is active, and running
//! state actions so the store works on the sender's view and every window gets its own
//! projection back.

use super::super::publish::{self, project_state_for_view, view_from_state, ViewState};
use super::super::shell::Push;
use super::super::{notifications, sessions, Kernel, WindowId};
use crate::error::{CoreError, CoreResult};
use crate::state::desktop_state::{AppView, ComposerDraftSyncSource, DesktopAppState};
use crate::state::driver::SessionRef;
use indexmap::IndexMap;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::rc::Rc;

/// What the last transcript push to a window was: a thread and its version, or `null`.
type PublishedTranscript = Option<(String, u64)>;

#[derive(Default)]
pub struct WindowViews {
    views: RefCell<IndexMap<WindowId, ViewState>>,
    last_transcript: RefCell<HashMap<WindowId, PublishedTranscript>>,
    active_window: Cell<Option<WindowId>>,
    active_action: Cell<Option<WindowId>>,
    deferred_activation: Cell<Option<WindowId>>,
    draft_persist_origin: Cell<Option<WindowId>>,
    /// Windows whose renderer is gone: state is not pushed to them until their page loads.
    recovering: RefCell<HashSet<WindowId>>,
}

/// The window a state action started from (`beginAction`'s context).
pub struct ActionContext {
    window: Option<WindowId>,
    previous_action: Option<WindowId>,
}

impl WindowViews {
    /// Open windows, oldest first.
    pub fn ids(&self) -> Vec<WindowId> {
        self.views.borrow().keys().copied().collect()
    }

    /// Open windows that hear state changes: all but those whose renderer is gone.
    pub fn publishing_ids(&self) -> Vec<WindowId> {
        let recovering = self.recovering.borrow();
        self.ids()
            .into_iter()
            .filter(|window| !recovering.contains(window))
            .collect()
    }

    pub fn contains(&self, window: WindowId) -> bool {
        self.views.borrow().contains_key(&window)
    }

    fn can_publish(kernel: &Kernel, window: WindowId) -> bool {
        kernel.shell().presence(window).is_some()
    }

    /// `add`: a new window starts on `source_view`, or on the store's own view.
    pub fn add(&self, kernel: &Kernel, window: WindowId, source_view: Option<ViewState>) {
        let view = {
            let mut data = kernel.data.borrow_mut();
            let state = data.state.clone();
            let base = source_view.unwrap_or_else(|| view_from_state(&state));
            view_from_state(&project_state_for_view(&mut data, &base, &state, None))
        };
        let first = self.views.borrow().is_empty();
        self.views.borrow_mut().insert(window, view);
        self.last_transcript.borrow_mut().remove(&window);
        self.active_window.set(Some(window));
        if first {
            notifications::on_first_window(kernel);
        }
    }

    /// `remove`.
    pub fn remove(&self, kernel: &Kernel, window: WindowId) {
        if self.views.borrow_mut().shift_remove(&window).is_none() {
            return;
        }
        self.last_transcript.borrow_mut().remove(&window);
        self.recovering.borrow_mut().remove(&window);
        kernel.draft_flush.forget_window(window);
        kernel.workbench.reset_renderer(window);
        super::super::extensions::views::close_sender(kernel, window);
        super::super::workspace::terminal::on_window_closed(kernel, window);
        if self.active_window.get() == Some(window) {
            let next = self.ids().into_iter().next();
            self.active_window.set(next);
            if let Some(next) = next {
                self.apply_view_to_state_owner(kernel, next);
            }
        }
    }

    /// A window closed (main's `closed`): its view goes, then dialogs on threads that no
    /// visible window shows any more are cancelled.
    pub fn closed(&self, kernel: &Kernel, window: WindowId) {
        self.remove(kernel, window);
        let kernel = kernel.rc();
        tokio::task::spawn_local(async move {
            if let Err(error) = cancel_pending_dialogs_without_visible_window(&kernel).await {
                eprintln!(
                    "[main] cancelPendingDialogsWithoutVisibleWindow failed {}",
                    error.message
                );
            }
        });
    }

    /// `render-process-gone`: the window stops hearing state changes until its page loads.
    pub fn renderer_gone(&self, window: WindowId) {
        if self.contains(window) {
            self.recovering.borrow_mut().insert(window);
        }
    }

    /// `did-finish-load` after a reload or a renderer that was gone: the window lost its
    /// pushes; send them again.
    pub fn renderer_reset(&self, kernel: &Kernel, window: WindowId) {
        if !self.contains(window) {
            return;
        }
        self.recovering.borrow_mut().remove(&window);
        self.last_transcript.borrow_mut().remove(&window);
        kernel.workbench.reset_renderer(window);
        // The old page's extension frames went with it.
        super::super::extensions::views::close_sender(kernel, window);
        let snapshot = kernel.data.borrow().state.clone();
        self.publish_state(kernel, window, &snapshot);
        self.publish_transcript_soon(kernel, window);
    }

    /// `active`.
    pub fn active(&self, kernel: &Kernel) -> Option<WindowId> {
        self.active_window
            .get()
            .filter(|window| Self::can_publish(kernel, *window))
    }

    /// `foreground`: the focused window, else the active one, else any.
    pub fn foreground(&self, kernel: &Kernel) -> Option<WindowId> {
        if let Some(focused) = kernel.shell().focused_window() {
            if self.contains(focused) && Self::can_publish(kernel, focused) {
                return Some(focused);
            }
        }
        if let Some(active) = self.active(kernel) {
            return Some(active);
        }
        self.ids()
            .into_iter()
            .find(|window| Self::can_publish(kernel, *window))
    }

    /// `windowForSender`.
    pub fn require(&self, kernel: &Kernel, window: WindowId) -> CoreResult<WindowId> {
        if self.contains(window) && Self::can_publish(kernel, window) {
            Ok(window)
        } else {
            Err(CoreError::new("IPC sender is not an active pi-gui window"))
        }
    }

    /// `viewForWindow`.
    pub fn view_for_window(&self, kernel: &Kernel, window: WindowId) -> ViewState {
        self.views
            .borrow()
            .get(&window)
            .cloned()
            .unwrap_or_else(|| view_from_state(&kernel.data.borrow().state))
    }

    /// `targetForSender`.
    pub fn target_for_window(&self, kernel: &Kernel, window: WindowId) -> Option<SessionRef> {
        let view = self.view_for_window(kernel, window);
        (!view.selected_workspace_id.is_empty() && !view.selected_session_id.is_empty()).then(
            || {
                crate::state::driver::session_ref(
                    &view.selected_workspace_id,
                    &view.selected_session_id,
                )
            },
        )
    }

    /// `isSessionVisibleInAnotherWindow`: another visible window shows this thread.
    pub fn is_session_visible_in_another_window(
        &self,
        kernel: &Kernel,
        session_ref: &SessionRef,
    ) -> bool {
        let views = self.views.borrow();
        views.iter().any(|(window, view)| {
            let shown = kernel
                .shell()
                .presence(*window)
                .is_some_and(|presence| presence.visible && !presence.minimized);
            shown
                && Some(*window) != self.active_action.get()
                && view.active_view == AppView::Threads
                && view.selected_workspace_id == session_ref.workspace_id
                && view.selected_session_id == session_ref.session_id
        })
    }

    /// `activate`: on focus, show or restore. Waits for a running action to end.
    pub fn activate(&self, kernel: &Kernel, window: WindowId) {
        if !self.contains(window) {
            return;
        }
        if self.active_action.get().is_some() {
            self.deferred_activation.set(Some(window));
        } else {
            self.apply_activation(kernel, window);
        }
        notifications::on_window_activated(kernel);
    }

    fn apply_activation(&self, kernel: &Kernel, window: WindowId) {
        self.active_window.set(Some(window));
        self.apply_view_to_state_owner(kernel, window);
        sessions::handle_window_activation(kernel);
        let view = view_from_state(&kernel.data.borrow().state);
        self.views.borrow_mut().insert(window, view);
    }

    fn apply_deferred_activation(&self, kernel: &Kernel) -> bool {
        let Some(window) = self.deferred_activation.take() else {
            return false;
        };
        if !self.contains(window) || !Self::can_publish(kernel, window) {
            return false;
        }
        self.apply_activation(kernel, window);
        true
    }

    fn apply_view_to_state_owner(&self, kernel: &Kernel, window: WindowId) {
        let view = self.view_for_window(kernel, window);
        publish::apply_view(kernel, &view);
    }

    fn restore_foreground_unless_sender(&self, kernel: &Kernel, sender: Option<WindowId>) {
        let Some(foreground) = self.foreground(kernel) else {
            return;
        };
        if Some(foreground) == sender {
            return;
        }
        self.apply_view_to_state_owner(kernel, foreground);
        publish::emit(kernel);
    }

    /// `beginAction`.
    pub fn begin_action(
        &self,
        kernel: &Kernel,
        window: Option<WindowId>,
        force_active: bool,
    ) -> ActionContext {
        let live = window.filter(|window| self.contains(*window));
        if let Some(live) = live {
            let sender_is_foreground = self.foreground(kernel) == Some(live);
            let focused = kernel
                .shell()
                .presence(live)
                .is_some_and(|presence| presence.focused);
            if focused || sender_is_foreground || force_active {
                self.active_window.set(Some(live));
            }
            self.apply_view_to_state_owner(kernel, live);
        }
        let previous_action = self.active_action.replace(live);
        ActionContext {
            window: live,
            previous_action,
        }
    }

    /// `endAction`.
    pub fn end_action(&self, kernel: &Kernel, context: &ActionContext) {
        self.active_action.set(context.previous_action);
        if !self.apply_deferred_activation(kernel) {
            self.restore_foreground_unless_sender(kernel, context.window);
        }
    }

    /// `finishStateAction`: the sender's view follows the action's result.
    pub fn finish_state_action(
        &self,
        kernel: &Kernel,
        window: WindowId,
        state: &DesktopAppState,
    ) -> DesktopAppState {
        let previous = self.views.borrow().get(&window).cloned();
        let projected = self.project_state(
            kernel,
            window,
            state,
            &view_from_state(state),
            previous.as_ref(),
        );
        self.views
            .borrow_mut()
            .insert(window, view_from_state(&projected));
        self.publish_state(kernel, window, &projected);
        self.publish_transcript_soon(kernel, window);
        projected
    }

    /// `projectAndRemember`.
    pub fn project_and_remember(
        &self,
        kernel: &Kernel,
        window: WindowId,
        state: &DesktopAppState,
    ) -> DesktopAppState {
        let view = self
            .views
            .borrow()
            .get(&window)
            .cloned()
            .unwrap_or_else(|| view_from_state(state));
        let previous = self.views.borrow().get(&window).cloned();
        let projected = self.project_state(kernel, window, state, &view, previous.as_ref());
        self.views
            .borrow_mut()
            .insert(window, view_from_state(&projected));
        projected
    }

    /// `projectState`: a draft saved from one window reads as `remote-persist` in the others.
    fn project_state(
        &self,
        kernel: &Kernel,
        window: WindowId,
        state: &DesktopAppState,
        view: &ViewState,
        previous: Option<&ViewState>,
    ) -> DesktopAppState {
        let mut projected = {
            let mut data = kernel.data.borrow_mut();
            project_state_for_view(&mut data, view, state, previous)
        };
        if projected.composer_draft_sync_source == ComposerDraftSyncSource::Persist {
            if let Some(origin) = self.draft_persist_origin.get() {
                if origin != window {
                    projected.composer_draft_sync_source = ComposerDraftSyncSource::RemotePersist;
                }
            }
        }
        projected
    }

    /// `publishState`.
    pub fn publish_state(&self, kernel: &Kernel, window: WindowId, state: &DesktopAppState) {
        if !Self::can_publish(kernel, window) || !self.contains(window) {
            return;
        }
        let view = if Some(window) == self.active_action.get() {
            view_from_state(state)
        } else {
            self.view_for_window_or(window, state)
        };
        let previous = self.views.borrow().get(&window).cloned();
        let projected = self.project_state(kernel, window, state, &view, previous.as_ref());
        self.views
            .borrow_mut()
            .insert(window, view_from_state(&projected));
        let json: Rc<str> = serde_json::to_string(&projected).unwrap_or_default().into();
        kernel.shell().send(window, Push::State(json));
    }

    fn view_for_window_or(&self, window: WindowId, state: &DesktopAppState) -> ViewState {
        self.views
            .borrow()
            .get(&window)
            .cloned()
            .unwrap_or_else(|| view_from_state(state))
    }

    /// `publishTranscriptSoon`.
    pub fn publish_transcript_soon(&self, kernel: &Kernel, window: WindowId) {
        let kernel = kernel.rc();
        tokio::task::spawn_local(async move {
            if let Err(error) = kernel.windows.publish_transcript(&kernel, window).await {
                eprintln!(
                    "[window-owner] failed to publish selected transcript: {}",
                    error.message
                );
            }
        });
    }

    /// `publishTranscript`: sends the window's thread's transcript when it changed.
    async fn publish_transcript(&self, kernel: &Kernel, window: WindowId) -> CoreResult<()> {
        if !Self::can_publish(kernel, window) || !self.contains(window) {
            return Ok(());
        }
        let view = self.view_for_window(kernel, window);
        let payload = sessions::selected_transcript_for_view(kernel, &view).await?;
        if !Self::can_publish(kernel, window) || !self.contains(window) {
            return Ok(());
        }
        let snapshot = kernel.data.borrow().state.clone();
        let view = self.view_for_window_or(window, &snapshot);
        let previous = self.views.borrow().get(&window).cloned();
        let projected = self.project_state(kernel, window, &snapshot, &view, previous.as_ref());
        let published = match &payload {
            Some((session_ref, version, _)) => {
                if projected.selected_workspace_id != session_ref.workspace_id
                    || projected.selected_session_id != session_ref.session_id
                {
                    return Ok(());
                }
                Some((crate::state::driver::session_key(session_ref), *version))
            }
            None if !projected.selected_session_id.is_empty() => return Ok(()),
            None => None,
        };
        if self.last_transcript.borrow().get(&window) == Some(&published) {
            return Ok(());
        }
        self.last_transcript.borrow_mut().insert(window, published);
        let json: Rc<str> = match payload {
            Some((_, _, json)) => json,
            None => "null".into(),
        };
        kernel.shell().send(window, Push::Transcript(json));
        Ok(())
    }

    /// `runStateAction`: queued behind other actions, run on the sender's view.
    pub async fn run_state_action<F, Fut>(
        &self,
        kernel: &Kernel,
        window: Option<WindowId>,
        force_active: bool,
        action: F,
    ) -> CoreResult<DesktopAppState>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = CoreResult<DesktopAppState>>,
    {
        kernel
            .queue
            .run(async {
                let context = self.begin_action(kernel, window, force_active);
                let result = action().await;
                let result = match (result, context.window) {
                    (Ok(state), Some(window)) => {
                        Ok(self.finish_state_action(kernel, window, &state))
                    }
                    (result, _) => result,
                };
                self.end_action(kernel, &context);
                result
            })
            .await
    }

    /// `runStateResultAction`: as `run_state_action` for results that carry a `state`.
    pub async fn run_state_result_action<F, Fut>(
        &self,
        kernel: &Kernel,
        window: Option<WindowId>,
        action: F,
    ) -> CoreResult<serde_json::Value>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = CoreResult<(serde_json::Value, DesktopAppState)>>,
    {
        kernel
            .queue
            .run(async {
                let context = self.begin_action(kernel, window, false);
                let result = action().await;
                let result = result.map(|(mut value, state)| {
                    let state = match context.window {
                        Some(window) => self.finish_state_action(kernel, window, &state),
                        None => state,
                    };
                    if let Some(object) = value.as_object_mut() {
                        object.insert(
                            "state".into(),
                            serde_json::to_value(&state).unwrap_or_default(),
                        );
                    }
                    value
                });
                self.end_action(kernel, &context);
                result
            })
            .await
    }

    /// `runUnscopedStateAction`: not queued; the result is projected for the sender.
    pub async fn run_unscoped_state_action(
        &self,
        kernel: &Kernel,
        window: Option<WindowId>,
        action: impl Future<Output = CoreResult<DesktopAppState>>,
    ) -> CoreResult<DesktopAppState> {
        let state = action.await?;
        match window.filter(|window| Self::can_publish(kernel, *window) && self.contains(*window)) {
            Some(window) => Ok(self.project_and_remember(kernel, window, &state)),
            None => Ok(state),
        }
    }

    /// `runImmediateStateAction`: not queued; the sender gets its state pushed at once.
    pub async fn run_immediate_state_action(
        &self,
        kernel: &Kernel,
        window: Option<WindowId>,
        action: impl Future<Output = CoreResult<DesktopAppState>>,
    ) -> CoreResult<DesktopAppState> {
        let state = action.await?;
        let Some(window) =
            window.filter(|window| Self::can_publish(kernel, *window) && self.contains(*window))
        else {
            return Ok(state);
        };
        let projected = self.project_and_remember(kernel, window, &state);
        let json: Rc<str> = serde_json::to_string(&projected).unwrap_or_default().into();
        kernel.shell().send(window, Push::State(json));
        self.publish_transcript_soon(kernel, window);
        Ok(projected)
    }

    /// `withComposerDraftPersistOrigin`.
    pub async fn with_draft_persist_origin<T>(
        &self,
        window: WindowId,
        action: impl Future<Output = T>,
    ) -> T {
        let previous = self.draft_persist_origin.replace(Some(window));
        let result = action.await;
        self.draft_persist_origin.set(previous);
        result
    }
}

/// `cancelPendingDialogsWithoutVisibleWindow`.
async fn cancel_pending_dialogs_without_visible_window(kernel: &Kernel) -> CoreResult<()> {
    kernel.initialize().await;
    let pending: Vec<SessionRef> = {
        let data = kernel.data.borrow();
        data.state
            .workspaces
            .iter()
            .flat_map(|workspace| {
                workspace
                    .sessions
                    .iter()
                    .map(|session| crate::state::driver::session_ref(&workspace.id, &session.id))
            })
            .filter(|session_ref| {
                data.sessions
                    .extension_ui_by_session
                    .get(&crate::state::driver::session_key(session_ref))
                    .is_some_and(|ui| !ui.pending_dialogs.is_empty())
            })
            .collect()
    };
    let pending: Vec<SessionRef> = pending
        .into_iter()
        .filter(|session_ref| {
            !kernel
                .windows
                .is_session_visible_in_another_window(kernel, session_ref)
        })
        .collect();
    let cancels = pending
        .iter()
        .map(|session_ref| sessions::cancel_pending_dialogs_for_session(kernel, session_ref, true));
    for result in super::super::futures_join_all(cancels).await {
        result?;
    }
    Ok(())
}
