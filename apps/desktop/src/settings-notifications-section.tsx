import type { NotificationPreferences } from "./desktop-state";
import { StatusIcon } from "./icons";
import { SettingsCard } from "./settings-utils";

interface SettingsNotificationsSectionProps {
  readonly notificationPreferences: NotificationPreferences;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
}

export function SettingsNotificationsSection({
  notificationPreferences,
  onSetNotificationPreferences,
}: SettingsNotificationsSectionProps) {
  return (
    <SettingsCard
      description="Control which background events trigger desktop notifications."
      icon={<StatusIcon />}
      title="Notifications"
    >
      <div className="settings-toggle-list">
        <label className="settings-toggle">
          <input
            checked={notificationPreferences.backgroundCompletion}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ backgroundCompletion: event.target.checked })}
          />
          <span>Background completion</span>
        </label>
        <label className="settings-toggle">
          <input
            checked={notificationPreferences.backgroundFailure}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ backgroundFailure: event.target.checked })}
          />
          <span>Background failures</span>
        </label>
        <label className="settings-toggle">
          <input
            checked={notificationPreferences.attentionNeeded}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ attentionNeeded: event.target.checked })}
          />
          <span>Needs input or approval</span>
        </label>
      </div>
    </SettingsCard>
  );
}
