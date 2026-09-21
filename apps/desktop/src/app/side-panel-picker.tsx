import { useEffect, useId, useRef, useState } from "react";
import { getDesktopShortcutLabel, getSidePanelToggleShortcutLabel } from "../../contracts/ipc";
import { DiffIcon, FileIcon, SidePanelIcon, TerminalIcon } from "../ui/icons";

export type SidePanelPickerChoice = "files" | "changes" | "terminal";

interface SidePanelPickerProps {
  readonly platform: NodeJS.Platform;
  readonly filesEnabled: boolean;
  readonly changesEnabled: boolean;
  readonly terminalEnabled: boolean;
  readonly filesVisible: boolean;
  readonly changesVisible: boolean;
  readonly terminalVisible: boolean;
  readonly onSelect: (choice: SidePanelPickerChoice) => void;
}

const MENU_ITEMS: readonly {
  readonly choice: SidePanelPickerChoice;
  readonly label: string;
}[] = [
  { choice: "files", label: "Files" },
  { choice: "changes", label: "Changes" },
  { choice: "terminal", label: "Terminal" },
];

export function SidePanelPicker(props: SidePanelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const enabled = props.filesEnabled || props.changesEnabled || props.terminalEnabled;
  const sidePanelVisible = props.filesVisible || props.changesVisible;

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const closeIfOutside = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", closeIfOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeIfOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      className={`side-panel-picker shortcut-tooltip-wrap topbar__tooltip-wrap${open ? " side-panel-picker--open" : ""}`}
      ref={rootRef}
    >
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open side panel"
        className={`icon-button topbar__icon${open || sidePanelVisible ? " icon-button--active" : ""}`}
        data-testid="side-panel-picker"
        disabled={!enabled}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <SidePanelIcon />
      </button>
      <span className="shortcut-tooltip topbar__tooltip" role="tooltip">
        <span>Open side panel</span>
        <kbd>{getSidePanelToggleShortcutLabel(props.platform)}</kbd>
      </span>
      {open ? (
        <div
          className="side-panel-picker__menu"
          data-testid="side-panel-picker-menu"
          id={menuId}
          role="menu"
        >
          {MENU_ITEMS.map((item) => {
            const itemEnabled =
              item.choice === "files"
                ? props.filesEnabled
                : item.choice === "changes"
                  ? props.changesEnabled
                  : props.terminalEnabled;
            const visible =
              item.choice === "files"
                ? props.filesVisible
                : item.choice === "changes"
                  ? props.changesVisible
                  : props.terminalVisible;
            const shortcut =
              item.choice === "changes"
                ? getDesktopShortcutLabel(props.platform, "D")
                : item.choice === "terminal"
                  ? getDesktopShortcutLabel(props.platform, "J")
                  : null;
            const Icon =
              item.choice === "files"
                ? FileIcon
                : item.choice === "changes"
                  ? DiffIcon
                  : TerminalIcon;
            return (
              <button
                aria-current={visible ? "true" : undefined}
                className={`side-panel-picker__item${visible ? " side-panel-picker__item--active" : ""}`}
                disabled={!itemEnabled}
                key={item.choice}
                role="menuitem"
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onSelect(item.choice);
                }}
              >
                <Icon />
                <span>{item.label}</span>
                {shortcut ? <kbd>{shortcut}</kbd> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
