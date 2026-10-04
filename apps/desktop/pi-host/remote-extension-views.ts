/**
 * The app's side of extension views. Backends run in the pi host; this keeps a copy of the
 * open connections so window code can check a frame's connection without waiting.
 */
import { randomUUID } from "node:crypto";
import type { DesktopHostAction } from "@pi-gui/extension-ui/browser";
import type { SessionRef } from "@pi-gui/session-driver";
import type { DesktopExtensionViewInfo } from "../contracts/extension-views";
import {
  appNotifications,
  hostMethods,
  type ExtensionViewAssetResponse,
  type ExtensionViewConnectionContext,
  type OpenViewResult,
  type ViewMessageParams,
  type ViewsChangedParams,
} from "./protocol";
import type { RpcPeer } from "./rpc-peer";

export const DESKTOP_EXTENSION_SCHEME = "pi-extension";

export type ViewsChangedListener = (
  target: SessionRef,
  views: readonly DesktopExtensionViewInfo[],
) => void;

interface OpenConnection {
  readonly context: ExtensionViewConnectionContext;
  readonly clientToken: string;
}

export class RemoteExtensionViews {
  private readonly listeners = new Set<ViewsChangedListener>();
  private readonly connections = new Map<string, OpenConnection>();
  /** By client token: where the host's messages for one frame go, until it says "closed". */
  private readonly senders = new Map<string, (message: unknown) => void>();

  constructor(
    private readonly peer: RpcPeer,
    private readonly onHostAction: (
      context: ExtensionViewConnectionContext & { readonly action: DesktopHostAction },
    ) => Promise<void>,
  ) {
    peer.onNotification(appNotifications.viewsChanged, (params) => {
      const { target, views } = params as ViewsChangedParams;
      for (const listener of this.listeners) listener(target, views);
    });
    peer.onNotification(appNotifications.viewMessage, (params) => {
      const { clientToken, message } = params as ViewMessageParams;
      const send = this.senders.get(clientToken);
      if (isClosedMessage(message)) {
        this.senders.delete(clientToken);
        for (const [connectionId, connection] of this.connections) {
          if (connection.clientToken === clientToken) this.connections.delete(connectionId);
        }
      }
      send?.(message);
    });
  }

  subscribe(listener: ViewsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listViews(target: SessionRef): Promise<readonly DesktopExtensionViewInfo[]> {
    return (await this.peer.request(hostMethods.listViews, target)) as DesktopExtensionViewInfo[];
  }

  async openConnection(
    input: {
      readonly target: SessionRef;
      readonly extensionId: string;
      readonly viewId: string;
      readonly senderId: number;
    },
    send: (message: unknown) => void,
  ): Promise<{ readonly connectionId: string; readonly frameUrl: string }> {
    const clientToken = randomUUID();
    this.senders.set(clientToken, send);
    let result: OpenViewResult;
    try {
      result = (await this.peer.request(hostMethods.openView, {
        ...input,
        clientToken,
      })) as OpenViewResult;
    } catch (error) {
      this.senders.delete(clientToken);
      throw error;
    }
    // A connection closed before the reply arrived stays closed.
    if (this.senders.has(clientToken)) {
      this.connections.set(result.connection.connectionId, {
        context: result.connection,
        clientToken,
      });
    }
    return { connectionId: result.connection.connectionId, frameUrl: result.frameUrl };
  }

  /** Throws unless the connection is open and belongs to this window. */
  getConnectionContext(connectionId: string, senderId: number): ExtensionViewConnectionContext {
    const context = this.connections.get(connectionId)?.context;
    if (!context) throw new Error("Desktop view connection is unavailable");
    if (context.senderId !== senderId) {
      throw new Error("Desktop view connection belongs to another window");
    }
    return { ...context, target: { ...context.target } };
  }

  async receive(connectionId: string, senderId: number, message: unknown): Promise<void> {
    await this.peer.request(hostMethods.receiveViewMessage, { connectionId, senderId, message });
  }

  /** Host actions (open a file, a link, a thread, a draft) are app work, so they run here. */
  async invokeHostAction(
    connectionId: string,
    senderId: number,
    action: DesktopHostAction,
  ): Promise<void> {
    await this.onHostAction({ ...this.getConnectionContext(connectionId, senderId), action });
  }

  closeConnection(connectionId: string, senderId: number): void {
    if (!this.connections.has(connectionId)) return;
    this.getConnectionContext(connectionId, senderId);
    this.connections.delete(connectionId);
    void this.peer
      .request(hostMethods.closeView, { connectionId, senderId })
      .catch(() => undefined);
  }

  closeSender(senderId: number): void {
    for (const [connectionId, { context }] of [...this.connections]) {
      if (context.senderId === senderId) this.connections.delete(connectionId);
    }
    void this.peer.request(hostMethods.closeViewSender, { senderId }).catch(() => undefined);
  }

  async assetResponse(requestUrl: string): Promise<Response> {
    try {
      const asset = (await this.peer.request(hostMethods.viewAsset, {
        url: requestUrl,
      })) as ExtensionViewAssetResponse;
      return new Response(Buffer.from(asset.bodyBase64, "base64"), {
        status: asset.status,
        headers: asset.headers,
      });
    } catch {
      return new Response("Unavailable", { status: 404 });
    }
  }
}

function isClosedMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "closed"
  );
}
