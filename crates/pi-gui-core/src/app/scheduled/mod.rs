//! Scheduled tasks (`scheduled-tasks/app-store-scheduled-tasks.ts`). So far: loading and
//! saving `scheduled-tasks.json`. Creating, editing and firing tasks still answer
//! "not ported"; no timer runs.

use super::dispatch::MethodTable;
use super::Kernel;
use crate::error::CoreResult;
use crate::state::desktop_state::ScheduledTaskRecord;
use serde::Deserialize;
use serde_json::{json, Value};

/// What the scheduled-task part keeps besides `state.scheduledTasks`.
#[derive(Default)]
pub struct ScheduledState {}

pub fn register(_table: &mut MethodTable) {}

#[derive(Deserialize)]
struct LoadedTasks {
    tasks: Vec<ScheduledTaskRecord>,
}

/// Startup's `readScheduledTasksFile`: the error message when the file could not be read,
/// which also turns the runner and saving off.
pub async fn load_scheduled_tasks(kernel: &Kernel) -> Option<String> {
    let loaded = kernel
        .core_call(crate::methods::SCHEDULED_TASKS_READ, Value::Null)
        .await
        .and_then(crate::parse::<LoadedTasks>);
    match loaded {
        Ok(loaded) => {
            let mut data = kernel.data.borrow_mut();
            data.state.scheduled_tasks = loaded.tasks;
            data.scheduled_tasks_writable = true;
            None
        }
        Err(error) => {
            eprintln!(
                "[app-store] scheduled-tasks.json is invalid; runner disabled: {}",
                error.message
            );
            let mut data = kernel.data.borrow_mut();
            data.scheduled_tasks_writable = false;
            data.state.scheduled_tasks = Vec::new();
            Some(error.message)
        }
    }
}

/// `persistScheduledTasks`: only once the file was read.
pub async fn persist_scheduled_tasks(kernel: &Kernel) -> CoreResult<()> {
    let tasks = {
        let data = kernel.data.borrow();
        if !data.scheduled_tasks_writable {
            return Ok(());
        }
        data.state.scheduled_tasks.clone()
    };
    kernel
        .core_call(
            crate::methods::SCHEDULED_TASKS_WRITE,
            json!({ "tasks": tasks }),
        )
        .await?;
    Ok(())
}

/// `scheduleScheduledTasks`. Not ported: no task fires.
pub fn schedule_scheduled_tasks(_kernel: &Kernel) {}
