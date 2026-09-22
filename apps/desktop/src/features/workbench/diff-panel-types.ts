import type { WorkspaceRecord, WorktreeRecord } from "../../../contracts/desktop-state";

export interface DiffPanelFileRequest {
  readonly workspaceId: string;
  readonly path: string;
  readonly nonce: number;
}

export interface DiffPanelSelection {
  readonly workspaceId: string;
  readonly selectedPath: string | null;
}

export interface FileWorkbenchContext {
  readonly workspace: WorkspaceRecord;
  readonly worktree?: WorktreeRecord;
  readonly role: "thread" | "workspace" | "worktree";
  readonly sessionTitle?: string;
}
