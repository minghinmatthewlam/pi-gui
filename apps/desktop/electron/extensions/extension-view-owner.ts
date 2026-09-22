import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createFacetHost, type FacetHost } from "@earendil-works/chord";
import type { DesktopViewDeclaration } from "@pi-gui/extension-ui";
import type { DesktopHostAction } from "@pi-gui/extension-ui/browser";
import { createChordServerConnection } from "@pi-gui/extension-ui/transport";
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";
import type { DesktopExtensionViewInfo } from "../../contracts/extension-views";
import {
  resolveDesktopExtensionAsset,
  validateDesktopExtensionIdentity,
  validateDesktopExtensionFrontend,
  type DesktopExtensionSourceIdentity,
  type LoadedDesktopExtensionSource,
  type ValidatedDesktopExtensionSource,
} from "./extension-view-source";

export const DESKTOP_EXTENSION_SCHEME = "pi-extension";

export type { DesktopExtensionViewInfo } from "../../contracts/extension-views";

export interface DesktopExtensionRuntimeInput {
  readonly target: SessionRef;
  readonly generation: string;
  readonly extensions: readonly LoadedDesktopExtensionSource[];
  readonly declarations: readonly DesktopViewDeclaration[];
}

export interface DesktopExtensionConnectionContext {
  readonly connectionId: string;
  readonly senderId: number;
  readonly target: SessionRef;
  readonly generation: string;
  readonly extensionId: string;
  readonly viewId: string;
}

export interface DesktopExtensionHostAsset {
  readonly body: string | Uint8Array;
  readonly contentType: string;
}

export interface DesktopExtensionViewOwnerOptions {
  readonly frameDocument: (input: {
    readonly connectionId: string;
    readonly frontendUrl: string;
    readonly bridgeUrl: string;
    readonly nonce: string;
  }) => string;
  readonly hostAssets?: Readonly<Record<string, DesktopExtensionHostAsset>>;
  readonly onHostAction: (
    context: DesktopExtensionConnectionContext & { readonly action: DesktopHostAction },
  ) => Promise<void>;
  readonly onDiagnostic?: (target: SessionRef, source: string, message: string) => void;
  readonly activationTimeoutMs?: number;
}

interface RuntimeEntry {
  readonly target: SessionRef;
  readonly generation: string;
  readonly views: Map<string, ViewEntry>;
  readonly pending: Map<DesktopViewDeclaration, Promise<void>>;
  readonly activating: Map<string, DesktopViewDeclaration>;
  desired: ReadonlySet<DesktopViewDeclaration>;
  alive: boolean;
}

interface ViewEntry {
  readonly declaration: DesktopViewDeclaration;
  readonly source: DesktopExtensionSourceIdentity;
  readonly assets?: ValidatedDesktopExtensionSource;
  readonly info: DesktopExtensionViewInfo;
  readonly host?: FacetHost;
}

interface ConnectionEntry {
  readonly context: DesktopExtensionConnectionContext;
  readonly runtime: RuntimeEntry;
  readonly view: ViewEntry;
  readonly assets: ValidatedDesktopExtensionSource;
  readonly send: (message: unknown) => void;
  readonly transport: ReturnType<typeof createChordServerConnection>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function viewKey(extensionId: string, viewId: string): string {
  return `${extensionId}:${viewId}`;
}

function validateDeclaration(declaration: DesktopViewDeclaration): void {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(declaration.id)) {
    throw new Error("Desktop view ID must be a lowercase identifier of at most 64 characters");
  }
  if (!declaration.title.trim() || declaration.title.length > 120) {
    throw new Error("Desktop view title must be 1–120 characters");
  }
  if (typeof declaration.backend !== "function") {
    throw new Error("Desktop view must declare a backend facet factory");
  }
}

/** Owns live extension views, never Pi session selection or durable extension state. */
export class DesktopExtensionViewOwner {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly connections = new Map<string, ConnectionEntry>();
  private readonly listeners = new Set<(target: SessionRef) => void>();

  constructor(private readonly options: DesktopExtensionViewOwnerOptions) {}

  subscribe(listener: (target: SessionRef) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listViews(target: SessionRef): readonly DesktopExtensionViewInfo[] {
    const runtime = this.runtimes.get(sessionKey(target));
    return runtime?.alive ? [...runtime.views.values()].map(({ info }) => ({ ...info })) : [];
  }

  async replaceRuntime(input: DesktopExtensionRuntimeInput): Promise<void> {
    const key = sessionKey(input.target);
    let runtime = this.runtimes.get(key);
    if (runtime?.generation !== input.generation) {
      const previous = runtime;
      runtime = {
        target: { ...input.target },
        generation: input.generation,
        views: new Map(),
        pending: new Map(),
        activating: new Map(),
        desired: new Set(input.declarations),
        alive: true,
      };
      this.runtimes.set(key, runtime);
      if (previous)
        this.disposeRuntime(previous).catch((error: unknown) => {
          this.options.onDiagnostic?.(previous.target, "desktop-view", messageOf(error));
        });
    }
    if (!runtime.alive) return;
    const declarations = new Set(input.declarations);
    runtime.desired = declarations;
    for (const [registeredKey, view] of runtime.views) {
      if (declarations.has(view.declaration)) continue;
      runtime.views.delete(registeredKey);
      this.closeViewConnections(runtime, view, "Extension view was removed");
      if (view.host)
        view.host.dispose().catch((error: unknown) => {
          this.options.onDiagnostic?.(runtime.target, view.source.sourcePath, messageOf(error));
        });
    }
    const activations: Promise<void>[] = [];
    for (const declaration of declarations) {
      if ([...runtime.views.values()].some((view) => view.declaration === declaration)) continue;
      const pending = runtime.pending.get(declaration);
      if (pending) {
        activations.push(pending);
        continue;
      }
      const activation = this.activateView(runtime, declaration, input.extensions).finally(() => {
        runtime.pending.delete(declaration);
      });
      runtime.pending.set(declaration, activation);
      activations.push(activation);
    }
    await Promise.all(activations);
    this.publish(runtime.target);
  }

  async invalidateRuntime(target: SessionRef, generation: string): Promise<void> {
    const key = sessionKey(target);
    const runtime = this.runtimes.get(key);
    if (runtime?.generation !== generation) return;
    this.runtimes.delete(key);
    const disposal = this.disposeRuntime(runtime);
    this.publish(target);
    await disposal;
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
    const runtime = this.runtimes.get(sessionKey(input.target));
    const view = runtime?.views.get(viewKey(input.extensionId, input.viewId));
    if (!runtime?.alive || !view?.host || !view.assets) {
      throw new Error(view?.info.error ?? "Desktop extension view is unavailable");
    }
    const connectionId = randomUUID();
    const context: DesktopExtensionConnectionContext = {
      connectionId,
      senderId: input.senderId,
      target: { ...runtime.target },
      generation: runtime.generation,
      extensionId: input.extensionId,
      viewId: input.viewId,
    };
    const transport = createChordServerConnection({
      provider: view.host.services,
      send: (message) => {
        if (!this.connections.has(connectionId)) return;
        try {
          send(message);
        } catch {
          this.closeConnection(connectionId, input.senderId);
        }
      },
      onError: (error) => {
        this.options.onDiagnostic?.(runtime.target, view.source.sourcePath, messageOf(error));
        this.closeConnection(connectionId, input.senderId);
      },
    });
    this.connections.set(connectionId, {
      context,
      runtime,
      view,
      assets: view.assets,
      send,
      transport,
    });
    return { connectionId, frameUrl: `${DESKTOP_EXTENSION_SCHEME}://${connectionId}/` };
  }

  getConnectionContext(connectionId: string, senderId: number): DesktopExtensionConnectionContext {
    const connection = this.requireConnection(connectionId, senderId);
    return { ...connection.context, target: { ...connection.context.target } };
  }

  async receive(connectionId: string, senderId: number, message: unknown): Promise<void> {
    const connection = this.requireConnection(connectionId, senderId);
    await connection.transport.receive(message);
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "closed"
    ) {
      this.closeConnection(connectionId, senderId);
    }
  }

  async invokeHostAction(
    connectionId: string,
    senderId: number,
    action: DesktopHostAction,
  ): Promise<void> {
    const context = this.getConnectionContext(connectionId, senderId);
    await this.options.onHostAction({ ...context, action });
  }

  closeConnection(connectionId: string, senderId: number): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (connection.context.senderId !== senderId)
      throw new Error("Desktop view connection belongs to another window");
    this.close(connection, "Desktop view was closed");
  }

  closeSender(senderId: number): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.context.senderId === senderId)
        this.close(connection, "Desktop window was closed");
    }
  }

  /** Protocol handler: a random live connection grants read access only to its browser build. */
  async assetResponse(requestUrl: string): Promise<Response> {
    try {
      const url = new URL(requestUrl);
      if (
        url.protocol !== `${DESKTOP_EXTENSION_SCHEME}:` ||
        url.username ||
        url.password ||
        url.port ||
        url.search
      ) {
        return new Response("Unavailable", { status: 404 });
      }
      const connection = this.connections.get(url.hostname);
      if (!connection || !connection.runtime.alive)
        return new Response("Unavailable", { status: 404 });
      const headers = new Headers({
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff",
      });
      if (url.pathname === "/") {
        const nonce = randomUUID();
        const origin = `${DESKTOP_EXTENSION_SCHEME}://${connection.context.connectionId}`;
        headers.set("Content-Type", "text/html; charset=utf-8");
        headers.set(
          "Content-Security-Policy",
          [
            "default-src 'none'",
            `script-src 'nonce-${nonce}' ${origin}`,
            `style-src 'unsafe-inline' ${origin}`,
            `img-src data: ${origin}`,
            `font-src ${origin}`,
            "connect-src 'none'",
            "object-src 'none'",
            "frame-src 'none'",
            "worker-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "sandbox allow-scripts",
          ].join("; "),
        );
        const body = this.options.frameDocument({
          connectionId: connection.context.connectionId,
          frontendUrl: `${origin}/assets/${encodeURIComponent(path.basename(connection.assets.frontendPath))}`,
          bridgeUrl: `${origin}/_host/frame-bridge.js`,
          nonce,
        });
        return new Response(body, { headers });
      }
      if (url.pathname.startsWith("/_host/")) {
        const assetName = url.pathname.slice("/_host/".length);
        const asset =
          this.options.hostAssets && Object.hasOwn(this.options.hostAssets, assetName)
            ? this.options.hostAssets[assetName]
            : undefined;
        if (!asset) return new Response("Unavailable", { status: 404 });
        headers.set("Content-Type", asset.contentType);
        return new Response(
          typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body),
          { headers },
        );
      }
      if (!url.pathname.startsWith("/assets/")) return new Response("Unavailable", { status: 404 });
      const assetPath = await resolveDesktopExtensionAsset(
        connection.assets.assetRoot,
        url.pathname.slice("/assets/".length),
      );
      const contents = await readFile(assetPath);
      if (this.connections.get(url.hostname) !== connection)
        return new Response("Unavailable", { status: 404 });
      const contentType = assetContentType(assetPath);
      if (!contentType) return new Response("Unsupported asset", { status: 415 });
      headers.set("Content-Type", contentType);
      return new Response(new Uint8Array(contents), { headers });
    } catch {
      return new Response("Unavailable", { status: 404 });
    }
  }

  async dispose(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((runtime) => this.disposeRuntime(runtime)));
    this.listeners.clear();
  }

  private async activateView(
    runtime: RuntimeEntry,
    declaration: DesktopViewDeclaration,
    extensions: readonly LoadedDesktopExtensionSource[],
  ): Promise<void> {
    let source: DesktopExtensionSourceIdentity | undefined;
    let key: string | undefined;
    let reserved = false;
    try {
      validateDeclaration(declaration);
      source = await validateDesktopExtensionIdentity(declaration.source, extensions);
      if (!runtime.alive || !runtime.desired.has(declaration)) return;
      key = viewKey(source.extensionId, declaration.id);
      const pendingDeclaration = runtime.activating.get(key);
      if (runtime.views.has(key) || (pendingDeclaration && runtime.desired.has(pendingDeclaration)))
        throw new Error("Duplicate desktop view ID in one extension");
      // A removed registration cannot reserve its ID while authored activation is still pending.
      runtime.activating.set(key, declaration);
      reserved = true;
      const assets = await validateDesktopExtensionFrontend(source, declaration.frontend);
      if (!runtime.alive || !runtime.desired.has(declaration)) return;
      const activation = createFacetHost({
        facets: [declaration.backend()],
        onError: (error) =>
          this.options.onDiagnostic?.(runtime.target, declaration.source, messageOf(error)),
      });
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Chord activation is cooperative. A late result still owns resources and must be disposed.
      void activation
        .then((host) => {
          if (expired) return host.dispose();
        })
        .catch((error: unknown) => {
          if (expired)
            this.options.onDiagnostic?.(runtime.target, declaration.source, messageOf(error));
        });
      let host: FacetHost;
      try {
        host = await Promise.race([
          activation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(
                new Error("Desktop view activation timed out. Reload the extension to retry."),
              );
            }, this.options.activationTimeoutMs ?? 10_000);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!runtime.alive || !runtime.desired.has(declaration)) {
        await host.dispose();
        return;
      }
      runtime.views.set(key, {
        declaration,
        source,
        assets,
        host,
        info: {
          id: declaration.id,
          extensionId: source.extensionId,
          title: declaration.title,
          generation: runtime.generation,
          state: "ready",
        },
      });
    } catch (error) {
      const message = messageOf(error);
      this.options.onDiagnostic?.(runtime.target, declaration.source, message);
      if (
        runtime.alive &&
        runtime.desired.has(declaration) &&
        source &&
        key &&
        !runtime.views.has(key) &&
        (reserved || !runtime.activating.has(key))
      ) {
        runtime.views.set(key, {
          declaration,
          source,
          info: {
            id: declaration.id,
            extensionId: source.extensionId,
            title: declaration.title,
            generation: runtime.generation,
            state: "error",
            error: message,
          },
        });
      }
    } finally {
      if (key && reserved && runtime.activating.get(key) === declaration)
        runtime.activating.delete(key);
      if (runtime.alive) this.publish(runtime.target);
    }
  }

  private requireConnection(connectionId: string, senderId: number): ConnectionEntry {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.runtime.alive)
      throw new Error("Desktop view connection is unavailable");
    if (connection.context.senderId !== senderId)
      throw new Error("Desktop view connection belongs to another window");
    return connection;
  }

  private close(connection: ConnectionEntry, reason: string): void {
    this.connections.delete(connection.context.connectionId);
    connection.transport.close(reason);
    try {
      connection.send({ type: "closed", reason });
    } catch {
      /* The owning window can already be gone. */
    }
  }

  private closeViewConnections(runtime: RuntimeEntry, view: ViewEntry, reason: string): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.runtime === runtime && connection.view === view)
        this.close(connection, reason);
    }
  }

  private async disposeRuntime(runtime: RuntimeEntry): Promise<void> {
    runtime.alive = false;
    for (const connection of [...this.connections.values()]) {
      if (connection.runtime === runtime)
        this.close(connection, "Pi extension runtime was replaced");
    }
    await Promise.allSettled(runtime.pending.values());
    const hosts = [...runtime.views.values()].flatMap(({ host }) => (host ? [host] : []));
    runtime.views.clear();
    const results = await Promise.allSettled(hosts.map((host) => host.dispose()));
    for (const result of results) {
      if (result.status === "rejected")
        this.options.onDiagnostic?.(runtime.target, "desktop-view", messageOf(result.reason));
    }
  }

  private publish(target: SessionRef): void {
    for (const listener of this.listeners) listener({ ...target });
  }
}

function assetContentType(file: string): string | undefined {
  const types: Readonly<Record<string, string>> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return types[path.extname(file).toLowerCase()];
}
