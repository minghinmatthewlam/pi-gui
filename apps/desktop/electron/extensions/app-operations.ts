import { stat } from "node:fs/promises";
import path from "node:path";
import { parseExtensionUrl, type ExtensionAction, type SessionRef } from "@pi-gui/session-driver";
import type { ExtensionActionEffect } from "../../contracts/extension-actions";
import { resolveExistingWorkspacePath } from "../platform/files/workspace-paths";

/**
 * The app operations a card button can ask for, one per action type, each with its checks.
 * Card buttons reach them only through `runExtensionAction` over a main-frame-only IPC.
 * Extension views still use their own two host actions (`extension-view-actions.ts`).
 */
export interface AppOperationHost {
  readonly workspacePath: (workspaceId: string) => string | undefined;
  readonly openExternal: (url: string) => Promise<void>;
  /** Runs an extension command in the thread; the driver refuses anything else. */
  readonly runExtensionCommand: (target: SessionRef, command: string) => Promise<void>;
}

/** Runs the one operation for a checked action in the card's thread. */
export async function runExtensionAction(
  host: AppOperationHost,
  target: SessionRef,
  action: ExtensionAction,
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
    default:
      return unhandledAction(action);
  }
}

function unhandledAction(action: never): never {
  throw new Error(`Unhandled extension action: ${JSON.stringify(action)}`);
}
