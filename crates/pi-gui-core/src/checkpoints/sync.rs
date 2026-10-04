//! Small single-thread coordination pieces: an abort signal like the DOM's `AbortSignal`,
//! and a way to wait until a piece of work has finished, like awaiting its settled promise.

use tokio::sync::watch;

/// Aborts its signals when told to, or when dropped (the call that owned it went away).
pub struct AbortController {
    sender: watch::Sender<bool>,
}

impl AbortController {
    pub fn new() -> Self {
        Self {
            sender: watch::channel(false).0,
        }
    }

    pub fn signal(&self) -> AbortSignal {
        AbortSignal {
            receiver: Some(self.sender.subscribe()),
        }
    }

    pub fn abort(&self) {
        self.sender.send_replace(true);
    }
}

impl Drop for AbortController {
    fn drop(&mut self) {
        self.abort();
    }
}

#[derive(Clone)]
pub struct AbortSignal {
    receiver: Option<watch::Receiver<bool>>,
}

impl AbortSignal {
    /// A signal that never aborts.
    pub fn never() -> Self {
        Self { receiver: None }
    }

    /// A signal that has already aborted.
    pub fn aborted_now() -> Self {
        let controller = AbortController::new();
        controller.signal()
    }

    pub fn is_aborted(&self) -> bool {
        self.receiver
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow())
    }

    /// Resolves once aborted; never, for a signal that cannot abort.
    pub async fn aborted(&self) {
        if let Some(receiver) = &self.receiver {
            let mut receiver = receiver.clone();
            if receiver.wait_for(|aborted| *aborted).await.is_ok() {
                return;
            }
        }
        std::future::pending::<()>().await
    }
}

/// Held by a piece of work while it runs; dropping it settles the matching `Settled`.
pub struct Running {
    _sender: watch::Sender<()>,
}

#[derive(Clone)]
pub struct Settled {
    receiver: watch::Receiver<()>,
}

pub fn running() -> (Running, Settled) {
    let (sender, receiver) = watch::channel(());
    (Running { _sender: sender }, Settled { receiver })
}

impl Settled {
    /// Waits until the work has finished, however it ended.
    pub async fn wait(&self) {
        let mut receiver = self.receiver.clone();
        while receiver.changed().await.is_ok() {}
    }

    pub fn same(&self, other: &Settled) -> bool {
        self.receiver.same_channel(&other.receiver)
    }
}
