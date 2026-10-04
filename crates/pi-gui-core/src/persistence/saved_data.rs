//! The saved files besides the catalog, as `uiState.*`, `attachments.*`, `scheduledTasks.*`
//! and `reviewed.*` calls. Each file's work runs off the core's thread, one call at a time
//! per file in arrival order, as the old queued TypeScript writes did.

use super::backed_file::FileQueue;
use super::reviewed::ReviewedMarks;
use super::{attachments, scheduled_tasks, ui_state};
use crate::error::{CoreError, CoreResult};
use crate::methods;
use crate::parse;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub struct SavedData {
    ui_state: PathBuf,
    attachments: PathBuf,
    scheduled_tasks: PathBuf,
    reviewed: ReviewedMarks,
    queue: FileQueue,
}

impl SavedData {
    /// The same file names inside the profile folder as before.
    pub fn new(user_data_dir: &Path) -> Self {
        Self {
            ui_state: user_data_dir.join("ui-state.json"),
            attachments: user_data_dir.join("attachments"),
            scheduled_tasks: user_data_dir.join("scheduled-tasks.json"),
            reviewed: ReviewedMarks::new(user_data_dir.join("reviewed-files.json")),
            queue: FileQueue::default(),
        }
    }
}

#[derive(Deserialize)]
struct UiStateWrite {
    state: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionKey {
    session_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentsWrite {
    session_key: String,
    attachments: Value,
}

#[derive(Deserialize)]
struct TasksWrite {
    tasks: Value,
}

#[derive(Deserialize)]
struct ReviewedSet {
    key: String,
    reviewed: bool,
}

pub async fn call(saved: &SavedData, method: &str, params: Value) -> CoreResult<Value> {
    let done = |_: ()| Value::Null;
    match method {
        methods::UI_STATE_READ => {
            let path = saved.ui_state.clone();
            saved
                .queue
                .run(&saved.ui_state, move || ui_state::read(&path))
                .await
        }
        methods::UI_STATE_WRITE => {
            let UiStateWrite { state } = parse(params)?;
            let path = saved.ui_state.clone();
            saved
                .queue
                .run(&saved.ui_state, move || ui_state::write(&path, state))
                .await
                .map(done)
        }
        methods::ATTACHMENTS_READ => {
            let SessionKey { session_key } = parse(params)?;
            let root = saved.attachments.clone();
            let path = attachments::file_path(&root, &session_key);
            saved
                .queue
                .run(&path, move || attachments::read(&root, &session_key))
                .await
                .map(|found| found.unwrap_or(Value::Null))
        }
        methods::ATTACHMENTS_WRITE => {
            let AttachmentsWrite {
                session_key,
                attachments,
            } = parse(params)?;
            let root = saved.attachments.clone();
            let path = attachments::file_path(&root, &session_key);
            saved
                .queue
                .run(&path, move || {
                    attachments::write(&root, &session_key, &attachments)
                })
                .await
                .map(done)
        }
        methods::ATTACHMENTS_LIST_KEYS => {
            let root = saved.attachments.clone();
            let keys = saved
                .queue
                .run(&saved.attachments, move || attachments::list_keys(&root))
                .await?;
            Ok(Value::from(keys))
        }
        methods::ATTACHMENTS_REMOVE => {
            let SessionKey { session_key } = parse(params)?;
            let root = saved.attachments.clone();
            let path = attachments::file_path(&root, &session_key);
            saved
                .queue
                .run(&path, move || attachments::remove(&root, &session_key))
                .await
                .map(done)
        }
        methods::SCHEDULED_TASKS_READ => {
            let path = saved.scheduled_tasks.clone();
            saved
                .queue
                .run(&saved.scheduled_tasks, move || scheduled_tasks::read(&path))
                .await
        }
        methods::SCHEDULED_TASKS_WRITE => {
            let TasksWrite { tasks } = parse(params)?;
            let path = saved.scheduled_tasks.clone();
            saved
                .queue
                .run(&saved.scheduled_tasks, move || {
                    scheduled_tasks::write(&path, tasks)
                })
                .await
                .map(done)
        }
        methods::REVIEWED_SNAPSHOT => Ok(Value::from(saved.reviewed.snapshot(&saved.queue).await?)),
        methods::REVIEWED_SET => {
            let ReviewedSet { key, reviewed } = parse(params)?;
            saved
                .reviewed
                .set(&saved.queue, key, reviewed)
                .await
                .map(done)
        }
        other => Err(CoreError::new(format!("Unknown RPC method: {other}"))),
    }
}
