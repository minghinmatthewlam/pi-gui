//! Extension UI (the extension half of `app-store.ts`, `extensions/extension-notices.ts` and
//! `extension-actions.ts`): host UI requests, dialog timeouts and notices. Extension views,
//! actions and the enable/disable settings still answer "not ported".

use super::dispatch::MethodTable;
use super::validation::Arg;
use super::{publish, sessions, AppData, Kernel};
use crate::state::desktop_state::ComposerDraftSyncSource;
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
pub struct ExtensionsState {}

pub fn register(_table: &mut MethodTable) {}

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

fn is_session_id(value: &str) -> bool {
    (1..=200).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
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
                .filter(|id| is_session_id(id))?;
            action.insert("sessionId".into(), json!(session_id));
        }
        _ => return None,
    }
    Some(Value::Object(action))
}

/// The host's `views.changed` and `views.message` notifications. Extension views are not
/// ported yet, so these are logged and dropped.
pub fn on_host_view_notification(_kernel: &Kernel, method: &str, _params: Value) {
    eprintln!("[pi-host] extension views are not ported; dropped {method}");
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
