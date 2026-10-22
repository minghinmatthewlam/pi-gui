//! Extension UI (the extension half of `app-store.ts`, `extensions/extension-notices.ts` and
//! `extension-actions.ts`): host UI requests and the answers to dialogs, dialog timeouts and
//! notices. Card buttons are in `actions`, extension views in `views`.

pub mod actions;
pub mod views;

use super::dispatch::{self, MethodTable};
use super::refresh::{self, RefreshOptions};
use super::validation::{self, Arg};
use super::{publish, sessions, AppData, Kernel};
use crate::error::CoreResult;
use crate::state::desktop_state::ComposerDraftSyncSource;
use crate::state::desktop_state::DesktopAppState;
use crate::state::desktop_state::SessionExtensionNoticeRecord;
use crate::state::driver::{session_key, HostUiRequest, NoticeLevel, SessionRef};
use crate::state::session_state_map::{
    apply_host_ui_request_to_extension_ui_state, create_empty_extension_ui_state,
    MutableSessionExtensionUiState,
};
use serde_json::{json, Map, Value};
use std::time::Duration;

/// Most toasts shown at once; the oldest drops when an extension notifies past this.
pub const EXTENSION_NOTICE_LIMIT: usize = 5;
/// How long a toast stays up.
pub const EXTENSION_NOTICE_TIMEOUT_MS: u64 = 6_000;

/// What the extensions part keeps besides the shared maps.
#[derive(Default)]
pub struct ExtensionsState {
    pub views: views::ViewConnections,
}

pub fn register(table: &mut MethodTable) {
    table.on("respondToHostUiRequest", |kernel, call| {
        Box::pin(async move {
            dispatch::immediate(&kernel, &call, async {
                let workspace_id = validation::expect_non_empty_string(call.arg(0), "workspaceId")?;
                let session_id = validation::expect_non_empty_string(call.arg(1), "sessionId")?;
                let response = validation::expect_host_ui_response(call.arg(2))?;
                let session_ref = crate::state::driver::session_ref(&workspace_id, &session_id);
                respond_to_host_ui_request(&kernel, &session_ref, response).await
            })
            .await
        })
    });
    actions::register(table);
    views::register(table);
}

/// `respondToHostUiRequest`: the dialog goes at once, then pi gets the answer.
async fn respond_to_host_ui_request(
    kernel: &Kernel,
    session_ref: &SessionRef,
    response: Value,
) -> CoreResult<DesktopAppState> {
    let request_id = response["requestId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    remove_pending_dialog(kernel, session_ref, &request_id);
    clear_dialog_timeout(&mut kernel.data.borrow_mut(), session_ref, &request_id);
    sessions::with_error_handling(kernel, async {
        kernel
            .driver()
            .call(
                "respondToHostUiRequest",
                super::pi::args([json!(session_ref), response]),
            )
            .await?;
        refresh::refresh_state(
            kernel,
            RefreshOptions {
                clear_last_error: true,
                ..Default::default()
            },
        )
        .await
    })
    .await
}

fn timer_key(session_ref: &SessionRef, request_id: &str) -> String {
    format!("{}:{request_id}", session_key(session_ref))
}

/// `extensionNoticeTimerId`: notice timers share the dialog timer map.
fn notice_timer_id(notice_id: &str) -> String {
    format!("notice:{notice_id}")
}

/// `clearExtensionDialogTimeout`.
pub fn clear_dialog_timeout(data: &mut AppData, session_ref: &SessionRef, request_id: &str) {
    if let Some(timer) = data
        .extension_dialog_timers
        .remove(&timer_key(session_ref, request_id))
    {
        timer.abort();
    }
}

/// `clearExtensionDialogTimeoutsForSession`: dialogs and notices alike.
pub fn clear_dialog_timeouts_for_session(data: &mut AppData, session_ref: &SessionRef) {
    let prefix = format!("{}:", session_key(session_ref));
    data.extension_dialog_timers.retain(|key, timer| {
        if key.starts_with(&prefix) {
            timer.abort();
            false
        } else {
            true
        }
    });
}

fn ui_state<'a>(
    kernel: &Kernel,
    data: &'a mut AppData,
    session_ref: &SessionRef,
) -> &'a mut MutableSessionExtensionUiState {
    data.sessions
        .extension_ui_by_session
        .entry(session_key(session_ref))
        .or_insert_with(|| create_empty_extension_ui_state(kernel.env()))
}

fn is_dialog(request: &HostUiRequest) -> bool {
    matches!(
        request,
        HostUiRequest::Confirm { .. }
            | HostUiRequest::Input { .. }
            | HostUiRequest::Select { .. }
            | HostUiRequest::Editor { .. }
    )
}

fn dialog_timeout_ms(request: &HostUiRequest) -> Option<f64> {
    match request {
        HostUiRequest::Confirm { timeout_ms, .. }
        | HostUiRequest::Input { timeout_ms, .. }
        | HostUiRequest::Select { timeout_ms, .. } => timeout_ms.map(|ms| ms.0),
        _ => None,
    }
}

/// `applyHostUiRequest`. The caller syncs the derived state and emits.
pub fn apply_host_ui_request(
    kernel: &Kernel,
    session_ref: &SessionRef,
    request: &HostUiRequest,
    timestamp: &str,
) {
    let key = session_key(session_ref);
    match request {
        HostUiRequest::Reset { .. } => {
            let mut data = kernel.data.borrow_mut();
            clear_dialog_timeouts_for_session(&mut data, session_ref);
            data.sessions.extension_ui_by_session.shift_remove(&key);
            return;
        }
        HostUiRequest::Dismiss { request_id } => {
            clear_dialog_timeout(&mut kernel.data.borrow_mut(), session_ref, request_id);
            remove_pending_dialog(kernel, session_ref, request_id);
            return;
        }
        _ => {}
    }
    {
        let mut data = kernel.data.borrow_mut();
        apply_host_ui_request_to_extension_ui_state(
            ui_state(kernel, &mut data, session_ref),
            request,
        );
    }
    match request {
        HostUiRequest::EditorText { text, .. } => {
            sessions::set_composer_draft_for_session(
                &mut kernel.data.borrow_mut(),
                session_ref,
                text,
                ComposerDraftSyncSource::ExtensionEditorText,
            );
        }
        HostUiRequest::Notify {
            request_id,
            message,
            level,
        } => add_notice(
            kernel,
            session_ref,
            SessionExtensionNoticeRecord {
                id: request_id.clone(),
                level: level.unwrap_or(NoticeLevel::Info),
                message: message.clone(),
                created_at: timestamp.to_owned(),
            },
        ),
        dialog if is_dialog(dialog) => {
            let request_id = sessions::dialog_request_id(dialog).to_owned();
            {
                let mut data = kernel.data.borrow_mut();
                clear_dialog_timeout(&mut data, session_ref, &request_id);
                let ui = ui_state(kernel, &mut data, session_ref);
                ui.pending_dialogs
                    .retain(|entry| sessions::dialog_request_id(entry) != request_id);
                ui.pending_dialogs.push(dialog.clone());
            }
            if let Some(timeout) = dialog_timeout_ms(dialog) {
                let weak = kernel.this_weak();
                let owner = session_ref.clone();
                let id = request_id.clone();
                schedule(
                    kernel,
                    timer_key(session_ref, &request_id),
                    timeout,
                    move || {
                        if let Some(kernel) = weak.upgrade() {
                            kernel
                                .data
                                .borrow_mut()
                                .extension_dialog_timers
                                .remove(&timer_key(&owner, &id));
                            remove_pending_dialog(&kernel, &owner, &id);
                        }
                    },
                );
            }
        }
        _ => {}
    }
}

/// Starts a timer kept in the dialog timer map under `key`.
fn schedule(kernel: &Kernel, key: String, delay_ms: f64, fire: impl FnOnce() + 'static) {
    let delay = Duration::from_millis(delay_ms.max(0.0).min(u32::MAX as f64) as u64);
    let task = tokio::task::spawn_local(async move {
        tokio::time::sleep(delay).await;
        fire();
    });
    kernel
        .data
        .borrow_mut()
        .extension_dialog_timers
        .insert(key, task.abort_handle());
}

/// `removePendingExtensionDialog`: emits when a dialog was removed.
pub fn remove_pending_dialog(kernel: &Kernel, session_ref: &SessionRef, request_id: &str) -> bool {
    {
        let mut data = kernel.data.borrow_mut();
        let Some(ui) = data
            .sessions
            .extension_ui_by_session
            .get_mut(&session_key(session_ref))
        else {
            return false;
        };
        let before = ui.pending_dialogs.len();
        ui.pending_dialogs
            .retain(|entry| sessions::dialog_request_id(entry) != request_id);
        if ui.pending_dialogs.len() == before {
            return false;
        }
        data.bump();
        sessions::sync_derived_session_state(&mut data, session_ref);
    }
    publish::emit(kernel);
    true
}

/// `addExtensionNotice`: keeps the newest notices and expires each one.
pub fn add_notice(kernel: &Kernel, session_ref: &SessionRef, notice: SessionExtensionNoticeRecord) {
    let notice_id = notice.id.clone();
    {
        let mut data = kernel.data.borrow_mut();
        let ui = ui_state(kernel, &mut data, session_ref);
        ui.notices.retain(|entry| entry.id != notice.id);
        ui.notices.push(notice);
        let overflow = ui.notices.len().saturating_sub(EXTENSION_NOTICE_LIMIT);
        let dropped: Vec<_> = ui.notices.drain(..overflow).collect();
        for entry in dropped {
            clear_dialog_timeout(&mut data, session_ref, &notice_timer_id(&entry.id));
        }
    }
    let timer_id = notice_timer_id(&notice_id);
    clear_dialog_timeout(&mut kernel.data.borrow_mut(), session_ref, &timer_id);
    let weak = kernel.this_weak();
    let owner = session_ref.clone();
    let key = timer_key(session_ref, &timer_id);
    let fired_key = key.clone();
    schedule(kernel, key, EXTENSION_NOTICE_TIMEOUT_MS as f64, move || {
        let Some(kernel) = weak.upgrade() else {
            return;
        };
        {
            let mut data = kernel.data.borrow_mut();
            data.extension_dialog_timers.remove(&fired_key);
            let Some(ui) = data
                .sessions
                .extension_ui_by_session
                .get_mut(&session_key(&owner))
            else {
                return;
            };
            let before = ui.notices.len();
            ui.notices.retain(|entry| entry.id != notice_id);
            if ui.notices.len() == before {
                return;
            }
            data.bump();
            sessions::sync_derived_session_state(&mut data, &owner);
        }
        publish::emit(&kernel);
    });
}

const MAX_LABEL_LENGTH: usize = 80;
const MAX_TEXT_LENGTH: usize = 10_000;
const MAX_COMMAND_LENGTH: usize = 1_000;
const MAX_URL_LENGTH: usize = 2_048;

fn bounded_text(value: Option<&Value>, max_length: usize) -> Option<String> {
    let trimmed = crate::js::trim(value?.as_str()?);
    (!trimmed.is_empty() && crate::js::length(trimmed) <= max_length).then(|| trimmed.to_owned())
}

/// `parseExtensionUrl`: an https URL without credentials, normalized.
pub fn parse_extension_url(value: &str) -> Option<String> {
    if crate::js::length(value) > MAX_URL_LENGTH {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none())
        .then(|| url.to_string())
}

/// `parseExtensionAction` (`packages/session-driver/src/extension-actions.ts`): `None` for
/// anything malformed or unknown.
pub fn parse_extension_action(value: Arg) -> Option<Value> {
    let record = value?.as_object()?;
    let label = bounded_text(record.get("label"), MAX_LABEL_LENGTH)?;
    let mut action = Map::new();
    let kind = record.get("type")?.as_str()?;
    action.insert("type".into(), json!(kind));
    action.insert("label".into(), json!(label));
    match kind {
        "openFile" => {
            let path = bounded_text(record.get("path"), MAX_URL_LENGTH)?;
            action.insert("path".into(), json!(path));
            if let Some(line) = record.get("line").and_then(Value::as_f64).filter(|line| {
                line.fract() == 0.0 && *line > 0.0 && *line <= 9_007_199_254_740_991.0
            }) {
                action.insert("line".into(), json!(line as u64));
            }
        }
        "composer" => {
            action.insert(
                "text".into(),
                json!(bounded_text(record.get("text"), MAX_TEXT_LENGTH)?),
            );
        }
        "url" => {
            let url = parse_extension_url(record.get("url")?.as_str()?)?;
            action.insert("url".into(), json!(url));
        }
        "command" => {
            let command = bounded_text(record.get("command"), MAX_COMMAND_LENGTH)?;
            let valid = command.starts_with('/')
                && command[1..]
                    .chars()
                    .next()
                    .is_some_and(|c| !c.is_whitespace())
                && !command.contains(['\r', '\n']);
            if !valid {
                return None;
            }
            action.insert("command".into(), json!(command));
        }
        "openThread" => {
            let session_id = record
                .get("sessionId")?
                .as_str()
                .filter(|id| actions::is_session_id(id))?;
            action.insert("sessionId".into(), json!(session_id));
        }
        _ => return None,
    }
    Some(Value::Object(action))
}

/// The host's `views.changed` and `views.message` notifications.
pub fn on_host_view_notification(kernel: &Kernel, method: &str, params: Value) {
    views::on_host_notification(kernel, method, params);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_are_parsed_like_the_session_driver() {
        assert_eq!(
            parse_extension_action(Some(
                &json!({ "type": "url", "label": " Go ", "url": "https://a.example/x y" })
            )),
            Some(json!({ "type": "url", "label": "Go", "url": "https://a.example/x%20y" }))
        );
        assert_eq!(
            parse_extension_action(Some(
                &json!({ "type": "url", "label": "Go", "url": "https://u:p@a.example" })
            )),
            None
        );
        assert_eq!(
            parse_extension_action(Some(
                &json!({ "type": "command", "label": "Run", "command": "/ci rerun" })
            )),
            Some(json!({ "type": "command", "label": "Run", "command": "/ci rerun" }))
        );
        assert_eq!(
            parse_extension_action(Some(
                &json!({ "type": "command", "label": "Run", "command": "/ x" })
            )),
            None
        );
        assert_eq!(
            parse_extension_action(Some(
                &json!({ "type": "openFile", "label": "Open", "path": "a.rs", "line": 0 })
            )),
            Some(json!({ "type": "openFile", "label": "Open", "path": "a.rs" }))
        );
        assert_eq!(
            parse_extension_action(Some(&json!({ "type": "nope", "label": "x" }))),
            None
        );
    }
}
