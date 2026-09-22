import type { WorkspaceRecord, WorktreeRecord } from "../../../contracts/desktop-state";
import { PlusIcon, WorktreeIcon } from "../../ui/icons";

interface WorktreesPanelProps {
  readonly rootWorkspace: WorkspaceRecord;
  readonly activeWorktrees: readonly WorktreeRecord[];
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspace: WorkspaceRecord;
  readonly onOpenWorkspace: (workspaceId: string) => void;
  readonly onNewWorktree: () => void;
}

export function WorktreesPanel({
  rootWorkspace,
  activeWorktrees,
  workspaces,
  selectedWorkspace,
  onOpenWorkspace,
  onNewWorktree,
}: WorktreesPanelProps) {
  const knownWorkspaces = new Set(workspaces.map((workspace) => workspace.id));
  const currentWorkspaceId = selectedWorkspace.id;
  return (
    <section aria-label="Worktrees" className="worktrees-panel" data-testid="worktrees-panel">
      <header className="worktrees-panel__header">
        <div>
          <h2>Worktrees</h2>
          <p>Open a task in a checkout. Your current task stays where it is.</p>
        </div>
        <button className="button" onClick={onNewWorktree} type="button">
          <PlusIcon /> New worktree
        </button>
      </header>
      <div className="worktrees-panel__list">
        <button
          aria-current={currentWorkspaceId === rootWorkspace.id ? "true" : undefined}
          className="worktrees-panel__item"
          onClick={() => onOpenWorkspace(rootWorkspace.id)}
          type="button"
        >
          <WorktreeIcon />
          <span>
            <strong className="worktrees-panel__name">{rootWorkspace.name}</strong>
            <span className="worktrees-panel__meta">
              {rootWorkspace.branchName ?? "Project checkout"}
            </span>
            <span className="worktrees-panel__meta">{rootWorkspace.path}</span>
          </span>
          {currentWorkspaceId === rootWorkspace.id ? <span>Current</span> : null}
        </button>
        {activeWorktrees.map((worktree) => {
          const workspaceId = worktree.linkedWorkspaceId;
          const available =
            worktree.status === "ready" &&
            workspaceId !== undefined &&
            knownWorkspaces.has(workspaceId);
          return (
            <button
              aria-current={currentWorkspaceId === workspaceId ? "true" : undefined}
              className="worktrees-panel__item"
              disabled={!available}
              key={worktree.id}
              onClick={() => {
                if (workspaceId) onOpenWorkspace(workspaceId);
              }}
              type="button"
            >
              <WorktreeIcon />
              <span>
                <strong className="worktrees-panel__name">{worktree.name}</strong>
                <span className="worktrees-panel__meta">{worktree.branchName ?? "Worktree"}</span>
                <span className="worktrees-panel__meta">{worktree.path}</span>
                {!available ? (
                  <span className="worktrees-panel__meta">Checkout unavailable</span>
                ) : null}
              </span>
              {currentWorkspaceId === workspaceId ? <span>Current</span> : null}
            </button>
          );
        })}
      </div>
      {activeWorktrees.length === 0 ? <p>No additional worktrees yet.</p> : null}
    </section>
  );
}
