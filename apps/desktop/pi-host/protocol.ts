/**
 * The message pipe between the app and the pi host process. One file names every method on
 * both sides, so a caller and its handler cannot drift apart.
 *
 * The pi host runs pi, its extensions and extension view backends. The app owns everything
 * else and answers the host's calls for catalog storage, turn capture, pi-gui tools, sign-in
 * prompts and extension view host actions.
 */
import type { PiSdkDriver, RuntimeSupervisor } from "@pi-gui/pi-sdk-driver";
import type {
  ExtensionFlagValues,
  RuntimeLoginAuthInfo,
  RuntimeLoginPrompt,
  SessionDriverEvent,
  SessionRef,
  TurnCaptureBoundary,
  Unsubscribe,
} from "@pi-gui/session-driver";
import type { DesktopExtensionViewInfo } from "../contracts/extension-views";

/** Driver methods the app calls as plain request/response. */
export const PI_DRIVER_METHODS = [
  "createSession",
  "validateForkSession",
  "forkSession",
  "openSession",
  "archiveSession",
  "unarchiveSession",
  "sendUserMessage",
  "replaceQueuedMessages",
  "cancelCurrentRun",
  "setSessionModel",
  "setSessionThinkingLevel",
  "renameSession",
  "compactSession",
  "reloadSession",
  "reloadSessionWhenIdle",
  "getSessionTree",
  "navigateSessionTree",
  "getSessionCommands",
  "respondToHostUiRequest",
  "closeSession",
  "listWorkspaces",
  "listSessions",
  "syncWorkspace",
  "reconcileWorkspace",
  "getSessionFilePath",
  "renameWorkspace",
  "removeWorkspace",
  "getTranscript",
  "getSessionSchemaInfo",
] as const satisfies readonly (keyof PiSdkDriver)[];

/** Runtime (settings, models, sign-in, MCP) methods the app calls as plain request/response. */
export const PI_RUNTIME_METHODS = [
  "getRuntimeSnapshot",
  "refreshRuntime",
  "logout",
  "setProviderApiKey",
  "listCustomProviders",
  "setCustomProvider",
  "deleteCustomProvider",
  "setDefaultModel",
  "setProjectDefaultModel",
  "setDefaultThinkingLevel",
  "setProjectDefaultThinkingLevel",
  "setEnableSkillCommands",
  "getCodemodeAlwaysOn",
  "setCodemodeAlwaysOn",
  "listMcpServers",
  "addMcpServer",
  "removeMcpServer",
  "setMcpServerEnabled",
  "setScopedModelPatterns",
  "setProjectScopedModelPatterns",
  "getGlobalModelSettings",
  "getCurrentModelSettings",
  "setSkillEnabled",
  "setExtensionEnabled",
  "builtinExtensionName",
] as const satisfies readonly (keyof RuntimeSupervisor)[];

export type PiDriverMethod = (typeof PI_DRIVER_METHODS)[number];
export type PiRuntimeMethod = (typeof PI_RUNTIME_METHODS)[number];

type Remote<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

/** What the app uses of pi: every call is asynchronous because pi runs in another process. */
export type PiDriverPort = { readonly [K in PiDriverMethod]: Remote<PiSdkDriver[K]> } & {
  readonly generateThreadTitle: PiSdkDriver["generateThreadTitle"];
  /** Resolves once the host is listening; rejects for an unknown session. */
  subscribe(
    sessionRef: SessionRef,
    listener: (event: SessionDriverEvent) => void,
  ): Promise<Unsubscribe>;
  readonly runtimeSupervisor: { readonly [K in PiRuntimeMethod]: Remote<RuntimeSupervisor[K]> } & {
    readonly login: RuntimeSupervisor["login"];
  };
};

/**
 * Arguments cross as JSON, which turns `undefined` into `null` in arrays. The positions that
 * were `undefined` travel separately so optional parameters arrive exactly as passed.
 */
export interface EncodedArgs {
  readonly args: readonly unknown[];
  readonly undefinedAt?: readonly number[];
}

/** A result that may be `undefined`: `{}` means undefined, `{ value: null }` means null. */
export interface EncodedResult {
  readonly value?: unknown;
}

export function encodeArgs(args: readonly unknown[]): EncodedArgs {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  const kept = args.slice(0, end);
  const undefinedAt = kept.flatMap((value, index) => (value === undefined ? [index] : []));
  return undefinedAt.length > 0 ? { args: kept, undefinedAt } : { args: kept };
}

export function decodeArgs(encoded: EncodedArgs): unknown[] {
  const args = [...encoded.args];
  for (const index of encoded.undefinedAt ?? []) args[index] = undefined;
  return args;
}

export function encodeResult(value: unknown): EncodedResult {
  return value === undefined ? {} : { value };
}

export function decodeResult(encoded: unknown): unknown {
  return (encoded as EncodedResult | null)?.value;
}

/** Values pi reads synchronously while building a session; the app pushes them on change. */
export interface PiHostConfig {
  readonly disabledBuiltinExtensions: readonly string[];
  /** By `sessionKey`. */
  readonly extensionFlags: Readonly<Record<string, ExtensionFlagValues>>;
}

export interface PiHostInitializeParams {
  readonly config: PiHostConfig;
  readonly turnCaptureTimeoutMs: number;
}

/** Identifies the session a pi-gui tool runs in; the app resolves it to a thread. */
export interface ToolCaller {
  readonly cwd: string;
  readonly sessionId: string;
}

export type PiGuiToolName =
  | "orchestration.createChildThread"
  | "orchestration.listThreads"
  | "orchestration.readThread"
  | "orchestration.sendMessageToThread"
  | "scheduled.createScheduledTask"
  | "scheduled.listScheduledTasks"
  | "scheduled.updateScheduledTask"
  | "scheduled.fallbackWorkspaceId";

export interface ExtensionViewConnectionContext {
  readonly connectionId: string;
  readonly senderId: number;
  readonly target: SessionRef;
  readonly generation: string;
  readonly extensionId: string;
  readonly viewId: string;
}

export interface ExtensionViewAssetResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBase64: string;
}

/** App → host requests. */
export const hostMethods = {
  initialize: "host.initialize",
  shutdown: "host.shutdown",
  driverCall: "driver.call",
  runtimeCall: "runtime.call",
  runtimeLogin: "runtime.login",
  generateThreadTitle: "driver.generateThreadTitle",
  subscribe: "driver.subscribe",
  listViews: "views.list",
  openView: "views.open",
  receiveViewMessage: "views.receive",
  closeView: "views.close",
  closeViewSender: "views.closeSender",
  viewAsset: "views.asset",
} as const;

/** App → host notifications. */
export const hostNotifications = {
  config: "config.update",
  unsubscribe: "driver.unsubscribe",
} as const;

/** Host → app requests. */
export const appMethods = {
  catalog: "app.catalog",
  captureBoundary: "app.captureBoundary",
  tool: "app.tool",
  loginAuth: "app.login.auth",
  loginPrompt: "app.login.prompt",
  loginProgress: "app.login.progress",
  loginManualCode: "app.login.manualCode",
} as const;

/** Host → app notifications. */
export const appNotifications = {
  sessionEvent: "session.event",
  viewsChanged: "views.changed",
  viewMessage: "views.message",
  openUrl: "app.openUrl",
  diagnostic: "host.diagnostic",
} as const;

export interface DriverCallParams extends EncodedArgs {
  readonly method: PiDriverMethod;
}

export interface RuntimeCallParams extends EncodedArgs {
  readonly method: PiRuntimeMethod;
}

export interface RuntimeLoginParams {
  readonly loginId: string;
  readonly workspace: Parameters<RuntimeSupervisor["login"]>[0];
  readonly providerId: string;
  readonly hasProgress: boolean;
  readonly hasManualCodeInput: boolean;
}

export interface GenerateThreadTitleParams {
  readonly workspace: Parameters<PiSdkDriver["generateThreadTitle"]>[0];
  readonly options: Omit<Parameters<PiSdkDriver["generateThreadTitle"]>[1], "signal">;
}

export interface SubscribeParams {
  readonly subscriptionId: string;
  readonly sessionRef: SessionRef;
}

export interface SessionEventParams {
  readonly subscriptionId: string;
  readonly event: SessionDriverEvent;
}

export interface CatalogCallParams extends EncodedArgs {
  /** For example `sessions.upsertSession` or `getSessionFile`. */
  readonly path: string;
}

export interface CaptureBoundaryParams {
  readonly boundary: TurnCaptureBoundary;
}

export interface ToolCallParams {
  readonly tool: PiGuiToolName;
  readonly caller: ToolCaller;
  readonly input?: unknown;
}

export interface LoginAuthParams {
  readonly loginId: string;
  readonly info: RuntimeLoginAuthInfo;
}

export interface LoginPromptParams {
  readonly loginId: string;
  readonly prompt: RuntimeLoginPrompt;
}

export interface LoginProgressParams {
  readonly loginId: string;
  readonly message: string;
}

export interface OpenViewParams {
  readonly target: SessionRef;
  readonly extensionId: string;
  readonly viewId: string;
  readonly senderId: number;
  /** Chosen by the app so messages sent before the reply can still be routed. */
  readonly clientToken: string;
}

export interface OpenViewResult {
  readonly connection: ExtensionViewConnectionContext;
  readonly frameUrl: string;
}

export interface ViewMessageParams {
  readonly clientToken: string;
  readonly message: unknown;
}

export interface ViewsChangedParams {
  readonly target: SessionRef;
  readonly views: readonly DesktopExtensionViewInfo[];
}
