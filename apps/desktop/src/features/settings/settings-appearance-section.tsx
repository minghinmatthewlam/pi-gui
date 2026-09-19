import type { ThemeMode, ThemePresetId } from "../../../contracts/desktop-state";
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

const THEME_OPTIONS: { mode: ThemeMode; label: string; description: string }[] = [
  { mode: "system", label: "System", description: "Follow your OS appearance setting" },
  { mode: "light", label: "Light", description: "Always use the light theme" },
  { mode: "dark", label: "Dark", description: "Always use the dark theme" },
];

export function SettingsAppearanceSection({
  themeMode,
  themePresetId,
  onSetThemeMode,
  onSetThemePresetId,
  enableTransparency,
  onSetEnableTransparency,
}: SettingsAppearanceSectionProps) {
  return (
    <>
      <SettingsGroup title="Theme preset">
        <div className="theme-preset-grid">
          {themePresets.map((preset) => (
            <label
              className={`theme-preset-card${themePresetId === preset.id ? " theme-preset-card--active" : ""}`}
              key={preset.id}
            >
              <input
                checked={themePresetId === preset.id}
                name="theme-preset"
                type="radio"
                onChange={() => onSetThemePresetId(preset.id)}
              />
              <span className="theme-preset-card__preview" aria-hidden="true">
                {preset.swatches.map((swatch) => (
                  <span
                    className="theme-preset-card__swatch"
                    key={swatch}
                    style={{ background: swatch }}
                  />
                ))}
              </span>
              <span className="theme-preset-card__body">
                <span className="theme-preset-card__title">{preset.name}</span>
                <span className="theme-preset-card__description">{preset.description}</span>
              </span>
            </label>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Theme">
        {THEME_OPTIONS.map((option) => (
          <SettingsRow key={option.mode} title={option.label} description={option.description}>
            <input
              checked={themeMode === option.mode}
              name="theme"
              type="radio"
              onChange={() => onSetThemeMode(option.mode)}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title="Visuals">
        <SettingsRow
          title="Window transparency"
          description="Let desktop colors show through supported surfaces."
        >
          <input
            aria-label="Window transparency"
            type="checkbox"
            checked={enableTransparency}
            onChange={(event) => onSetEnableTransparency(event.currentTarget.checked)}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
