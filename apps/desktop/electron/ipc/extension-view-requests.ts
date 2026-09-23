import { parseDesktopHostAction } from "@pi-gui/extension-ui/browser";
import { desktopIpc } from "../../contracts/ipc";
import type { DesktopExtensionViewOwner } from "../extensions/extension-view-owner";
import type { WindowOwner } from "../windows/window-owner";
import type { MainFrameHandler } from "./main-frame-ipc";
import { expectNonEmptyString, expectRecord, expectSessionTarget } from "./request-validation";

function decodeOpenRequest(raw: unknown) {
  const input = expectRecord(raw, "extension view request");
  return {
    target: expectSessionTarget(input.target),
    extensionId: expectNonEmptyString(input.extensionId, "extensionId"),
    viewId: expectNonEmptyString(input.viewId, "viewId"),
  };
}

function decodeMessageRequest(raw: unknown) {
  const input = expectRecord(raw, "extension view request");
  return {
    connectionId: expectNonEmptyString(input.connectionId, "connectionId"),
    message: expectRecord(input.message, "extension view message"),
  };
}

export function registerExtensionViewRequests(
  handle: MainFrameHandler,
  windows: Pick<WindowOwner, "targetForSender">,
  owner: DesktopExtensionViewOwner,
): void {
  const senders = new Map<number, Electron.WebContents>();
  const pendingActions = new Map<string, Set<string>>();
  const track = (contents: Electron.WebContents) => {
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
  handle(desktopIpc.listExtensionViews, expectSessionTarget, (target, request) => {
    track(request.contents);
    return owner.listViews(target);
  });
  handle(desktopIpc.openExtensionView, decodeOpenRequest, (input, request) => {
    const contents = track(request.contents);
    const { target } = input;
    const selected = windows.targetForSender(contents);
    if (selected?.workspaceId !== target.workspaceId || selected.sessionId !== target.sessionId) {
      throw new Error("Open extension views from their selected task");
    }
    let connectionId = "";
    return owner
      .openConnection(
        {
          target,
          extensionId: input.extensionId,
          viewId: input.viewId,
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
  handle(desktopIpc.sendExtensionViewMessage, decodeMessageRequest, async (input, request) => {
    const contents = track(request.contents);
    const { connectionId, message } = input;
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
  handle(
    desktopIpc.closeExtensionView,
    (raw) => expectNonEmptyString(raw, "connectionId"),
    (connectionId, request) => {
      owner.closeConnection(connectionId, track(request.contents).id);
    },
  );
}
