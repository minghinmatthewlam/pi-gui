import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type {
  AppView,
  SessionRecord,
  WorkspaceRecord,
  WorktreeRecord,
} from "../../contracts/desktop-state";
import { DiffIcon, FileIcon, PromptRailIcon, TerminalIcon } from "../ui/icons";
import { getDesktopShortcutLabel, type PiDesktopApi } from "../../contracts/ipc";
import type { WorkspaceMenuState } from "../features/threads/hooks/use-workspace-menu";

interface TopbarProps {
  readonly activeView: AppView;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly selectedSessionTitle: string | undefined;
  readonly selectedWorktree: WorktreeRecord | undefined;
  readonly activeWorktrees: readonly WorktreeRecord[];
  readonly workspaces: readonly WorkspaceRecord[];
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly terminalAvailable: boolean;
  readonly terminalVisible: boolean;
  readonly onToggleTerminal: () => void;
  readonly panelAvailable: boolean;
  readonly changesVisible: boolean;
  readonly onToggleChanges: () => void;
  readonly filesVisible: boolean;
  readonly onToggleFiles: () => void;
  readonly promptRailVisible: boolean;
  readonly onTogglePromptRail: () => void;
}

export function Topbar(props: TopbarProps) {
  const {
    activeView,
    rootWorkspace,
    selectedWorkspace,
    selectedSession,
    selectedSessionTitle,
    selectedWorktree,
    activeWorktrees,
    workspaces,
    wsMenu,
    api,
    terminalAvailable,
    terminalVisible,
    onToggleTerminal,
    panelAvailable,
    changesVisible,
    onToggleChanges,
    filesVisible,
    onToggleFiles,
    promptRailVisible,
    onTogglePromptRail,
  } = props;
  const terminalShortcut = getDesktopShortcutLabel(api.platform, "J");
  const diffShortcut = getDesktopShortcutLabel(api.platform, "D");

  const handleDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.closest(".topbar__actions")) {
      return;
    }

    void api.toggleWindowMaximize().catch((error: unknown) => {
      console.error("[renderer] toggleWindowMaximize failed", error);
    });
  };

  return (
    <header className="topbar" data-testid="topbar" onDoubleClick={handleDoubleClick}>
      <div className="topbar__title">
        <span className="topbar__workspace">
          {rootWorkspace ? rootWorkspace.name : "Open a folder to begin"}
        </span>
        {selectedWorkspace && activeView === "threads" ? (
          <>
            <span className="topbar__separator">/</span>
            <div className="environment-picker" ref={wsMenu.environmentMenuRef}>
              <button
                aria-expanded={wsMenu.environmentMenuOpen}
                aria-haspopup="menu"
                className="environment-picker__button"
                type="button"
                onClick={() => wsMenu.setEnvironmentMenuOpen((current) => !current)}
              >
                {selectedWorkspace.kind === "worktree"
                  ? (selectedWorktree?.name ?? selectedWorkspace.name)
                  : "Local"}
              </button>
              {wsMenu.environmentMenuOpen && rootWorkspace ? (
                <div className="workspace-menu environment-picker__menu">
                  <button
                    className="workspace-menu__item"
                    type="button"
                    onClick={() => wsMenu.selectWorkspace(rootWorkspace.id)}
                  >
                    Local
                  </button>
                  {activeWorktrees.map((worktree) => {
                    const linkedWorkspace = workspaces.find(
                      (workspace) => workspace.id === worktree.linkedWorkspaceId,
                    );
                    const worktreeSelectable =
                      Boolean(linkedWorkspace) && worktree.status === "ready";
                    return (
                      <button
                        className="workspace-menu__item"
                        key={worktree.id}
                        type="button"
                        disabled={!worktreeSelectable}
                        onClick={() => {
                          if (worktreeSelectable && linkedWorkspace) {
                            wsMenu.selectWorkspace(linkedWorkspace.id);
                          }
                        }}
                      >
                        {worktree.name}
                        {!worktreeSelectable
                          ? ` (${worktree.status !== "ready" ? worktree.status : "unavailable"})`
                          : ""}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        {selectedWorkspace && activeView === "threads" && selectedSession ? (
          <>
            <span className="topbar__separator">/</span>
            <span className="topbar__session">{selectedSessionTitle ?? selectedSession.title}</span>
          </>
        ) : activeView === "new-thread" && rootWorkspace ? (
          <>
            <span className="topbar__separator">/</span>
            <span className="topbar__session">New thread</span>
          </>
        ) : null}
      </div>

      <div className="topbar__actions">
        <TopbarActionButton
          active={terminalVisible}
          disabled={!terminalAvailable}
          icon={<TerminalIcon />}
          label="Toggle terminal"
          shortcut={terminalShortcut}
          onClick={onToggleTerminal}
        />
        <TopbarActionButton
          active={changesVisible}
          disabled={!panelAvailable}
          icon={<DiffIcon />}
          label="Toggle changes"
          shortcut={diffShortcut}
          onClick={onToggleChanges}
        />
        <TopbarActionButton
          active={filesVisible}
          disabled={!panelAvailable}
          icon={<FileIcon />}
          label="Toggle files"
          onClick={onToggleFiles}
        />
        <TopbarActionButton
          active={promptRailVisible}
          icon={<PromptRailIcon />}
          label={promptRailVisible ? "Hide prompt navigation" : "Show prompt navigation"}
          onClick={onTogglePromptRail}
        />
      </div>
    </header>
  );
}

interface TopbarActionButtonProps {
  readonly label: string;
  readonly icon: ReactNode;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly shortcut?: string;
  readonly onClick: () => void;
}

function TopbarActionButton({
  label,
  icon,
  active = false,
  disabled = false,
  shortcut,
  onClick,
}: TopbarActionButtonProps) {
  return (
    <div className="shortcut-tooltip-wrap topbar__tooltip-wrap">
      <button
        aria-label={label}
        className={`icon-button topbar__icon ${active ? "icon-button--active" : ""}`}
        type="button"
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
      </button>
      <span className="shortcut-tooltip topbar__tooltip" role="tooltip">
        <span>{label}</span>
        {shortcut ? <kbd>{shortcut}</kbd> : null}
      </span>
    </div>
  );
}
