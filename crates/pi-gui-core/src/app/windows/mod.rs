//! Windows: each one's own thread and view, the one action queue they share, and asking them
//! for their unsaved drafts (`window-owner.ts`, `action-queue.ts`, `pending-draft-flush.ts`).

pub mod draft_flush;
pub mod queue;
pub mod views;
