import { stat } from "node:fs/promises";
import path from "node:path";
import { parseExtensionUrl, type ExtensionAction, type SessionRef } from "@pi-gui/session-driver";
import type { DesktopAppState, WorkspaceRecord } from "../../contracts/desktop-state";
import type { ExtensionActionEffect } from "../../contracts/extension-actions";
import { resolveExistingWorkspacePath } from "../platform/files/workspace-paths";

/**
 * The app operations an extension's UI can ask for, one per action type, each with its checks.
 * Card buttons reach them through a main-frame-only IPC; extension views reach links and
 * threads through their host actions (`extension-view-actions.ts`), which keep their own
 * file and task-draft actions.
 */
export interface AppOperationHost {
  readonly workspacePath: (workspaceId: string) => string | undefined;
  readonly openExternal: (url: string) => Promise<void>;
  /** Runs an extension command in the thread; the driver refuses anything else. */
  readonly runExtensionCommand: (target: SessionRef, command: string) => Promise<void>;
  readonly workspaces: () => readonly WorkspaceRecord[];
  /** Selects the thread `resolve` names once the window's queue reaches it. */
  readonly selectThread: (resolve: () => SessionRef) => Promise<DesktopAppState>;
}

/** An action as the app runs it; the label only matters for drawing a button. */
export type AppOperation = DistributiveOmit<ExtensionAction, "label">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Runs the one operation for a checked action, on behalf of the target thread. */
export async function runExtensionAction(
  host: AppOperationHost,
  target: SessionRef,
  action: AppOperation,
): Promise<ExtensionActionEffect | undefined> {
  switch (action.type) {
    case "openFile": {
      // Only files inside the thread's checkout; the renderer opens the returned relative path.
      const workspacePath = host.workspacePath(target.workspaceId);
      if (!workspacePath) throw new Error("The thread's folder is unavailable");
      const filePath = await resolveExistingWorkspacePath(workspacePath, action.path);
      if (!(await stat(filePath)).isFile()) throw new Error(`${action.path} is not a file`);
      return {
        kind: "openFile",
        path: path.relative(workspacePath, filePath),
        ...(action.line ? { line: action.line } : {}),
      };
    }
    case "composer":
      // Nothing is sent: the renderer adds the text to the draft and the user decides.
      return { kind: "composer", text: action.text };
    case "url": {
      const url = parseExtensionUrl(action.url);
      if (!url) throw new Error("Extensions can only open https links");
      await host.openExternal(url);
      return undefined;
    }
    case "command":
      await host.runExtensionCommand(target, action.command);
      return undefined;
    case "openThread": {
      const resolve = () => {
        const thread = threadInFolder(host.workspaces(), target, action.sessionId);
        if (!thread) throw new Error("That thread isn't open in this folder");
        return thread;
      };
      // Refuse at once, and again in the queue in case the thread was archived meanwhile.
      resolve();
      const state = await host.selectThread(resolve);
      if (state.lastError) throw new Error(state.lastError);
      return undefined;
    }
    default:
      return unhandledAction(action);
  }
}

/**
 * The unarchived thread with this pi session id in the target's folder or one of that folder's
 * pi-gui worktrees. Extensions only ever reach threads the user sees beside their own.
 */
function threadInFolder(
  workspaces: readonly WorkspaceRecord[],
  target: SessionRef,
  sessionId: string,
): SessionRef | undefined {
  const folderOf = (workspace: WorkspaceRecord) => workspace.rootWorkspaceId ?? workspace.id;
  const origin = workspaces.find((workspace) => workspace.id === target.workspaceId);
  if (!origin) return undefined;
  const folder = folderOf(origin);
  for (const workspace of workspaces) {
    if (folderOf(workspace) !== folder) continue;
    const thread = workspace.sessions.find(
      (session) => session.id === sessionId && !session.archivedAt,
    );
    if (thread) return { workspaceId: workspace.id, sessionId: thread.id };
  }
  return undefined;
}

function unhandledAction(action: never): never {
  throw new Error(`Unhandled extension action: ${JSON.stringify(action)}`);
}
