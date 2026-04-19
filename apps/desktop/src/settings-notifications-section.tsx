import type { DesktopNotificationPermissionStatus } from "./ipc";
import type { NotificationPreferences } from "./desktop-state";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsNotificationsSectionProps {
  readonly notificationPreferences: NotificationPreferences;
  readonly notificationPermissionStatus: DesktopNotificationPermissionStatus;
  readonly notificationPermissionPending: boolean;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
  readonly onRequestNotificationPermission: () => void;
  readonly onOpenSystemNotificationSettings: () => void;
}

export function SettingsNotificationsSection({
  notificationPreferences,
  notificationPermissionStatus,
  notificationPermissionPending,
  onSetNotificationPreferences,
  onRequestNotificationPermission,
  onOpenSystemNotificationSettings,
}: SettingsNotificationsSectionProps) {
  const statusLabel = labelForPermissionStatus(notificationPermissionStatus);
  const statusDescription = descriptionForPermissionStatus(notificationPermissionStatus);
  const showRecoveryActions = notificationPermissionStatus !== "granted";

  return (
    <>
      <SettingsGroup title="System" description="macOS decides whether pi-gui can show desktop notifications at all.">
        <SettingsRow title="macOS notification access" description={statusDescription}>
          <span className="settings-row__value">{statusLabel}</span>
        </SettingsRow>
        {showRecoveryActions ? (
          <SettingsRow
            title="Turn on notifications"
            description="pi-gui asks macOS when active work first moves into the background. You can also ask now, or open System Settings if notifications were already denied."
          >
            <div className="settings-row__actions">
              <button
                className="button button--secondary"
                disabled={notificationPermissionPending}
                type="button"
                onClick={onRequestNotificationPermission}
              >
                Ask macOS
              </button>
              <button
                className="button button--secondary"
                disabled={notificationPermissionPending}
                type="button"
                onClick={onOpenSystemNotificationSettings}
              >
                Open System Settings
              </button>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="In-app alerts" description="Choose which background events should try to notify once macOS access is enabled.">
        <SettingsRow title="Background completion" description="Notify when a background session finishes.">
          <input
            aria-label="Background completion"
            checked={notificationPreferences.backgroundCompletion}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ backgroundCompletion: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow title="Background failures" description="Notify when a background session fails.">
          <input
            aria-label="Background failures"
            checked={notificationPreferences.backgroundFailure}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ backgroundFailure: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow title="Needs input or approval" description="Notify when input is needed to continue.">
          <input
            aria-label="Needs input or approval"
            checked={notificationPreferences.attentionNeeded}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ attentionNeeded: event.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function labelForPermissionStatus(status: DesktopNotificationPermissionStatus): string {
  switch (status) {
    case "granted":
      return "Enabled";
    case "denied":
      return "Turned off";
    case "default":
      return "Not enabled yet";
    case "unsupported":
      return "Unavailable";
    default:
      return "Checking…";
  }
}

function descriptionForPermissionStatus(status: DesktopNotificationPermissionStatus): string {
  switch (status) {
    case "granted":
      return "macOS will allow pi-gui to show desktop notifications for background thread updates.";
    case "denied":
      return "macOS notifications are turned off for pi-gui. Enable them in System Settings to receive background completion alerts.";
    case "default":
      return "pi-gui has not asked macOS for desktop notification access yet.";
    case "unsupported":
      return "Desktop notifications are unavailable on this system.";
    default:
      return "Checking whether macOS notifications are available for pi-gui.";
  }
}
