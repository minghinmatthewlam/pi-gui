import type { ThemeMode, ThemePresetId } from "../../../contracts/desktop-state";
import { SettingsSelect, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import type { CSSProperties } from "react";
import { themePreset, themePresets, themeSwatches, themeTokensFor } from "../../../contracts/theme";
import { useActiveTheme } from "../../ui/active-theme";
import { t, useLocale } from "../../lib/i18n";

interface SettingsAppearanceSectionProps {
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  readonly onSetThemeMode: (mode: ThemeMode) => void;
  readonly onSetThemePresetId: (presetId: ThemePresetId) => void;
  readonly enableTransparency: boolean;
  readonly onSetEnableTransparency: (enabled: boolean) => void;
}

/**
 * Theme mode tiles are hard-coded by id because the renderer needs to swap
 * data-theme for each option; only the labels are translated.
 */
const THEME_MODES: readonly { readonly mode: ThemeMode; readonly labelKey: string }[] = [
  { mode: "system", labelKey: "settings.appearance.theme.system" },
  { mode: "light", labelKey: "settings.appearance.theme.light" },
  { mode: "dark", labelKey: "settings.appearance.theme.dark" },
];

export function SettingsAppearanceSection({
  themeMode,
  themePresetId,
  onSetThemeMode,
  onSetThemePresetId,
  enableTransparency,
  onSetEnableTransparency,
}: SettingsAppearanceSectionProps) {
  // Subscribing makes the section re-render when the user picks a new locale.
  useLocale();
  const activePreset = themePreset(themePresetId);
  const { variant } = useActiveTheme();
  return (
    <>
      <SettingsGroup title={t("settings.appearance.theme.title")} plain>
        <div
          aria-label={t("settings.appearance.theme.aria")}
          className="theme-mode-tiles"
          role="radiogroup"
          style={tilePalette(themePresetId)}
        >
          {THEME_MODES.map((option) => (
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
              <span className="theme-mode-tile__label">{t(option.labelKey)}</span>
            </label>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          title={t("settings.appearance.color_preset.title")}
          description={activePreset.description}
        >
          <span className="settings-preset-control">
            <span aria-hidden="true" className="settings-preset-swatches">
              {themeSwatches(themePresetId, variant).map((swatch, index) => (
                <span key={index} style={{ background: swatch }} />
              ))}
            </span>
            <SettingsSelect
              label={t("settings.appearance.color_preset.aria")}
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
            label={t("settings.appearance.transparency.title")}
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
