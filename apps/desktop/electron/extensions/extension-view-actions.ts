import { webContents, type BrowserWindow } from "electron";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopHostAction } from "@pi-gui/extension-ui/browser";
import { desktopIpc } from "../../contracts/ipc";
import type { DesktopAppStore } from "../application/app-store";
import { resolveExistingWorkspacePath } from "../platform/files/workspace-paths";
import type { WindowOwner } from "../windows/window-owner";
import { runExtensionAction, type AppOperationHost } from "./app-operations";
import type {
  DesktopExtensionViewOwner,
  DesktopExtensionConnectionContext,
} from "./extension-view-owner";

export async function performExtensionViewHostAction(
  owners: {
    readonly store: DesktopAppStore;
    readonly windows: WindowOwner;
    readonly views: DesktopExtensionViewOwner;
    readonly openExternal: (url: string) => Promise<void>;
    /** Saves the window's debounced composer draft; it must not run inside the window's queue. */
    readonly saveComposerDraft: (window: BrowserWindow) => Promise<void>;
  },
  context: DesktopExtensionConnectionContext & { readonly action: DesktopHostAction },
): Promise<void> {
  const contents = webContents.fromId(context.senderId);
  if (!contents || contents.isDestroyed()) throw new Error("The requesting window is closed");
  const window = owners.windows.windowForSender(contents);
  const requireCurrentTask = () => {
    owners.views.getConnectionContext(context.connectionId, context.senderId);
    const view = owners.windows.viewForWindow(window);
    if (
      view.activeView !== "threads" ||
      view.selectedWorkspaceId !== context.target.workspaceId ||
      view.selectedSessionId !== context.target.sessionId
    ) {
      throw new Error("Return to the extension's task to use this action");
    }
  };
  requireCurrentTask();
  const action = context.action;
  if (action.type === "openUrl" || action.type === "openThread") {
    // Links and threads run through the same checked operations as card buttons.
    const host: AppOperationHost = {
      workspacePath: (workspaceId) => owners.store.getWorkspacePath(workspaceId),
      openExternal: owners.openExternal,
      runExtensionCommand: () => Promise.reject(new Error("Views can't run commands")),
      workspaces: () => owners.store.getWorkspaceRecords(),
      // Selecting the thread closes this view, so the view's call settles once the thread is
      // found. The switch starts after that result has gone out: `setImmediate` runs only once
      // the awaits that send it have unwound.
      selectThread: async (resolve) => {
        setImmediate(() => {
          // The switch drops the composer's debounced draft, so save it first.
          void owners
            .saveComposerDraft(window)
            .then(() =>
              owners.windows.runStateAction(window, async () => {
                try {
                  requireCurrentTask();
                } catch {
                  // The user already left the view's task; there is nothing to switch from.
                  return owners.store.getState();
                }
                try {
                  return await owners.store.selectSession(resolve());
                } catch (error) {
                  // The thread went away meanwhile: say so in the app, since the view is told ok.
                  return owners.store.withError(error);
                }
              }),
            )
            .catch((error: unknown) => console.error("[extension-view] open thread failed", error));
        });
      },
    };
    await runExtensionAction(
      host,
      context.target,
      action.type === "openUrl"
        ? { type: "url", url: action.url }
        : { type: "openThread", sessionId: action.sessionId },
    );
    return;
  }
  const workspacePath = owners.store.getWorkspacePath(context.target.workspaceId);
  if (!workspacePath) throw new Error("The task checkout is unavailable");
  const existingFile = async (requestedPath: string) => {
    const filePath = await resolveExistingWorkspacePath(workspacePath, requestedPath);
    if (!(await stat(filePath)).isFile()) throw new Error("The selected path is not a file");
    return filePath;
  };
  if (action.type === "openFile") {
    const filePath = await existingFile(action.path);
    requireCurrentTask();
    contents.send(desktopIpc.extensionViewOpenFile, {
      target: context.target,
      path: path.relative(workspacePath, filePath),
      ...(action.line === undefined ? {} : { line: action.line }),
      ...(action.column === undefined ? {} : { column: action.column }),
    });
    return;
  }
  const files = await Promise.all(
    (action.files ?? []).map(async (file) => {
      const filePath = await existingFile(file.path);
      return {
        path: path.relative(workspacePath, filePath),
        line: file.line,
      };
    }),
  );
  requireCurrentTask();
  await owners.windows.runStateAction(window, async () => {
    // The window's action queue may have advanced while this action was waiting.
    requireCurrentTask();
    const state = await owners.store.createSession({
      workspaceId: context.target.workspaceId,
      title: action.title,
    });
    if (state.lastError) throw new Error(state.lastError);
    const draftTarget = {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };
    const contextText = files.length
      ? "\n\nFiles:\n" +
        files.map((file) => `- ${file.path}${file.line ? `:${file.line}` : ""}`).join("\n")
      : "";
    return owners.store.updateComposerDraft(draftTarget, action.prompt + contextText);
  });
}
