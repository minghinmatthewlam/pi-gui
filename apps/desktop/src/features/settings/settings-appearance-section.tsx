import type { ThemeMode, ThemePresetId } from "../../../contracts/desktop-state";
import { SettingsSelect, SettingsSwitch, type SettingsSegmentedOption } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import type { CSSProperties } from "react";
import { themePreset, themePresets, themeSwatches, themeTokensFor } from "../../../contracts/theme";
import { LOCALES, useI18n, type LocalePreference, type MessageKey } from "../../i18n";
import { useActiveTheme } from "../../ui/active-theme";

interface SettingsAppearanceSectionProps {
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  readonly onSetThemeMode: (mode: ThemeMode) => void;
  readonly onSetThemePresetId: (presetId: ThemePresetId) => void;
  readonly enableTransparency: boolean;
  readonly onSetEnableTransparency: (enabled: boolean) => void;
}

/** Preset copy lives in the message catalogs, so the picker reads in the chosen language. */
const PRESET_DESCRIPTION_KEYS: Readonly<Record<ThemePresetId, MessageKey>> = {
  default: "settings.appearance.preset.default",
  catppuccin: "settings.appearance.preset.catppuccin",
  "tokyo-night": "settings.appearance.preset.tokyo-night",
  nord: "settings.appearance.preset.nord",
  dracula: "settings.appearance.preset.dracula",
  gruvbox: "settings.appearance.preset.gruvbox",
  github: "settings.appearance.preset.github",
  vscode: "settings.appearance.preset.vscode",
};

export function SettingsAppearanceSection({
  themeMode,
  themePresetId,
  onSetThemeMode,
  onSetThemePresetId,
  enableTransparency,
  onSetEnableTransparency,
}: SettingsAppearanceSectionProps) {
  const { t, preference, setPreference } = useI18n();
  const { variant } = useActiveTheme();
  const themeModes: readonly { readonly mode: ThemeMode; readonly label: MessageKey }[] = [
    { mode: "system", label: "settings.appearance.mode.system" },
    { mode: "light", label: "settings.appearance.mode.light" },
    { mode: "dark", label: "settings.appearance.mode.dark" },
  ];
  // Registered locales label themselves, so a new language needs no copy or edits here.
  const languageOptions: readonly SettingsSegmentedOption<LocalePreference>[] = [
    { value: "system", label: t("settings.appearance.language.system") },
    ...LOCALES.map((locale) => ({ value: locale.id, label: locale.label })),
  ];
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          title={t("settings.appearance.language.title")}
          description={t("settings.appearance.language.description")}
        >
          <SettingsSelect
            label={t("settings.appearance.language.label")}
            options={languageOptions}
            value={preference}
            onChange={setPreference}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.groupTheme")} plain>
        <div
          aria-label={t("settings.appearance.themeLabel")}
          className="theme-mode-tiles"
          role="radiogroup"
          style={tilePalette(themePresetId)}
        >
          {themeModes.map((option) => (
            <label className="theme-mode-tile" key={option.mode}>
              <input
                checked={themeMode === option.mode}
                name="theme-mode"
                type="radio"
                onChange={() => onSetThemeMode(option.mode)}
              />
              <span
                aria-hidden="true"
                className={`theme-mode-tile__preview theme-mode-tile__preview--${option.mode}`}
              >
                <span className="theme-mode-tile__window">
                  <span className="theme-mode-tile__line theme-mode-tile__line--title" />
                  <span className="theme-mode-tile__line" />
                  <span className="theme-mode-tile__line" />
                </span>
              </span>
              <span className="theme-mode-tile__label">{t(option.label)}</span>
            </label>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          title={t("settings.appearance.colorPreset.title")}
          description={t(PRESET_DESCRIPTION_KEYS[themePreset(themePresetId).id])}
        >
          <span className="settings-preset-control">
            <span aria-hidden="true" className="settings-preset-swatches">
              {themeSwatches(themePresetId, variant).map((swatch, index) => (
                <span key={index} style={{ background: swatch }} />
              ))}
            </span>
            <SettingsSelect
              label={t("settings.appearance.colorPreset.label")}
              options={themePresets.map((preset) => ({ value: preset.id, label: preset.name }))}
              value={themePresetId}
              onChange={onSetThemePresetId}
            />
          </span>
        </SettingsRow>
        <SettingsRow
          title={t("settings.appearance.transparency.title")}
          description={t("settings.appearance.transparency.description")}
        >
          <SettingsSwitch
            checked={enableTransparency}
            label={t("settings.appearance.transparency.label")}
            onChange={onSetEnableTransparency}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function tilePalette(presetId: ThemePresetId): CSSProperties {
  const light = themeTokensFor(presetId, "light");
  const dark = themeTokensFor(presetId, "dark");
  return {
    "--tile-light-bg": light["--sidebar"],
    "--tile-light-window": light["--main"],
    "--tile-light-line": light["--line-strong"],
    "--tile-dark-bg": dark["--sidebar"],
    "--tile-dark-window": dark["--main"],
    "--tile-dark-line": dark["--line-strong"],
  } as CSSProperties;
}
