import type { ThemeMode, ThemePresetId } from "../../../contracts/desktop-state";
import { SettingsSelect, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { themePresets } from "./theme-presets";

interface SettingsAppearanceSectionProps {
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  readonly onSetThemeMode: (mode: ThemeMode) => void;
  readonly onSetThemePresetId: (presetId: ThemePresetId) => void;
  readonly enableTransparency: boolean;
  readonly onSetEnableTransparency: (enabled: boolean) => void;
}

const THEME_MODES: readonly { readonly mode: ThemeMode; readonly label: string }[] = [
  { mode: "system", label: "System" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

export function SettingsAppearanceSection({
  themeMode,
  themePresetId,
  onSetThemeMode,
  onSetThemePresetId,
  enableTransparency,
  onSetEnableTransparency,
}: SettingsAppearanceSectionProps) {
  const activePreset = themePresets.find((preset) => preset.id === themePresetId);
  return (
    <>
      <SettingsGroup title="Theme" plain>
        <div aria-label="Theme" className="theme-mode-tiles" role="radiogroup">
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
              <span className="theme-mode-tile__label">{option.label}</span>
            </label>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow title="Color preset" description={activePreset?.description}>
          <span className="settings-preset-control">
            {activePreset ? (
              <span aria-hidden="true" className="settings-preset-swatches">
                {activePreset.swatches.map((swatch) => (
                  <span key={swatch} style={{ background: swatch }} />
                ))}
              </span>
            ) : null}
            <SettingsSelect
              label="Color preset"
              options={themePresets.map((preset) => ({ value: preset.id, label: preset.name }))}
              value={themePresetId}
              onChange={onSetThemePresetId}
            />
          </span>
        </SettingsRow>
        <SettingsRow
          title="Window transparency"
          description="Let desktop colors show through supported surfaces."
        >
          <SettingsSwitch
            checked={enableTransparency}
            label="Window transparency"
            onChange={onSetEnableTransparency}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
