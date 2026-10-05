import type { ChangedFilesResult, WorkspaceFilePreview } from "../../../contracts/ipc";
import { coreMethods } from "../../../core-process/protocol";
import type { RpcPeer } from "../../../rpc/rpc-peer";

/**
 * A folder's file list, file previews, changed files, diffs and staging, run by the Rust core
 * (`crates/pi-gui-core/src/git/workspace_files.rs`) with the same Git arguments and results
 * the app used before.
 */
export interface ListWorkspaceFilesOptions {
  readonly force?: boolean;
  readonly maxFiles?: number;
}

export interface StageFileOptions {
  readonly sourcePath?: string | undefined;
}

export interface WorkspaceFiles {
  listWorkspaceFiles(workspacePath: string, options?: ListWorkspaceFilesOptions): Promise<string[]>;
  readWorkspaceFile(workspacePath: string, filePath: string): Promise<WorkspaceFilePreview>;
  getChangedFiles(workspacePath: string): Promise<ChangedFilesResult>;
  getFileDiff(workspacePath: string, filePath: string): Promise<string>;
  stageFile(workspacePath: string, filePath: string, options?: StageFileOptions): Promise<void>;
}

export function workspaceFilesClient(core: RpcPeer): WorkspaceFiles {
  const call = async <T>(method: string, params: unknown) =>
    (await core.request(method, params)) as T;
  return {
    listWorkspaceFiles: (workspacePath, options = {}) =>
      call(coreMethods.workspaceFilesList, { workspacePath, ...options }),
    readWorkspaceFile: (workspacePath, filePath) =>
      call(coreMethods.workspaceFilesRead, { workspacePath, filePath }),
    getChangedFiles: (workspacePath) => call(coreMethods.workspaceFilesChanged, { workspacePath }),
    getFileDiff: (workspacePath, filePath) =>
      call(coreMethods.workspaceFilesDiff, { workspacePath, filePath }),
    stageFile: async (workspacePath, filePath, options = {}) => {
      await call(coreMethods.workspaceFilesStage, {
        workspacePath,
        filePath,
        ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
      });
    },
  };
}
