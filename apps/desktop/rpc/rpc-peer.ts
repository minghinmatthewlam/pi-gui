/**
 * A two-way JSON-RPC peer over newline-delimited JSON. Both sides can call each other with
 * many calls in flight; notifications are delivered in the order they were sent, and a
 * request's handler starts in arrival order, so a notification sent before a request is
 * always seen first.
 *
 * Used between the app and its two child processes, the pi host and the Rust core
 * (`crates/pi-gui-core/src/rpc.rs` speaks the same format).
 */

export interface RpcTransport {
  /** Writes one complete message (no trailing newline). */
  send(line: string): void;
  close(): void;
}

export interface RpcRequestContext {
  /** Aborted when the caller cancels or the connection closes. */
  readonly signal: AbortSignal;
}

export type RpcHandler = (params: unknown, context: RpcRequestContext) => unknown;

/** Serialized error. Own enumerable properties such as `code` survive the trip in `data`. */
interface WireError {
  readonly name: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

type WireMessage =
  | { readonly id: number; readonly method: string; readonly params?: unknown }
  | { readonly method: string; readonly params?: unknown }
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: WireError };

const CANCEL_METHOD = "$/cancel";

/** An error thrown on the other side, with its name, message and own fields kept. */
export class RpcRemoteError extends Error {
  constructor(wire: WireError) {
    super(wire.message);
    this.name = wire.name;
    if (wire.data) Object.assign(this, wire.data);
  }
}

export class RpcConnectionClosedError extends Error {
  constructor(label: string, reason: string) {
    super(`${label} connection closed: ${reason}`);
    this.name = "RpcConnectionClosedError";
  }
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

export interface RpcPeerOptions {
  readonly transport: RpcTransport;
  readonly onDiagnostic?: (message: string) => void;
  /** Names the other side in errors, such as "pi host connection closed". */
  readonly label?: string;
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly running = new Map<number, AbortController>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private closedReason: string | undefined;
  private buffered: string[] = [];

  constructor(private readonly options: RpcPeerOptions) {}

  private get label(): string {
    return this.options.label ?? "pi host";
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  handle(method: string, handler: RpcHandler): void {
    if (this.handlers.has(method)) throw new Error(`Duplicate RPC handler: ${method}`);
    this.handlers.set(method, handler);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    if (this.notificationHandlers.has(method)) {
      throw new Error(`Duplicate RPC notification handler: ${method}`);
    }
    this.notificationHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new RpcConnectionClosedError(this.label, this.closedReason));
    }
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.write({ method: CANCEL_METHOD, params: { id } });
        reject(signal?.reason ?? abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason !== undefined) return;
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Feeds raw bytes read from the other side. Partial lines are buffered. */
  receiveChunk(chunk: string): void {
    // Only the new chunk is searched, so a large reply arriving in many chunks stays linear.
    let start = 0;
    let newline = chunk.indexOf("\n");
    while (newline >= 0) {
      const line = (this.buffered.join("") + chunk.slice(start, newline)).trim();
      this.buffered = [];
      if (line) this.receiveLine(line);
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) this.buffered.push(chunk.slice(start));
  }

  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    const error = new RpcConnectionClosedError(this.label, reason);
    for (const call of this.pending.values()) {
      call.cleanup();
      call.reject(error);
    }
    this.pending.clear();
    for (const controller of this.running.values()) controller.abort(error);
    this.running.clear();
    this.options.transport.close();
  }

  private receiveLine(line: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(line) as WireMessage;
    } catch {
      // Stray output from a library writing to our stream; never fatal.
      this.options.onDiagnostic?.(`Ignored non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message !== "object" || message === null) return;
    if ("method" in message) {
      if ("id" in message) this.startRequest(message.id, message.method, message.params);
      else this.receiveNotification(message.method, message.params);
      return;
    }
    if (!("id" in message)) return;
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    call.cleanup();
    if ("error" in message) call.reject(new RpcRemoteError(message.error));
    else call.resolve(message.result);
  }

  private receiveNotification(method: string, params: unknown): void {
    if (method === CANCEL_METHOD) {
      const id = (params as { id?: unknown } | undefined)?.id;
      if (typeof id === "number") this.running.get(id)?.abort(abortError());
      return;
    }
    const handler = this.notificationHandlers.get(method);
    if (!handler) {
      this.options.onDiagnostic?.(`No handler for notification ${method}`);
      return;
    }
    try {
      handler(params);
    } catch (error) {
      this.options.onDiagnostic?.(`Notification ${method} failed: ${messageOf(error)}`);
    }
  }

  private startRequest(id: number, method: string, params: unknown): void {
    const handler = this.handlers.get(method);
    if (!handler) {
      this.write({ id, error: { name: "Error", message: `Unknown RPC method: ${method}` } });
      return;
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    let result: unknown;
    try {
      result = handler(params, { signal: controller.signal });
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result).then(
      (value) => {
        if (!this.running.delete(id)) return;
        this.write({ id, result: value === undefined ? null : value });
      },
      (error: unknown) => {
        if (!this.running.delete(id)) return;
        this.write({ id, error: toWireError(error) });
      },
    );
  }

  private write(message: WireMessage): void {
    if (this.closedReason !== undefined) return;
    let line: string;
    try {
      line = JSON.stringify(message, wireValue);
    } catch (error) {
      // A cycle in an extension's data. Replies still settle; other messages drop the cycle.
      if ("id" in message && ("result" in message || "error" in message)) {
        line = JSON.stringify({ id: message.id, error: toWireError(error) });
      } else {
        line = JSON.stringify(message, acyclicWireValue());
      }
    }
    this.options.transport.send(line);
  }
}

/** Keeps values JSON would lose or reject: errors as their name and message, big integers as text. */
function wireValue(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function acyclicWireValue(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function (this: unknown, key: string, value: unknown) {
    const wire = wireValue(key, value);
    if (typeof wire !== "object" || wire === null) return wire;
    if (seen.has(wire)) return "[Circular]";
    seen.add(wire);
    return wire;
  };
}

function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    try {
      data[key] = JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      // Not serializable; drop the field rather than fail the reply.
    }
  }
  return {
    name: error.name,
    message: error.message,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
