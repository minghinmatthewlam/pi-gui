/**
 * The app's view of pi: every driver call becomes a request to the pi host process.
 */
import { randomUUID } from "node:crypto";
import type { SessionDriverEvent, SessionRef, Unsubscribe } from "@pi-gui/session-driver";
import type { GenerateThreadTitleOptions } from "@pi-gui/pi-sdk-driver";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import type { RuntimeLoginCallbacks } from "@pi-gui/session-driver";
import {
  appMethods,
  appNotifications,
  decodeResult,
  encodeArgs,
  hostMethods,
  hostNotifications,
  PI_DRIVER_METHODS,
  PI_RUNTIME_METHODS,
  type LoginAuthParams,
  type LoginProgressParams,
  type LoginPromptParams,
  type PiDriverPort,
  type PiHostConfig,
  type SessionEventParams,
} from "./protocol";
import type { RpcPeer } from "../rpc/rpc-peer";

export interface RemotePiDriverOptions {
  readonly peer: RpcPeer;
  /** Read before every call; changes are pushed so pi's synchronous reads see them. */
  readonly config: () => PiHostConfig;
  readonly generateThreadTitleOverride?: (
    workspace: WorkspaceRef,
    options: GenerateThreadTitleOptions,
  ) => Promise<string | null | undefined>;
}

export function createRemotePiDriver(options: RemotePiDriverOptions): PiDriverPort {
  const { peer } = options;
  const listeners = new Map<string, (event: SessionDriverEvent) => void>();
  const logins = new Map<string, RuntimeLoginCallbacks>();
  let sentConfig = "";

  const pushConfig = () => {
    const next = JSON.stringify(options.config());
    if (next === sentConfig) return;
    sentConfig = next;
    peer.notify(hostNotifications.config, JSON.parse(next));
  };
  const request = (method: string, params: unknown, signal?: AbortSignal) => {
    pushConfig();
    return peer.request(method, params, signal);
  };

  peer.onNotification(appNotifications.sessionEvent, (params) => {
    const { subscriptionId, event } = params as SessionEventParams;
    listeners.get(subscriptionId)?.(event);
  });
  const login = (loginId: string) => {
    const callbacks = logins.get(loginId);
    if (!callbacks) throw new Error("Sign-in is no longer in progress");
    return callbacks;
  };
  peer.handle(appMethods.loginAuth, async (params) => {
    const { loginId, info } = params as LoginAuthParams;
    await login(loginId).onAuth(info);
    return null;
  });
  peer.handle(appMethods.loginPrompt, (params) => {
    const { loginId, prompt } = params as LoginPromptParams;
    return login(loginId).onPrompt(prompt);
  });
  peer.handle(appMethods.loginProgress, async (params) => {
    const { loginId, message } = params as LoginProgressParams;
    await login(loginId).onProgress?.(message);
    return null;
  });
  peer.handle(appMethods.loginManualCode, (params) => {
    const callbacks = login((params as { loginId: string }).loginId);
    if (!callbacks.onManualCodeInput) throw new Error("This sign-in does not take a typed code");
    return callbacks.onManualCodeInput();
  });

  const driverMethods = Object.fromEntries(
    PI_DRIVER_METHODS.map((method) => [
      method,
      async (...args: unknown[]) =>
        decodeResult(await request(hostMethods.driverCall, { method, ...encodeArgs(args) })),
    ]),
  );
  const runtimeMethods = Object.fromEntries(
    PI_RUNTIME_METHODS.map((method) => [
      method,
      async (...args: unknown[]) =>
        decodeResult(await request(hostMethods.runtimeCall, { method, ...encodeArgs(args) })),
    ]),
  );

  const port = {
    ...driverMethods,
    async generateThreadTitle(workspace: WorkspaceRef, titleOptions: GenerateThreadTitleOptions) {
      const override = await options.generateThreadTitleOverride?.(workspace, titleOptions);
      if (override !== undefined) return override;
      const { signal, ...rest } = titleOptions;
      return decodeResult(
        await request(hostMethods.generateThreadTitle, { workspace, options: rest }, signal),
      ) as string | null;
    },
    async subscribe(
      sessionRef: SessionRef,
      listener: (event: SessionDriverEvent) => void,
    ): Promise<Unsubscribe> {
      const subscriptionId = randomUUID();
      // Registered first: the host replays the session's state before it replies.
      listeners.set(subscriptionId, listener);
      try {
        await request(hostMethods.subscribe, { subscriptionId, sessionRef });
      } catch (error) {
        listeners.delete(subscriptionId);
        throw error;
      }
      return () => {
        if (!listeners.delete(subscriptionId)) return;
        peer.notify(hostNotifications.unsubscribe, { subscriptionId });
      };
    },
    runtimeSupervisor: {
      ...runtimeMethods,
      async login(workspace: WorkspaceRef, providerId: string, callbacks: RuntimeLoginCallbacks) {
        const loginId = randomUUID();
        logins.set(loginId, callbacks);
        try {
          return await request(
            hostMethods.runtimeLogin,
            {
              loginId,
              workspace,
              providerId,
              hasProgress: Boolean(callbacks.onProgress),
              hasManualCodeInput: Boolean(callbacks.onManualCodeInput),
            },
            callbacks.signal,
          );
        } finally {
          logins.delete(loginId);
        }
      },
    },
  };
  return port as unknown as PiDriverPort;
}
