/**
 * The pi host process: runs pi, its extensions and extension view backends, and nothing else.
 * It speaks the message pipe in `protocol.ts` over a local socket the app opened, and holds no
 * app state.
 */
import { hostSocketPath, hostToken } from "./host-env";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import { sessionKey, type RuntimeLoginCallbacks, type Unsubscribe } from "@pi-gui/session-driver";
import {
  createOrchestrationRuntimeExtension,
  type OrchestrationRuntimeBridge,
} from "../electron/orchestration/orchestration-runtime";
import {
  createScheduledTaskRuntimeExtension,
  type ScheduledTaskRuntimeBridge,
} from "../electron/scheduled-tasks/scheduled-task-runtime";
import { extensionFrameDocument } from "./extension-views/extension-frame-document";
import { DesktopExtensionViewOwner } from "./extension-views/extension-view-owner";
import {
  appMethods,
  appNotifications,
  decodeArgs,
  encodeResult,
  hostMethods,
  hostNotifications,
  PI_DRIVER_METHODS,
  PI_RUNTIME_METHODS,
  type DriverCallParams,
  type ExtensionViewAssetResponse,
  type GenerateThreadTitleParams,
  type OpenViewParams,
  type OpenViewResult,
  type PiGuiToolName,
  type PiHostConfig,
  type PiHostInitializeParams,
  type RuntimeCallParams,
  type RuntimeLoginParams,
  type SubscribeParams,
  type ToolCaller,
} from "./protocol";
import { remoteCatalogStorage } from "./remote-catalog";
import { RpcPeer } from "../rpc/rpc-peer";
import type { SessionRef } from "@pi-gui/session-driver";

if (!hostSocketPath || !hostToken) {
  console.error("[pi-host] started without a pipe address; only pi-gui starts this process");
  process.exit(2);
}

// A stray error in one extension must not end pi for every thread. Electron's main process,
// where pi used to run, kept going after these too.
process.on("uncaughtException", (error) => console.error("[pi-host] uncaught exception", error));
process.on("unhandledRejection", (reason) =>
  console.error("[pi-host] unhandled rejection", reason),
);

const socket = connect(hostSocketPath);
socket.setEncoding("utf8");
const peer = new RpcPeer({
  transport: {
    send: (line) => {
      socket.write(`${line}\n`);
    },
    close: () => {
      socket.end();
    },
  },
  onDiagnostic: (message) => console.error(`[pi-host] ${message}`),
});
// The first line proves to the app that this is the process it started.
socket.write(`${hostToken}\n`);
socket.on("data", (chunk: string) => peer.receiveChunk(chunk));
socket.on("error", (error) => console.error("[pi-host] pipe error", error));
socket.on("close", () => {
  // The app is gone; nothing else can talk to us.
  peer.close("app closed the pipe");
  process.exit(0);
});

function toolCaller(ctx: ExtensionContext): ToolCaller {
  return {
    cwd: path.resolve(ctx.sessionManager.getCwd?.() ?? ctx.cwd),
    sessionId: ctx.sessionManager.getSessionId(),
  };
}

function callTool<T>(tool: PiGuiToolName, ctx: ExtensionContext, input?: unknown): Promise<T> {
  return peer.request(appMethods.tool, {
    tool,
    caller: toolCaller(ctx),
    ...(input === undefined ? {} : { input }),
  }) as Promise<T>;
}

const orchestrationBridge: OrchestrationRuntimeBridge = {
  createChildThread: (ctx, input) => callTool("orchestration.createChildThread", ctx, input),
  listThreads: (ctx) => callTool("orchestration.listThreads", ctx),
  readThread: (ctx, threadId) => callTool("orchestration.readThread", ctx, threadId),
  sendMessageToThread: (ctx, input) => callTool("orchestration.sendMessageToThread", ctx, input),
};

const scheduledTaskBridge: ScheduledTaskRuntimeBridge = {
  createScheduledTask: (ctx, input) => callTool("scheduled.createScheduledTask", ctx, input),
  listScheduledTasks: (ctx) => callTool("scheduled.listScheduledTasks", ctx),
  updateScheduledTask: (ctx, input) => callTool("scheduled.updateScheduledTask", ctx, input),
};

let config: PiHostConfig = { disabledBuiltinExtensions: [], extensionFlags: {} };
let driver: PiSdkDriver | undefined;
let views: DesktopExtensionViewOwner | undefined;
const subscriptions = new Map<string, Unsubscribe>();

function requireDriver(): PiSdkDriver {
  if (!driver) throw new Error("pi host is not initialized");
  return driver;
}

function requireViews(): DesktopExtensionViewOwner {
  if (!views) throw new Error("pi host is not initialized");
  return views;
}

peer.onNotification(hostNotifications.config, (params) => {
  config = { ...config, ...(params as Partial<PiHostConfig>) };
});

peer.handle(hostMethods.initialize, async (params) => {
  if (driver) throw new Error("pi host is already initialized");
  const input = params as PiHostInitializeParams;
  config = input.config;
  const frameBridge = await readFile(
    createRequire(__filename).resolve("@pi-gui/extension-ui/frame-bridge"),
    "utf8",
  );
  const viewOwner = new DesktopExtensionViewOwner({
    frameDocument: extensionFrameDocument,
    hostAssets: {
      "frame-bridge.js": { body: frameBridge, contentType: "text/javascript; charset=utf-8" },
    },
    // The app runs host actions itself from its copy of the connection.
    onHostAction: () => Promise.reject(new Error("Extension host actions run in the app")),
    onDiagnostic: (target, source, message) =>
      console.error("[extension-view]", target.sessionId, source, message),
  });
  viewOwner.subscribe((target) => {
    peer.notify(appNotifications.viewsChanged, { target, views: viewOwner.listViews(target) });
  });
  views = viewOwner;
  driver = new PiSdkDriver({
    catalogStorage: remoteCatalogStorage(peer),
    isBuiltinExtensionEnabled: (name) => !config.disabledBuiltinExtensions.includes(name),
    extensionFlagValuesForSession: (sessionRef) => config.extensionFlags[sessionKey(sessionRef)],
    onTurnCaptureBoundary: async (boundary, signal) => {
      await peer.request(appMethods.captureBoundary, { boundary }, signal);
    },
    turnCaptureTimeoutMs: input.turnCaptureTimeoutMs,
    desktopExtensions: {
      onChanged: (runtime) => viewOwner.replaceRuntime(runtime),
      onInvalidated: ({ target, generation }) => viewOwner.invalidateRuntime(target, generation),
    },
    openUrl: (url) => peer.notify(appNotifications.openUrl, { url }),
    builtinExtensions: [
      {
        name: "pi-gui-thread-orchestration",
        displayName: "Thread orchestration",
        description: "Lets pi start, read and message other pi-gui threads",
        factory: createOrchestrationRuntimeExtension(orchestrationBridge),
      },
      {
        name: "pi-gui-scheduled-tasks",
        displayName: "Scheduled tasks",
        description: "Lets pi create and update local pi-gui scheduled tasks",
        factory: createScheduledTaskRuntimeExtension(scheduledTaskBridge, (ctx) =>
          callTool<string | null>("scheduled.fallbackWorkspaceId", ctx).then(
            (workspaceId) => workspaceId ?? undefined,
          ),
        ),
      },
    ],
  });
  return null;
});

peer.handle(hostMethods.shutdown, async () => {
  await views?.dispose();
  return null;
});

peer.handle(hostMethods.driverCall, async (params) => {
  const { method, ...encoded } = params as DriverCallParams;
  if (!(PI_DRIVER_METHODS as readonly string[]).includes(method)) {
    throw new Error(`Unknown driver method: ${method}`);
  }
  const target = requireDriver() as unknown as Record<string, (...args: unknown[]) => unknown>;
  return encodeResult(await target[method]!(...decodeArgs(encoded)));
});

peer.handle(hostMethods.runtimeCall, async (params) => {
  const { method, ...encoded } = params as RuntimeCallParams;
  if (!(PI_RUNTIME_METHODS as readonly string[]).includes(method)) {
    throw new Error(`Unknown runtime method: ${method}`);
  }
  const target = requireDriver().runtimeSupervisor as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  return encodeResult(await target[method]!(...decodeArgs(encoded)));
});

peer.handle(hostMethods.runtimeLogin, (params, { signal }) => {
  const input = params as RuntimeLoginParams;
  const { loginId } = input;
  const callbacks: RuntimeLoginCallbacks = {
    onAuth: async (info) => {
      await peer.request(appMethods.loginAuth, { loginId, info }, signal);
    },
    onPrompt: async (prompt) =>
      (await peer.request(appMethods.loginPrompt, { loginId, prompt }, signal)) as string,
    ...(input.hasProgress
      ? {
          onProgress: (message: string) => {
            void peer
              .request(appMethods.loginProgress, { loginId, message }, signal)
              .catch(() => {});
          },
        }
      : {}),
    ...(input.hasManualCodeInput
      ? {
          onManualCodeInput: async () =>
            (await peer.request(appMethods.loginManualCode, { loginId }, signal)) as string,
        }
      : {}),
    signal,
  };
  return requireDriver().runtimeSupervisor.login(input.workspace, input.providerId, callbacks);
});

peer.handle(hostMethods.generateThreadTitle, async (params, { signal }) => {
  const input = params as GenerateThreadTitleParams;
  return encodeResult(
    await requireDriver().generateThreadTitle(input.workspace, { ...input.options, signal }),
  );
});

peer.handle(hostMethods.subscribe, (params) => {
  const { subscriptionId, sessionRef } = params as SubscribeParams;
  const unsubscribe = requireDriver().subscribe(sessionRef, (event) => {
    peer.notify(appNotifications.sessionEvent, { subscriptionId, event });
  });
  subscriptions.set(subscriptionId, unsubscribe);
  return null;
});

peer.onNotification(hostNotifications.unsubscribe, (params) => {
  const { subscriptionId } = params as { subscriptionId: string };
  subscriptions.get(subscriptionId)?.();
  subscriptions.delete(subscriptionId);
});

peer.handle(hostMethods.listViews, (params) => requireViews().listViews(params as SessionRef));

peer.handle(hostMethods.openView, async (params): Promise<OpenViewResult> => {
  const { clientToken, ...input } = params as OpenViewParams;
  const owner = requireViews();
  const opened = await owner.openConnection(input, (message) =>
    peer.notify(appNotifications.viewMessage, { clientToken, message }),
  );
  return {
    connection: owner.getConnectionContext(opened.connectionId, input.senderId),
    frameUrl: opened.frameUrl,
  };
});

peer.handle(hostMethods.receiveViewMessage, async (params) => {
  const { connectionId, senderId, message } = params as {
    connectionId: string;
    senderId: number;
    message: unknown;
  };
  await requireViews().receive(connectionId, senderId, message);
  return null;
});

peer.handle(hostMethods.closeView, (params) => {
  const { connectionId, senderId } = params as { connectionId: string; senderId: number };
  requireViews().closeConnection(connectionId, senderId);
  return null;
});

peer.handle(hostMethods.closeViewSender, (params) => {
  requireViews().closeSender((params as { senderId: number }).senderId);
  return null;
});

peer.handle(hostMethods.viewAsset, async (params): Promise<ExtensionViewAssetResponse> => {
  const response = await requireViews().assetResponse((params as { url: string }).url);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
});
