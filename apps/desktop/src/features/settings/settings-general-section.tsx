import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { ModelSettingsScopeMode } from "../../../contracts/desktop-state";
import { SettingsSegmented, SettingsSelect, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { listLocales, setLocale, useLocale, type LocaleId, t } from "../../lib/i18n";

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
}

export function SettingsGeneralSection({
  runtime,
  modelSettingsScopeMode,
  integratedTerminalShell,
  onSetModelSettingsScopeMode,
  onSetIntegratedTerminalShell,
  onToggleSkillCommands,
}: SettingsGeneralSectionProps) {
  // Subscribing makes the section re-render when the user picks a new locale.
  useLocale();
  const [terminalShellDraft, setTerminalShellDraft] = useState(integratedTerminalShell);
  const locales = listLocales();
  const currentLocale = useLocale();

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
      <SettingsGroup title={t("settings.language")} plain>
        <SettingsRow
          title={t("settings.language")}
          description={t("settings.language.description")}
        >
          <SettingsSelect
            label={t("settings.language")}
            options={locales.map((locale) => ({
              value: locale.id,
              label: locale.nativeName,
            }))}
            value={currentLocale}
            onChange={(value) => setLocale(value as LocaleId)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.agent.title")}>
        <SettingsRow
          title={t("settings.general.model_scope.title")}
          description={t("settings.general.model_scope.description")}
        >
          <SettingsSegmented
            label={t("settings.general.model_scope.aria")}
            options={[
              { value: "app-global", label: t("settings.general.model_scope.app_global") },
              { value: "per-repo", label: t("settings.general.model_scope.per_repo") },
            ]}
            value={modelSettingsScopeMode}
            onChange={onSetModelSettingsScopeMode}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.general.skill_commands.title")}
          description={t("settings.general.skill_commands.description")}
        >
          <SettingsSwitch
            checked={runtime?.settings.enableSkillCommands ?? true}
            label={t("settings.general.skill_commands.aria")}
            onChange={onToggleSkillCommands}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.terminal.title")}>
        <SettingsRow
          title={t("settings.general.terminal.shell.title")}
          description={t("settings.general.terminal.shell.description")}
        >
          <input
            aria-label={t("settings.general.terminal.shell.aria")}
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
