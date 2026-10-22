import {
  createPiAppBridge,
  encodeKernelArgs,
  settleKernelAnswer,
  type KernelAnswer,
  type PiAppBridge,
} from "./pi-app-api";

/**
 * `window.piApp` over the Rust test host's WebSocket, for a page opened with
 * `?testhost=ws://…`. It stands in for the Electron preload: each call goes to the kernel by
 * its API name, and pushes arrive by their `desktopIpc` channel.
 */

const WINDOW_ID_KEY = "pi-gui:testhost-window";

interface WireMessage extends KernelAnswer {
  readonly id?: number;
  readonly push?: string;
  readonly payload?: unknown;
  readonly hello?: { readonly window: number | null; readonly platform: string };
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export function testHostUrl(search: string = window.location.search): string | undefined {
  const url = new URLSearchParams(search).get("testhost");
  return url && /^wss?:\/\//.test(url) ? url : undefined;
}

function readStoredWindowId(): number | undefined {
  try {
    const stored = Number(window.sessionStorage.getItem(WINDOW_ID_KEY));
    return Number.isSafeInteger(stored) && stored > 0 ? stored : undefined;
  } catch {
    return undefined;
  }
}

function storeWindowId(id: number): void {
  try {
    window.sessionStorage.setItem(WINDOW_ID_KEY, String(id));
  } catch {
    // A page without storage starts a new window on reload.
  }
}

/** Connects, then installs `window.piApp`. Resolves once the host has named this window. */
export function installTestHostTransport(url: string): Promise<void> {
  const socket = new WebSocket(url);
  const pending = new Map<number, Pending>();
  let bridge: PiAppBridge | undefined;
  let nextId = 0;

  const encode = (method: string, args: readonly unknown[], id?: number): string =>
    JSON.stringify({
      ...(id === undefined ? {} : { id }),
      method,
      ...encodeKernelArgs(args),
    });

  const transport = {
    request: (method: string, args: readonly unknown[]): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        nextId += 1;
        pending.set(nextId, { resolve, reject });
        socket.send(encode(method, args, nextId));
      }),
    send: (method: string, args: readonly unknown[]): void => {
      socket.send(encode(method, args));
    },
  };

  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ hello: { role: "window", window: readStoredWindowId() } }));
    });
    socket.addEventListener("error", () => reject(new Error(`Could not reach ${url}`)));
    socket.addEventListener("close", () => {
      for (const entry of pending.values()) {
        entry.reject(new Error("The test host closed the connection"));
      }
      pending.clear();
    });
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as WireMessage;
      if (message.hello) {
        if (message.hello.window !== null) storeWindowId(message.hello.window);
        bridge = createPiAppBridge(transport, {
          platform: message.hello.platform as NodeJS.Platform,
        });
        window.piApp = bridge.api;
        resolve();
        return;
      }
      if (message.push !== undefined) {
        bridge?.deliver(message.push, message.payload);
        return;
      }
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      try {
        entry.resolve(settleKernelAnswer(message));
      } catch (error) {
        entry.reject(error as Error);
      }
    });
  });
}
