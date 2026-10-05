//! `PendingComposerDraftFlusher`: asks renderers to send their debounced composer drafts
//! before their window goes away, or before the kernel switches a window's thread on an
//! extension's behalf. Each request ends when the window acknowledges it, closes, or the bound
//! passes, so quitting never waits on an unresponsive renderer. Call it outside the action
//! queue: the draft save goes through that queue.

use super::super::{publish, Kernel, WindowId};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::oneshot;

/// How long a window gets to save its draft.
pub const DRAFT_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct DraftFlusher {
    next_request_id: Cell<u64>,
    waiting: RefCell<HashMap<u64, (WindowId, oneshot::Sender<()>)>>,
}

impl DraftFlusher {
    pub async fn flush(&self, kernel: &Kernel, windows: &[WindowId]) {
        super::super::futures_join_all(
            windows
                .iter()
                .map(|window| self.flush_window(kernel, *window)),
        )
        .await;
    }

    /// The window's main frame acknowledged `request_id`.
    pub fn acknowledge(&self, window: WindowId, request_id: u64) {
        let mut waiting = self.waiting.borrow_mut();
        if waiting
            .get(&request_id)
            .is_some_and(|(owner, _)| *owner == window)
        {
            if let Some((_, done)) = waiting.remove(&request_id) {
                let _ = done.send(());
            }
        }
    }

    /// The window closed: nothing it owes will come.
    pub fn forget_window(&self, window: WindowId) {
        self.waiting
            .borrow_mut()
            .retain(|_, (owner, _)| *owner != window);
    }

    async fn flush_window(&self, kernel: &Kernel, window: WindowId) {
        if kernel.shell().presence(window).is_none() {
            return;
        }
        let request_id = self.next_request_id.get() + 1;
        self.next_request_id.set(request_id);
        let (done, acknowledged) = oneshot::channel();
        self.waiting.borrow_mut().insert(request_id, (window, done));
        publish::send_to(
            kernel,
            window,
            "pi-gui:flush-pending-composer-draft",
            &request_id,
        );
        if tokio::time::timeout(DRAFT_FLUSH_TIMEOUT, acknowledged)
            .await
            .is_err()
        {
            eprintln!("pi-gui: a window did not save its composer draft in time.");
        }
        self.waiting.borrow_mut().remove(&request_id);
    }
}
