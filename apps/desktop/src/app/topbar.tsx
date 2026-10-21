import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { AppView, WorkspaceRecord, WorktreeRecord } from "../../contracts/desktop-state";
import { getSidePanelToggleShortcutLabel, type PiDesktopApi } from "../../contracts/ipc";
import { SidePanelIcon } from "../ui/icons";
import { t, useLocale } from "../lib/i18n";

interface TopbarProps {
  readonly activeView: AppView;
  readonly sessionTitle?: string;
  readonly children?: ReactNode;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedWorktree: WorktreeRecord | undefined;
  readonly api: PiDesktopApi;
  readonly panelAvailable: boolean;
  readonly panelVisible: boolean;
  readonly onTogglePanel: () => void;
}

export function Topbar({
  activeView,
  sessionTitle,
  children,
  rootWorkspace,
  selectedWorkspace,
  selectedWorktree,
  api,
  panelAvailable,
  panelVisible,
  onTogglePanel,
}: TopbarProps) {
  // Subscribing makes the topbar re-render when the user picks a new locale.
  useLocale();
  const handleDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest(".topbar__actions")) return;
    void api.toggleWindowMaximize().catch((error: unknown) => {
      console.error("[renderer] toggleWindowMaximize failed", error);
    });
  };
  const checkoutLabel =
    selectedWorkspace?.kind === "worktree"
      ? (selectedWorktree?.name ?? selectedWorkspace.branchName ?? selectedWorkspace.name)
      : selectedWorkspace?.branchName;

  return (
    <header className="topbar" data-testid="topbar" onDoubleClick={handleDoubleClick}>
      <div className="topbar__title">
        <span
          className="topbar__workspace"
          title={checkoutLabel ? `${rootWorkspace?.name ?? ""} · ${checkoutLabel}` : undefined}
        >
          {rootWorkspace ? rootWorkspace.name : t("topbar.open_folder_to_begin")}
        </span>
        {sessionTitle ? (
          <>
            <span className="topbar__separator">/</span>
            <h1 className="chat-header__title" title={sessionTitle}>
              {sessionTitle}
            </h1>
          </>
        ) : activeView === "threads" && checkoutLabel ? (
          <>
            <span className="topbar__separator">/</span>
            <span className="topbar__session">{checkoutLabel}</span>
          </>
        ) : activeView === "new-thread" && rootWorkspace ? (
          <>
            <span className="topbar__separator">/</span>
            <span className="topbar__session">{t("topbar.new_thread")}</span>
          </>
        ) : null}
      </div>
      <div className="topbar__actions">
        {children}
        {!panelVisible ? (
          <div className="shortcut-tooltip-wrap topbar__tooltip-wrap">
            <button
              type="button"
              aria-label={t("topbar.toggle_side_panel.aria")}
              aria-pressed={panelVisible}
              aria-controls="task-workbench"
              data-testid="toggle-side-panel"
              className={`icon-button topbar__icon${panelVisible ? " icon-button--active" : ""}`}
              disabled={!panelAvailable}
              onClick={onTogglePanel}
            >
              <SidePanelIcon />
            </button>
            <span className="shortcut-tooltip topbar__tooltip" role="tooltip">
              <span>
                {panelVisible
                  ? t("topbar.toggle_side_panel.hide")
                  : t("topbar.toggle_side_panel.show")}
              </span>
              <kbd>{getSidePanelToggleShortcutLabel(api.platform)}</kbd>
            </span>
          </div>
        ) : null}
      </div>
    </header>
  );
}
