import { useTranslation } from "../../i18n";
import { SidebarToggleIcon } from "../../ui/icons";

interface SidebarToggleButtonProps {
  readonly collapsed: boolean;
  readonly shortcutLabel: string;
  readonly onToggle: () => void;
}

export function SidebarToggleButton({
  collapsed,
  shortcutLabel,
  onToggle,
}: SidebarToggleButtonProps) {
  const { t } = useTranslation();

  return (
    <div className="shortcut-tooltip-wrap sidebar-toggle">
      <button
        aria-label={t("settings.shortcuts.toggleSidebar")}
        aria-pressed={!collapsed}
        className="icon-button sidebar-toggle__button"
        data-testid="sidebar-toggle"
        type="button"
        onClick={onToggle}
      >
        <SidebarToggleIcon />
      </button>
      <span className="shortcut-tooltip sidebar-toggle__tooltip" role="tooltip">
        <span>{t("settings.shortcuts.toggleSidebar")}</span>
        <kbd>{shortcutLabel}</kbd>
      </span>
    </div>
  );
}
