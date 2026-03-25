import type { RuntimeSettingsSnapshot, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { NotificationPreferences, WorkspaceRecord } from "./desktop-state";
import { RefreshIcon } from "./icons";
import { SettingsGeneralSection } from "./settings-general-section";
import { SettingsModelsSection } from "./settings-models-section";
import { SettingsNotificationsSection } from "./settings-notifications-section";
import { SettingsProvidersSection } from "./settings-providers-section";
import { type SettingsSection, sectionTitle, sectionDescription } from "./settings-utils";

export type { SettingsSection } from "./settings-utils";

interface SettingsViewProps {
  readonly workspace?: WorkspaceRecord;
  readonly runtime?: RuntimeSnapshot;
  readonly section: SettingsSection;
  readonly notificationPreferences: NotificationPreferences;
  readonly onRefresh: () => void;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
  readonly onSetThinkingLevel: (thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
  readonly onSetScopedModelPatterns: (patterns: readonly string[]) => void;
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
}

export function SettingsView({
  workspace,
  runtime,
  section,
  notificationPreferences,
  onRefresh,
  onSetDefaultModel,
  onSetThinkingLevel,
  onToggleSkillCommands,
  onSetScopedModelPatterns,
  onLoginProvider,
  onLogoutProvider,
  onSetNotificationPreferences,
}: SettingsViewProps) {
  if (!workspace && section !== "general" && section !== "notifications") {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">Settings</div>
          <h1>Select a workspace</h1>
          <p>Model, auth, and skill settings are scoped to the selected workspace.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas">
      <div className="conversation settings-view">
        <header className="view-header">
          <div>
            <div className="chat-header__eyebrow">Settings</div>
            <h1 className="view-header__title">{sectionTitle(section)}</h1>
            <p className="view-header__body">
              {sectionDescription(section, workspace?.name ?? "this workspace")}
            </p>
          </div>
          <button className="button button--secondary" type="button" onClick={onRefresh}>
            <RefreshIcon />
            <span>Refresh</span>
          </button>
        </header>

        <div className="settings-grid">
          {section === "general" ? (
            <SettingsGeneralSection
              runtime={runtime}
              workspace={workspace}
              onToggleSkillCommands={onToggleSkillCommands}
            />
          ) : null}

          {section === "providers" ? (
            <SettingsProvidersSection
              runtime={runtime}
              onLoginProvider={onLoginProvider}
              onLogoutProvider={onLogoutProvider}
            />
          ) : null}

          {section === "models" ? (
            <SettingsModelsSection
              runtime={runtime}
              onSetDefaultModel={onSetDefaultModel}
              onSetScopedModelPatterns={onSetScopedModelPatterns}
              onSetThinkingLevel={onSetThinkingLevel}
            />
          ) : null}

          {section === "notifications" ? (
            <SettingsNotificationsSection
              notificationPreferences={notificationPreferences}
              onSetNotificationPreferences={onSetNotificationPreferences}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
