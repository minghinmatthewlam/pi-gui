import {
  createRemoteServiceBinding,
  createRemoteServiceEndpoint,
  createServiceCatalogueCall,
  createServiceStateDecoder,
  createServiceStateEncoder,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  decodeServiceControlCall,
  isJsonValue,
  isRemoteServiceErrorCode,
  parseServiceCall,
  parseServiceCatalogue,
  parseServiceSubscriptionSnapshot,
  parseWireServiceProviderUpdate,
  parseWireServiceSubscriptionSnapshot,
  RemoteServiceError,
  type Context,
  type JsonValue,
  type RemoteServiceBinding,
  type RemoteServiceProvider,
  type RemoteServiceSource,
  type RemoteServiceTransport,
  type ServiceCall,
  type ServiceProviderUpdate,
  type ServiceStateDecoder,
  type ServiceStateEncoder,
  type WireServiceProviderUpdate,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

export type ChordWireMessage =
  | { readonly type: "request"; readonly requestId: string; readonly call: ServiceCall }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly ok: true;
      readonly value?: JsonValue;
    }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: { readonly message: string; readonly code?: string };
    }
  | {
      readonly type: "update";
      readonly subscriptionId: string;
      readonly update: WireServiceProviderUpdate;
    }
  | { readonly type: "cancel"; readonly requestId: string }
  | { readonly type: "closed"; readonly reason: string };

interface ConnectionOptions {
  /** Must deliver in order. Values are validated and detached before this callback. */
  readonly send: (message: ChordWireMessage) => void;
  readonly onError?: (error: Error) => void;
}

export interface ChordServerConnection {
  receive(message: unknown): Promise<void>;
  /** Ends this consumer's subscriptions; already accepted backend work keeps running. */
  close(reason?: string): void;
}

export interface ChordClientConnection {
  readonly services: RemoteServiceSource;
  readonly signal: AbortSignal;
  receive(message: unknown): void;
  close(reason?: string): void;
}

const MAX_MESSAGE_LENGTH = 2_000_000;
const MAX_PENDING = 256;
const MAX_BUFFERED_UPDATES = 256;

interface ServerSubscription {
  readonly encoder: ServiceStateEncoder;
  readonly buffered: ServiceProviderUpdate[];
  ready: boolean;
}

/** One isolated view provider, one connection, one Chord endpoint. */
export function createChordServerConnection(
  options: ConnectionOptions & { readonly provider: RemoteServiceProvider },
): ChordServerConnection {
  const endpoint = createRemoteServiceEndpoint(options.provider);
  const allowedServices = new Set(options.provider.catalogue.map((service) => service.serviceId));
  const subscriptions = new Map<string, ServerSubscription>();
  const requests = new Map<string, AbortController>();
  let closed = false;

  function send(message: ChordWireMessage): boolean {
    if (closed) return false;
    try {
      options.send(copyWireMessage(message));
      return true;
    } catch (error) {
      // The endpoint may already own a subscription even if its hydration
      // response cannot be sent. Dispose it instead of losing our bookkeeping.
      fail(error);
      return false;
    }
  }

  function close(reason = "Desktop view connection closed", notify = true): void {
    if (closed) return;
    closed = true;
    // Closing a tab releases its consumer, not the extension's work. Explicit
    // cancel messages may abort calls; host disposal owns backend teardown.
    requests.clear();
    subscriptions.clear();
    endpoint.dispose();
    if (notify) {
      try {
        options.send({ type: "closed", reason });
      } catch {
        /* The transport may already be gone. */
      }
    }
  }

  function fail(error: unknown): void {
    const failure = asError(error);
    close("Invalid or unavailable desktop service connection");
    options.onError?.(failure);
  }

  function publish(subscriptionId: string, update: ServiceProviderUpdate): void {
    if (closed) return;
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return;
    try {
      if (!subscription.ready) {
        if (subscription.buffered.length >= MAX_BUFFERED_UPDATES)
          throw new Error("Too many pending service updates");
        subscription.buffered.push(update);
      } else {
        send({ type: "update", subscriptionId, update: subscription.encoder.encodeUpdate(update) });
      }
    } catch (error) {
      fail(error);
    }
  }

  return {
    close,
    async receive(input) {
      if (closed) return;
      let message: ChordWireMessage;
      try {
        message = copyWireMessage(input);
        if (message.type === "closed") {
          close(message.reason, false);
          return;
        }
        if (message.type === "cancel") {
          requests.get(message.requestId)?.abort();
          return;
        }
        if (message.type !== "request") throw new TypeError("Expected a Chord request");
        if (requests.has(message.requestId) || requests.size >= MAX_PENDING)
          throw new TypeError("Duplicate or excessive Chord requests");
      } catch (error) {
        fail(error);
        return;
      }
      const { requestId, call } = message;
      const controller = new AbortController();
      requests.set(requestId, controller);
      const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      const control = decodeServiceControlCall(call);
      let createdSubscription = false;
      try {
        if (control?.type === "subscribe") {
          if (!allowedServices.has(control.serviceId))
            throw new RemoteServiceError(
              "service_not_allowed",
              "Service is not advertised by this view",
            );
          if (subscriptions.has(control.subscriptionId) || subscriptions.size >= MAX_PENDING)
            throw new Error("Duplicate or excessive Chord subscriptions");
          subscriptions.set(control.subscriptionId, {
            encoder: createServiceStateEncoder(),
            buffered: [],
            ready: false,
          });
          createdSubscription = true;
        } else if (!control && !allowedServices.has(call.serviceId)) {
          throw new RemoteServiceError(
            "service_not_allowed",
            "Service is not advertised by this view",
          );
        }

        let value = await endpoint.invoke(call, publish, context);
        if (closed) return;
        if (controller.signal.aborted) {
          if (control?.type === "subscribe") {
            await endpoint.invoke(
              createServiceUnsubscribeCall(control.subscriptionId),
              publish,
              BACKGROUND_CONTEXT,
            );
            subscriptions.delete(control.subscriptionId);
          }
          return;
        }
        if (control?.type === "subscribe") {
          const subscription = subscriptions.get(control.subscriptionId);
          if (!subscription) throw new Error("Service subscription was closed before hydration");
          // Endpoint activation precedes its return. Initialize this subscription's
          // dictionary and send hydration before encoding any buffered updates.
          try {
            value = strictJson(
              subscription.encoder.encodeSnapshot(parseServiceSubscriptionSnapshot(value)),
            );
          } catch (error) {
            fail(error);
            return;
          }
          if (!send({ type: "result", requestId, ok: true, value })) return;
          subscription.ready = true;
          for (const update of subscription.buffered.splice(0))
            publish(control.subscriptionId, update);
        } else {
          if (control?.type === "unsubscribe") subscriptions.delete(control.subscriptionId);
          send({
            type: "result",
            requestId,
            ok: true,
            ...(value === undefined ? {} : { value: strictJson(value) }),
          });
        }
      } catch (error) {
        if (createdSubscription && control?.type === "subscribe")
          subscriptions.delete(control.subscriptionId);
        if (!closed && !controller.signal.aborted) {
          try {
            const code = error instanceof RemoteServiceError ? error.code : undefined;
            send({
              type: "result",
              requestId,
              ok: false,
              error: { message: asError(error).message, ...(code ? { code } : {}) },
            });
          } catch (sendError) {
            fail(sendError);
          }
        }
      } finally {
        requests.delete(requestId);
      }
    },
  };
}

interface PendingRequest {
  resolve(value: JsonValue | undefined): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface ClientSubscription {
  readonly decoder: ServiceStateDecoder;
  readonly buffered: WireServiceProviderUpdate[];
  readonly listener: (update: ServiceProviderUpdate, context: Context) => void;
  active: boolean;
}

/** Browser-safe Chord source; caller owns the actual MessagePort/IPC route. */
export function createChordClientConnection(options: ConnectionOptions): ChordClientConnection {
  const controller = new AbortController();
  const pending = new Map<string, PendingRequest>();
  const subscriptions = new Map<string, ClientSubscription>();
  const bindings = new Set<RemoteServiceBinding>();
  let closed = false;
  let nextId = 0;

  function close(reason = "Desktop view connection closed", notify = true): void {
    if (closed) return;
    closed = true;
    const failure = new Error(reason);
    // A binding may be awaiting hydration: reject its request before disposing it.
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(failure);
    }
    pending.clear();
    subscriptions.clear();
    controller.abort(failure);
    if (notify) {
      try {
        options.send({ type: "closed", reason });
      } catch {
        /* The transport may already be gone. */
      }
    }
    for (const binding of bindings) binding.dispose(BACKGROUND_CONTEXT).catch(() => {});
    bindings.clear();
  }

  function fail(error: unknown): void {
    const failure = asError(error);
    close("Invalid or unavailable desktop service connection");
    options.onError?.(failure);
  }

  function request(call: ServiceCall, context: Context): Promise<JsonValue | undefined> {
    if (closed) return Promise.reject(new Error("Desktop view connection is closed"));
    if (context.abortSignal?.aborted)
      return Promise.reject(new Error("Desktop service request cancelled"));
    if (pending.size >= MAX_PENDING)
      return Promise.reject(new Error("Too many pending desktop service requests"));
    const requestId = `request-${++nextId}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(requestId);
        context.abortSignal?.removeEventListener("abort", abort);
        reject(new Error("Desktop service request cancelled"));
        try {
          options.send({ type: "cancel", requestId });
        } catch (error) {
          fail(error);
        }
      };
      pending.set(requestId, {
        resolve,
        reject,
        cleanup: () => context.abortSignal?.removeEventListener("abort", abort),
      });
      context.abortSignal?.addEventListener("abort", abort, { once: true });
      try {
        options.send(copyWireMessage({ type: "request", requestId, call }));
      } catch (error) {
        fail(error);
      }
    });
  }

  function deliver(subscription: ClientSubscription, update: WireServiceProviderUpdate): void {
    subscription.listener(subscription.decoder.decodeUpdate(update), BACKGROUND_CONTEXT);
  }

  const transport: RemoteServiceTransport = {
    invoke: request,
    async subscribe(serviceId, mode, listener, context) {
      const subscriptionId = `subscription-${++nextId}`;
      const subscription: ClientSubscription = {
        decoder: createServiceStateDecoder(),
        buffered: [],
        listener,
        active: false,
      };
      subscriptions.set(subscriptionId, subscription);
      try {
        const value = await request(
          createServiceSubscribeCall(subscriptionId, serviceId, mode),
          context,
        );
        let snapshot;
        try {
          snapshot = subscription.decoder.decodeSnapshot(
            parseWireServiceSubscriptionSnapshot(value),
          );
          if (snapshot.serviceId !== serviceId || snapshot.mode !== mode)
            throw new TypeError("Unexpected service subscription snapshot");
        } catch (error) {
          fail(error);
          throw error;
        }
        let disposed = false;
        return {
          snapshot,
          activate() {
            if (disposed || closed || subscription.active) return;
            subscription.active = true;
            try {
              for (const update of subscription.buffered.splice(0)) deliver(subscription, update);
            } catch (error) {
              fail(error);
              throw error;
            }
          },
          async close(closeContext = BACKGROUND_CONTEXT) {
            if (disposed) return;
            disposed = true;
            subscriptions.delete(subscriptionId);
            if (!closed) await request(createServiceUnsubscribeCall(subscriptionId), closeContext);
          },
        };
      } catch (error) {
        subscriptions.delete(subscriptionId);
        if (!closed)
          request(createServiceUnsubscribeCall(subscriptionId), BACKGROUND_CONTEXT).catch(() => {});
        // A malformed snapshot/codec cannot be safely resumed on this connection.
        if (error instanceof TypeError) fail(error);
        throw error;
      }
    },
  };

  const services: RemoteServiceSource = {
    acceptsUnavailableServices: false,
    async catalogue(context) {
      const value = await request(createServiceCatalogueCall(), context);
      try {
        return parseServiceCatalogue(value);
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    open(bindingOptions) {
      if (closed) throw new Error("Desktop view connection is closed");
      const binding = createRemoteServiceBinding({
        ...bindingOptions,
        transport,
        assertAccess() {
          if (closed) throw new Error("Desktop view connection is closed");
          bindingOptions.assertAccess();
        },
      });
      bindings.add(binding);
      return {
        use: (service) => binding.use(service),
        observe: (service, handler) => binding.observe(service, handler),
        ready: (context) => binding.ready(context),
        async dispose(context) {
          bindings.delete(binding);
          await binding.dispose(context);
        },
      };
    },
  };

  return {
    services,
    signal: controller.signal,
    close,
    receive(input) {
      if (closed) return;
      try {
        const message = copyWireMessage(input);
        if (message.type === "closed") {
          close(message.reason, false);
          return;
        }
        if (message.type === "result") {
          const entry = pending.get(message.requestId);
          if (!entry) return; // A cancelled request may already have completed remotely.
          pending.delete(message.requestId);
          entry.cleanup();
          if (message.ok) entry.resolve(message.value);
          else
            entry.reject(
              isRemoteServiceErrorCode(message.error.code)
                ? new RemoteServiceError(message.error.code, message.error.message)
                : new Error(message.error.message),
            );
          return;
        }
        if (message.type !== "update") throw new TypeError("Expected a Chord response or update");
        const subscription = subscriptions.get(message.subscriptionId);
        if (!subscription) return; // An unsubscribe can race an already queued update.
        if (subscription.active) deliver(subscription, message.update);
        else {
          if (subscription.buffered.length >= MAX_BUFFERED_UPDATES)
            throw new Error("Too many pending service updates");
          subscription.buffered.push(message.update);
        }
      } catch (error) {
        fail(error);
      }
    },
  };
}

/** Strict JSON validation precedes cloning, so serialization never silently drops values. */
function copyWireMessage(value: unknown): ChordWireMessage {
  strictJson(value);
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_MESSAGE_LENGTH)
    throw new TypeError("Desktop service message exceeds size limit");
  const copy: unknown = JSON.parse(encoded);
  if (!isRecord(copy)) throw new TypeError("Invalid desktop service envelope");
  switch (copy.type) {
    case "request":
      assertKeys(copy, ["type", "requestId", "call"]);
      return { type: "request", requestId: id(copy.requestId), call: parseServiceCall(copy.call) };
    case "result":
      if (copy.ok === true) {
        assertKeys(copy, ["type", "requestId", "ok"], ["value"]);
        return {
          type: "result",
          requestId: id(copy.requestId),
          ok: true,
          ...(Object.hasOwn(copy, "value") ? { value: strictJson(copy.value) } : {}),
        };
      }
      assertKeys(copy, ["type", "requestId", "ok", "error"]);
      if (copy.ok !== false || !isRecord(copy.error))
        throw new TypeError("Invalid desktop service error");
      assertKeys(copy.error, ["message"], ["code"]);
      if (
        typeof copy.error.message !== "string" ||
        (copy.error.code !== undefined && typeof copy.error.code !== "string")
      )
        throw new TypeError("Invalid desktop service error");
      return {
        type: "result",
        requestId: id(copy.requestId),
        ok: false,
        error: {
          message: copy.error.message,
          ...(typeof copy.error.code === "string" ? { code: copy.error.code } : {}),
        },
      };
    case "update":
      assertKeys(copy, ["type", "subscriptionId", "update"]);
      return {
        type: "update",
        subscriptionId: id(copy.subscriptionId),
        update: parseWireServiceProviderUpdate(copy.update),
      };
    case "cancel":
      assertKeys(copy, ["type", "requestId"]);
      return { type: "cancel", requestId: id(copy.requestId) };
    case "closed":
      assertKeys(copy, ["type", "reason"]);
      if (typeof copy.reason !== "string")
        throw new TypeError("Invalid desktop service close reason");
      return { type: "closed", reason: copy.reason };
    default:
      throw new TypeError("Unknown desktop service envelope");
  }
}

function strictJson(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new TypeError("Desktop service messages must contain strict JSON");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw new TypeError("Invalid desktop service request ID");
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError("Unexpected desktop service envelope fields");
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
