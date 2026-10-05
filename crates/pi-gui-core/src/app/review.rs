//! Review and the task workbench (`ipc/review-requests.ts`, `ipc/workbench-requests.ts` and the
//! workbench half of `app-store.ts`). So far: a task's saved workbench layout. Review, turn
//! changes and file staging still answer "not ported".

use super::dispatch::{self, InvokeCall, MethodTable, Reply};
use super::validation::{self, Arg};
use super::{persist, Kernel, Readiness, WindowId};
use crate::error::{CoreError, CoreResult};
use crate::state::driver::{session_key, SessionRef};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// The last save sequence each window sent, and the queue saves and reads wait in.
#[derive(Default)]
pub struct WorkbenchRequests {
    /// By window; replaced on a renderer reset so saves already queued are dropped.
    renderers: RefCell<HashMap<WindowId, Rc<std::cell::Cell<u64>>>>,
    queue: tokio::sync::Mutex<()>,
}

impl WorkbenchRequests {
    /// `resetRenderer`: a reload or a closed window forgets its sequence.
    pub fn reset_renderer(&self, window: WindowId) {
        self.renderers.borrow_mut().remove(&window);
    }
}

pub fn register(table: &mut MethodTable) {
    table.on("getTaskWorkbenchTemplate", |kernel, call| {
        Box::pin(async move {
            dispatch::main_frame(&kernel, &call, "pi-gui:get-task-workbench-template")?;
            let target = validation::expect_session_target(call.arg(0), "target")?;
            let _turn = kernel.workbench.queue.lock().await;
            let template = get_task_workbench_template(&kernel, &target).await?;
            Ok(Reply::Value(template.unwrap_or(Value::Null)))
        })
    });
    table.on("saveTaskWorkbenchTemplate", |kernel, call| {
        Box::pin(async move { save(&kernel, &call).await })
    });
}

async fn save(kernel: &Kernel, call: &InvokeCall) -> CoreResult<Reply> {
    let window = dispatch::main_frame(kernel, call, "pi-gui:save-task-workbench-template")?;
    let input = validation::expect_save_task_workbench_template_input(call.arg(0))?;
    let sequence = input["sequence"].as_u64().unwrap_or(0);
    let renderer = kernel
        .workbench
        .renderers
        .borrow_mut()
        .entry(window)
        .or_default()
        .clone();
    if sequence <= renderer.get() {
        return Ok(Reply::Undefined);
    }
    renderer.set(sequence);
    let _turn = kernel.workbench.queue.lock().await;
    // A renderer reload drops requests that have not started writing yet.
    let current = kernel.workbench.renderers.borrow().get(&window).cloned();
    if !current.is_some_and(|current| Rc::ptr_eq(&current, &renderer)) {
        return Ok(Reply::Undefined);
    }
    let target: SessionRef = crate::parse(input["target"].clone())?;
    save_task_workbench_template(kernel, &target, &input["template"]).await?;
    Ok(Reply::Undefined)
}

/// `decodeTaskWorkbenchTemplate` at the IPC boundary.
pub fn decode_task_workbench_template(value: Arg) -> CoreResult<Value> {
    crate::persistence::workbench_template::decode(value.unwrap_or(&Value::Null))
        .map_err(CoreError::new)
}

/// `requireWorkbenchTask`.
fn require_workbench_task(kernel: &Kernel, target: &SessionRef) -> CoreResult<()> {
    let data = kernel.data.borrow();
    if data.persistence != Readiness::Ready {
        return Err(CoreError::new(
            "Saved UI state is unavailable; repair or restore it before saving layouts.",
        ));
    }
    if data.session(target).is_none() {
        return Err(CoreError::new(
            "Workbench task does not exist in this workspace.",
        ));
    }
    Ok(())
}

/// `getTaskWorkbenchTemplate`.
pub async fn get_task_workbench_template(
    kernel: &Kernel,
    target: &SessionRef,
) -> CoreResult<Option<Value>> {
    kernel.initialize().await;
    require_workbench_task(kernel, target)?;
    Ok(kernel
        .data
        .borrow()
        .task_workbench_templates_by_session
        .get(&session_key(target))
        .cloned())
}

/// `saveTaskWorkbenchTemplate`: saved without an emit, so another window showing the task
/// keeps its layout; restored if the write fails.
pub async fn save_task_workbench_template(
    kernel: &Kernel,
    target: &SessionRef,
    template: &Value,
) -> CoreResult<()> {
    kernel.initialize().await;
    require_workbench_task(kernel, target)?;
    let key = session_key(target);
    let validated = decode_task_workbench_template(Some(template))?;
    let previous = kernel
        .data
        .borrow_mut()
        .task_workbench_templates_by_session
        .insert(key.clone(), validated.clone());
    if let Err(error) = persist::persist_ui_state(kernel).await {
        let mut data = kernel.data.borrow_mut();
        let templates = &mut data.task_workbench_templates_by_session;
        if templates.get(&key) == Some(&validated) {
            match previous {
                Some(previous) => {
                    templates.insert(key, previous);
                }
                None => {
                    templates.shift_remove(&key);
                }
            }
        }
        return Err(error);
    }
    Ok(())
}
