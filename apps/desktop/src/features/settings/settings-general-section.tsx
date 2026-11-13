import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { ModelSettingsScopeMode } from "../../../contracts/desktop-state";
import { useTranslation } from "../../i18n";
import { SettingsSegmented, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly showModelThinking: boolean;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onSetShowModelThinking: (enabled: boolean) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
}

export function SettingsGeneralSection({
  runtime,
  modelSettingsScopeMode,
  integratedTerminalShell,
  showModelThinking,
  onSetModelSettingsScopeMode,
  onSetIntegratedTerminalShell,
  onSetShowModelThinking,
  onToggleSkillCommands,
}: SettingsGeneralSectionProps) {
  const { t } = useTranslation();
  const [terminalShellDraft, setTerminalShellDraft] = useState(integratedTerminalShell);

  useEffect(() => {
    setTerminalShellDraft(integratedTerminalShell);
  }, [integratedTerminalShell]);

  const commitTerminalShellDraft = () => {
    if (terminalShellDraft !== integratedTerminalShell) {
      onSetIntegratedTerminalShell(terminalShellDraft);
    }
  };

  return (
    <>
      <SettingsGroup title={t("settings.general.groupAgent")}>
        <SettingsRow
          title={t("settings.general.modelScope.title")}
          description={t("settings.general.modelScope.description")}
        >
          <SettingsSegmented
            label={t("settings.general.modelScope.label")}
            options={[
              { value: "app-global", label: t("settings.general.modelScope.appGlobal") },
              { value: "per-repo", label: t("settings.general.modelScope.perRepo") },
            ]}
            value={modelSettingsScopeMode}
            onChange={onSetModelSettingsScopeMode}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.general.skillCommands.title")}
          description={t("settings.general.skillCommands.description")}
        >
          <SettingsSwitch
            checked={runtime?.settings.enableSkillCommands ?? true}
            label={t("settings.general.skillCommands.label")}
            onChange={onToggleSkillCommands}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.general.modelThinking.title")}
          description={t("settings.general.modelThinking.description")}
        >
          <SettingsSwitch
            checked={showModelThinking}
            label={t("settings.general.modelThinking.label")}
            onChange={onSetShowModelThinking}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.groupTerminal")}>
        <SettingsRow
          title={t("settings.general.shell.title")}
          description={t("settings.general.shell.description")}
        >
          <input
            aria-label={t("settings.general.shell.label")}
            className="settings-text-input"
            placeholder="/bin/zsh"
            spellCheck={false}
            type="text"
            value={terminalShellDraft}
            onBlur={commitTerminalShellDraft}
            onChange={(event) => setTerminalShellDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
