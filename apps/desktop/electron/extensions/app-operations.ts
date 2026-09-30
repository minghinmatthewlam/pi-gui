import { stat } from "node:fs/promises";
import path from "node:path";
import {
  parseExtensionAction,
  parseExtensionUrl,
  type ExtensionAction,
  type ExtensionActionType,
  type SessionRef,
} from "@pi-gui/session-driver";
import type { ExtensionActionEffect } from "../../contracts/extension-actions";
import { resolveExistingWorkspacePath } from "../platform/files/workspace-paths";

/**
 * The app operations an extension's buttons can ask for, one per action type. This is the
 * only list: a button reaches main through `runExtensionAction`, which parses the request
 * again and runs the matching operation with its checks. When the agent is later allowed to
 * drive the app, its tools call these same operations, so both callers share the checks.
 */
export interface AppOperationHost {
  readonly workspacePath: (workspaceId: string) => string | undefined;
  readonly openExternal: (url: string) => Promise<void>;
  /** Runs an extension command in the thread; the driver refuses anything else. */
  readonly runExtensionCommand: (target: SessionRef, command: string) => Promise<void>;
}

type AppOperation<A extends ExtensionAction> = (
  host: AppOperationHost,
  target: SessionRef,
  action: A,
) => Promise<ExtensionActionEffect | undefined>;

type AppOperations = {
  readonly [T in ExtensionActionType]: AppOperation<Extract<ExtensionAction, { type: T }>>;
};

const appOperations: AppOperations = {
  // Only files inside the thread's checkout; the renderer opens the returned relative path.
  openFile: async (host, target, action) => {
    const workspacePath = host.workspacePath(target.workspaceId);
    if (!workspacePath) throw new Error("The thread's folder is unavailable");
    const filePath = await resolveExistingWorkspacePath(workspacePath, action.path);
    if (!(await stat(filePath)).isFile()) throw new Error(`${action.path} is not a file`);
    return {
      kind: "openFile",
      path: path.relative(workspacePath, filePath),
      ...(action.line ? { line: action.line } : {}),
    };
  },
  // Nothing is sent: the renderer adds the text to the draft and the user decides.
  composer: async (_host, _target, action) => ({ kind: "composer", text: action.text }),
  url: async (host, _target, action) => {
    const url = parseExtensionUrl(action.url);
    if (!url) throw new Error("Extensions can only open https links");
    await host.openExternal(url);
    return undefined;
  },
  command: async (host, target, action) => {
    await host.runExtensionCommand(target, action.command);
    return undefined;
  },
};

/** Decodes a button's request at the IPC boundary; renderer input is untrusted. */
export function expectExtensionAction(raw: unknown): ExtensionAction {
  const action = parseExtensionAction(raw);
  if (!action) throw new Error("pi-gui does not support this button's action");
  return action;
}

/** Runs the one operation for a checked action. */
export async function runExtensionAction(
  host: AppOperationHost,
  target: SessionRef,
  action: ExtensionAction,
): Promise<ExtensionActionEffect | undefined> {
  const operation = appOperations[action.type] as AppOperation<ExtensionAction>;
  return operation(host, target, action);
}
