import type { WorkspaceRecord, WorktreeRecord } from "../../../contracts/desktop-state";
import type { ReviewScope } from "../../../contracts/review";

export interface DiffPanelFileRequest {
  readonly workspaceId: string;
  readonly path: string;
  readonly nonce: number;
}

export interface DiffPanelSelection {
  readonly workspaceId: string;
  readonly selectedPath: string | null;
  readonly scope: ReviewScope;
}

export interface FileWorkbenchContext {
  readonly workspace: WorkspaceRecord;
  readonly worktree?: WorktreeRecord;
  readonly role: "thread" | "workspace" | "worktree";
  readonly sessionTitle?: string;
}
