//! Desktop notifications (`platform/notification-manager.ts` and
//! `notification-permission.ts`). So far: the permission calls, answered by the shell.
//! Background completion and attention notifications are not ported.

use super::dispatch::{self, MethodTable, Reply};
use super::Kernel;
use crate::error::CoreResult;
use crate::state::desktop_state::DesktopAppState;
use crate::state::driver::SessionDriverEvent;

/// What the notification part keeps.
#[derive(Default)]
pub struct NotificationsState {}

pub fn register(table: &mut MethodTable) {
    table.on("getNotificationPermissionStatus", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(Reply::Value(
                kernel.shell().notification_permission("status").await?,
            ))
        })
    });
    table.on("requestNotificationPermission", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            Ok(Reply::Value(
                kernel.shell().notification_permission("request").await?,
            ))
        })
    });
    table.on("openSystemNotificationSettings", |kernel, call| {
        Box::pin(async move {
            dispatch::sender(&kernel, &call)?;
            kernel
                .shell()
                .notification_permission("openSettings")
                .await?;
            Ok(Reply::Undefined)
        })
    });
}

/// The notification manager's session-event listener. Not ported.
pub async fn on_session_event(
    _kernel: &Kernel,
    _event: &SessionDriverEvent,
    _snapshot: &DesktopAppState,
) -> CoreResult<()> {
    Ok(())
}
