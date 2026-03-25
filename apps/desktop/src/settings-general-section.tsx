import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRecord } from "./desktop-state";
import { SettingsIcon, SkillIcon } from "./icons";
import { SettingsCard, SettingsInfoRow, labelForThinking } from "./settings-utils";

interface SettingsGeneralSectionProps {
  readonly workspace?: WorkspaceRecord;
  readonly runtime?: RuntimeSnapshot;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
}

export function SettingsGeneralSection({ workspace, runtime, onToggleSkillCommands }: SettingsGeneralSectionProps) {
  const connectedCount = runtime?.providers.filter((p) => p.hasAuth).length ?? 0;

  return (
    <>
      <SettingsCard
        description="Current workspace defaults and runtime snapshot."
        icon={<SettingsIcon />}
        title="General"
      >
        <div className="settings-list">
          <SettingsInfoRow label="Workspace" value={workspace?.name ?? "No workspace selected"} />
          <SettingsInfoRow
            label="Default model"
            value={
              runtime?.settings.defaultProvider && runtime?.settings.defaultModelId
                ? `${runtime.settings.defaultProvider}:${runtime.settings.defaultModelId}`
                : "Not set"
            }
          />
          <SettingsInfoRow
            label="Reasoning"
            value={labelForThinking(runtime?.settings.defaultThinkingLevel ?? "medium")}
          />
          <SettingsInfoRow
            label="Connected providers"
            value={connectedCount > 0 ? String(connectedCount) : "None"}
          />
          <SettingsInfoRow label="Discovered skills" value={String(runtime?.skills.length ?? 0)} />
        </div>
      </SettingsCard>

      <SettingsCard
        description="Keep the highest-value controls discoverable without sending people through runtime-specific menus."
        icon={<SettingsIcon />}
        title="Shortcuts"
      >
        <div className="settings-list">
          <SettingsInfoRow label="Open settings" value="Cmd+," />
          <SettingsInfoRow label="Send message" value="Enter" />
          <SettingsInfoRow label="New line" value="Shift+Enter" />
        </div>
      </SettingsCard>

      <SettingsCard
        description="Keep skill slash commands available in the composer while the full Skills surface stays separate."
        icon={<SkillIcon />}
        title="Skill commands"
      >
        <label className="settings-toggle">
          <input
            checked={runtime?.settings.enableSkillCommands ?? true}
            type="checkbox"
            onChange={(event) => onToggleSkillCommands(event.target.checked)}
          />
          <span>Enable skill slash commands</span>
        </label>
      </SettingsCard>
    </>
  );
}
