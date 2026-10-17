import type { DesktopNotificationPermissionStatus } from "../../../contracts/ipc";
import type { NotificationPreferences } from "../../../contracts/desktop-state";
import { SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { t, useLocale } from "../../lib/i18n";

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
  // Subscribing makes the section re-render when the user picks a new locale.
  useLocale();
  const statusLabel = labelForPermissionStatus(notificationPermissionStatus);
  const statusDescription = descriptionForPermissionStatus(notificationPermissionStatus);
  const showAskMacOs = notificationPermissionStatus === "default";
  const showOpenSystemSettings = notificationPermissionStatus === "denied";
  const showRecoveryActions = showAskMacOs || showOpenSystemSettings;

  return (
    <>
      <SettingsGroup
        title={t("settings.notifications.system.title")}
        description={t("settings.notifications.system.description")}
      >
        <SettingsRow
          title={t("settings.notifications.macos_access.title")}
          description={statusDescription}
        >
          <span className="settings-row__value">{statusLabel}</span>
        </SettingsRow>
        {showRecoveryActions ? (
          <SettingsRow
            title={t("settings.notifications.turn_on.title")}
            description={
              showAskMacOs
                ? t("settings.notifications.turn_on.ask_description")
                : t("settings.notifications.turn_on.denied_description")
            }
          >
            <div className="settings-row__actions">
              {showAskMacOs ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onRequestNotificationPermission}
                >
                  {t("settings.notifications.ask_macos")}
                </button>
              ) : null}
              {showOpenSystemSettings ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onOpenSystemNotificationSettings}
                >
                  {t("settings.notifications.open_system_settings")}
                </button>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.notifications.in_app_alerts.title")}
        description={t("settings.notifications.in_app_alerts.description")}
      >
        <SettingsRow
          title={t("settings.notifications.background_completion.title")}
          description={t("settings.notifications.background_completion.description")}
        >
          <SettingsSwitch
            checked={notificationPreferences.backgroundCompletion}
            label={t("settings.notifications.background_completion.title")}
            onChange={(checked) => onSetNotificationPreferences({ backgroundCompletion: checked })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.notifications.background_failures.title")}
          description={t("settings.notifications.background_failures.description")}
        >
          <SettingsSwitch
            checked={notificationPreferences.backgroundFailure}
            label={t("settings.notifications.background_failures.title")}
            onChange={(checked) => onSetNotificationPreferences({ backgroundFailure: checked })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.notifications.attention_needed.title")}
          description={t("settings.notifications.attention_needed.description")}
        >
          <SettingsSwitch
            checked={notificationPreferences.attentionNeeded}
            label={t("settings.notifications.attention_needed.title")}
            onChange={(checked) => onSetNotificationPreferences({ attentionNeeded: checked })}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function labelForPermissionStatus(status: DesktopNotificationPermissionStatus): string {
  switch (status) {
    case "granted":
      return t("settings.notifications.permission.granted");
    case "denied":
      return t("settings.notifications.permission.denied");
    case "default":
      return t("settings.notifications.permission.default");
    case "unsupported":
      return t("settings.notifications.permission.unsupported");
    default:
      return t("settings.notifications.permission.unknown");
  }
}

function descriptionForPermissionStatus(status: DesktopNotificationPermissionStatus): string {
  switch (status) {
    case "granted":
      return t("settings.notifications.permission.description.granted");
    case "denied":
      return t("settings.notifications.permission.description.denied");
    case "default":
      return t("settings.notifications.permission.description.default");
    case "unsupported":
      return t("settings.notifications.permission.description.unsupported");
    default:
      return t("settings.notifications.permission.description.unknown");
  }
}
