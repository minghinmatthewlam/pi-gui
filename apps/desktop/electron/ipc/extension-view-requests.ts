import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { parseDesktopHostAction } from "@pi-gui/extension-ui/browser";
import { desktopIpc } from "../../contracts/ipc";
import type { DesktopExtensionViewOwner } from "../extensions/extension-view-owner";
import type { WindowOwner } from "../windows/window-owner";
import { expectNonEmptyString, expectSessionTarget } from "./request-validation";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid extension view request");
  return value as Record<string, unknown>;
}

export function registerExtensionViewRequests(
  windows: WindowOwner,
  owner: DesktopExtensionViewOwner,
): void {
  const senders = new Map<number, Electron.WebContents>();
  const pendingActions = new Map<string, Set<string>>();
  const sender = (event: IpcMainInvokeEvent) => {
    const contents = windows.windowForSender(event.sender).webContents;
    if (event.senderFrame !== contents.mainFrame)
      throw new Error("Extension view requests require the main frame");
    if (!senders.has(contents.id)) {
      senders.set(contents.id, contents);
      contents.on("render-process-gone", () => owner.closeSender(contents.id));
      contents.once("destroyed", () => {
        senders.delete(contents.id);
        owner.closeSender(contents.id);
      });
      contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) owner.closeSender(contents.id);
      });
    }
    return contents;
  };
  owner.subscribe((target) => {
    const views = owner.listViews(target);
    for (const contents of senders.values()) {
      if (!contents.isDestroyed())
        contents.send(desktopIpc.extensionViewCatalogChanged, { target, views });
    }
  });
  ipcMain.handle(desktopIpc.listExtensionViews, (event, raw: unknown) => {
    sender(event);
    return owner.listViews(expectSessionTarget(raw));
  });
  ipcMain.handle(desktopIpc.openExtensionView, (event, raw: unknown) => {
    const contents = sender(event);
    const input = object(raw);
    const target = expectSessionTarget(input.target);
    const selected = windows.targetForSender(contents);
    if (selected?.workspaceId !== target.workspaceId || selected.sessionId !== target.sessionId) {
      throw new Error("Open extension views from their selected task");
    }
    let connectionId = "";
    return owner
      .openConnection(
        {
          target,
          extensionId: expectNonEmptyString(input.extensionId, "extensionId"),
          viewId: expectNonEmptyString(input.viewId, "viewId"),
          senderId: contents.id,
        },
        (message) => {
          if (!contents.isDestroyed())
            contents.send(desktopIpc.extensionViewMessage, { connectionId, message });
        },
      )
      .then((connection) => {
        connectionId = connection.connectionId;
        return connection;
      });
  });
  ipcMain.handle(desktopIpc.sendExtensionViewMessage, async (event, raw: unknown) => {
    const contents = sender(event);
    const input = object(raw);
    const connectionId = expectNonEmptyString(input.connectionId, "connectionId");
    const message = object(input.message);
    if (message.type !== "host-action") {
      await owner.receive(connectionId, contents.id, message);
      return;
    }
    const requestId = expectNonEmptyString(message.requestId, "requestId");
    if (requestId.length > 200) throw new Error("Invalid host action request ID");
    // Validate connection ownership before returning any result to this sender.
    owner.getConnectionContext(connectionId, contents.id);
    let pending = pendingActions.get(connectionId);
    if (!pending) {
      pending = new Set();
      pendingActions.set(connectionId, pending);
    }
    if (pending.has(requestId) || pending.size >= 32) {
      contents.send(desktopIpc.extensionViewMessage, {
        connectionId,
        message: {
          type: "host-action-result",
          requestId,
          ok: false,
          error: "Too many pending desktop actions. Wait for the current actions to finish.",
        },
      });
      return;
    }
    pending.add(requestId);
    let result: { type: "host-action-result"; requestId: string; ok: boolean; error?: string };
    try {
      await owner.invokeHostAction(
        connectionId,
        contents.id,
        parseDesktopHostAction(message.action),
      );
      result = { type: "host-action-result", requestId, ok: true };
    } catch (error) {
      result = {
        type: "host-action-result",
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Extension action failed",
      };
    }
    pending.delete(requestId);
    if (pending.size === 0) pendingActions.delete(connectionId);
    if (!contents.isDestroyed())
      contents.send(desktopIpc.extensionViewMessage, { connectionId, message: result });
  });
  ipcMain.handle(desktopIpc.closeExtensionView, (event, raw: unknown) => {
    const contents = sender(event);
    owner.closeConnection(expectNonEmptyString(raw, "connectionId"), contents.id);
  });
}
