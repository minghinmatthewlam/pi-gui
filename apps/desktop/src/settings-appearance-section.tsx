import type { ThemeMode } from "./desktop-state";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsAppearanceSectionProps {
  readonly themeMode: ThemeMode;
  readonly onSetThemeMode: (mode: ThemeMode) => void;
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
  onSetThemeMode,
  enableTransparency,
  onSetEnableTransparency,
}: SettingsAppearanceSectionProps) {
  return (
    <>
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
