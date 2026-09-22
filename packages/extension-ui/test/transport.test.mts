import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import {
  createFacetHost,
  defineFacet,
  defineService,
  decodeServiceControlCall,
  type Context,
  type FacetHost,
  type MutableReplicatedState,
  type ReplicatedState,
  type RemoteServiceSource,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  createChordClientConnection,
  createChordServerConnection,
  type ChordClientConnection,
  type ChordWireMessage,
} from "../dist/transport.js";

interface Counter {
  readonly state: ReplicatedState<{ count: number; labels: string[] }>;
  increment(label: string, context: Context): Promise<number>;
  wait(context: Context): Promise<void>;
}
const CounterService = defineService<Counter>("test.counter");

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function backend() {
  let state!: MutableReplicatedState<{ count: number; labels: string[] }>;
  let cancelled = false;
  const host = await createFacetHost({
    facets: [
      defineFacet({
        id: "counter-backend",
        setup(env) {
          state = env.replicatedState({ count: 0, labels: [] as string[] });
          env.provide(CounterService, {
            state,
            async increment(label, context) {
              state.change(context, (draft) => {
                draft.count += 1;
                draft.labels.push(label);
              });
              return state.value.count;
            },
            async wait(context) {
              await new Promise<void>((resolve) => {
                const finish = () => {
                  cancelled = true;
                  resolve();
                };
                if (context.abortSignal?.aborted) finish();
                else context.abortSignal?.addEventListener("abort", finish, { once: true });
              });
            },
          });
        },
      }),
    ],
  });
  return { host, state, cancelled: () => cancelled };
}

function connect(
  host: FacetHost,
  options: {
    afterRequest?: (message: ChordWireMessage) => void;
    clientFactory?: typeof createChordClientConnection;
    transformResponse?: (message: ChordWireMessage) => unknown;
  } = {},
) {
  const errors: Error[] = [];
  const messages: ChordWireMessage[] = [];
  let client!: ChordClientConnection;
  const server = createChordServerConnection({
    provider: host.services,
    send(message) {
      messages.push(message);
      client.receive(options.transformResponse ? options.transformResponse(message) : message);
    },
    onError(error) {
      errors.push(error);
    },
  });
  client = (options.clientFactory ?? createChordClientConnection)({
    send(message) {
      server.receive(message).catch((error: unknown) => {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      });
      options.afterRequest?.(message);
    },
    onError(error) {
      errors.push(error);
    },
  });
  return { client, server, errors, messages };
}

function acquire(client: ChordClientConnection) {
  const binding = client.services.open({
    services: [CounterService],
    assertAccess() {},
    onError() {},
  });
  const counter = binding.use(CounterService);
  return { binding, counter };
}

await test("buffers updates before the snapshot response and before consumer activation", async (t) => {
  const fixture = await backend();
  let edited = false;
  const wire = connect(fixture.host, {
    afterRequest(message) {
      if (
        !edited &&
        message.type === "request" &&
        decodeServiceControlCall(message.call)?.type === "subscribe"
      ) {
        edited = true;
        fixture.state.change(BACKGROUND_CONTEXT, (draft) => {
          draft.count = 1;
          draft.labels.push("during-subscribe");
        });
      }
    },
  });
  t.after(async () => {
    wire.client.close();
    await fixture.host.dispose();
  });
  const { binding, counter } = acquire(wire.client);
  await binding.ready(BACKGROUND_CONTEXT);
  assert.deepEqual(counter.state.value, { count: 1, labels: ["during-subscribe"] });
  const initial = counter.state.value;
  assert.equal(await counter.increment("after-hydration", BACKGROUND_CONTEXT), 2);
  assert.deepEqual(counter.state.value, {
    count: 2,
    labels: ["during-subscribe", "after-hydration"],
  });
  assert.deepEqual(initial, { count: 1, labels: ["during-subscribe"] });
  assert.deepEqual(wire.errors, []);
  await binding.dispose(BACKGROUND_CONTEXT);
  assert.throws(() => counter.increment("stale", BACKGROUND_CONTEXT), /disposed/);
});

await test("cancellation reaches backend methods and closing one connection preserves the provider", async (t) => {
  const fixture = await backend();
  const wire = connect(fixture.host);
  t.after(async () => {
    wire.client.close();
    await fixture.host.dispose();
  });
  const { binding, counter } = acquire(wire.client);
  await binding.ready(BACKGROUND_CONTEXT);
  const abort = new AbortController();
  const pending = counter.wait(withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
  abort.abort();
  await assert.rejects(pending, /cancel/i);
  assert.equal(fixture.cancelled(), true);
  wire.client.close();
  assert.equal(wire.client.signal.aborted, true);
  const second = connect(fixture.host);
  const next = acquire(second.client);
  await next.binding.ready(BACKGROUND_CONTEXT);
  assert.equal(await next.counter.increment("new-view", BACKGROUND_CONTEXT), 1);
  second.client.close();
});

await test("disconnect rejects an unfinished hydration before disposing its binding", async () => {
  const messages: ChordWireMessage[] = [];
  const client = createChordClientConnection({
    send(message) {
      messages.push(message);
    },
  });
  const { binding } = acquire(client);
  const ready = binding.ready(BACKGROUND_CONTEXT);
  client.close("mount removed");
  await assert.rejects(ready, /mount removed|closed|disposed/);
  await binding.dispose(BACKGROUND_CONTEXT);
  assert.equal(client.signal.aborted, true);
  assert.equal(messages.at(-1)?.type, "closed");
});

await test("closing a tab rejects its waiter without cancelling accepted backend work", async (t) => {
  const started = gate();
  const finish = gate();
  const finished = gate();
  let cancelled = false;
  let committed = false;
  const Work = defineService<{ run(context: Context): Promise<void> }>("test.background-work");
  const host = await createFacetHost({
    facets: [
      defineFacet({
        id: "background-work",
        setup(env) {
          env.provide(Work, {
            async run(context) {
              started.release();
              await finish.promise;
              cancelled = context.abortSignal?.aborted ?? false;
              committed = true;
              finished.release();
            },
          });
        },
      }),
    ],
  });
  t.after(async () => {
    finish.release();
    await host.dispose();
  });
  const wire = connect(host);
  const binding = wire.client.services.open({ services: [Work], assertAccess() {}, onError() {} });
  const work = binding.use(Work);
  await binding.ready(BACKGROUND_CONTEXT);
  const waiting = work.run(BACKGROUND_CONTEXT);
  await started.promise;
  wire.client.close("tab closed");
  await assert.rejects(waiting, /tab closed/);
  finish.release();
  await finished.promise;
  assert.equal(cancelled, false);
  assert.equal(committed, true);
  assert.deepEqual(wire.errors, []);
});

await test("invalid JSON requests fail closed and malformed codec snapshots abort the client", async (t) => {
  const fixture = await backend();
  t.after(async () => {
    await fixture.host.dispose();
  });
  const wire = connect(fixture.host);
  await wire.server.receive({
    type: "request",
    requestId: "bad",
    call: { serviceId: CounterService.id, member: "increment", args: [undefined] },
  });
  assert.equal(wire.client.signal.aborted, true);
  assert.equal(fixture.state.value.count, 0);
  assert.match(wire.errors[0]!.message, /strict JSON/);

  const corrupt = connect(fixture.host, {
    transformResponse(message) {
      if (
        message.type === "result" &&
        message.ok &&
        message.value &&
        typeof message.value === "object" &&
        "instances" in message.value
      ) {
        return {
          ...message,
          value: {
            serviceId: CounterService.id,
            mode: "singleton",
            instances: [
              { members: [{ kind: "state", name: "state", sequence: 0, ops: [["not-an-op"]] }] },
            ],
          },
        };
      }
      return message;
    },
  });
  const { binding } = acquire(corrupt.client);
  await assert.rejects(binding.ready(BACKGROUND_CONTEXT));
  assert.equal(corrupt.client.signal.aborted, true);
  await binding.dispose(BACKGROUND_CONTEXT);
});

await test("oversized hydration closes the underlying endpoint subscription", async (t) => {
  const Large = defineService<{ readonly state: ReplicatedState<{ text: string }> }>(
    "test.large-state",
  );
  const host = await createFacetHost({
    facets: [
      defineFacet({
        id: "large-state-backend",
        setup(env) {
          env.provide(Large, { state: env.replicatedState({ text: "x".repeat(2_000_100) }) });
        },
      }),
    ],
  });
  t.after(async () => {
    await host.dispose();
  });
  let activeSubscriptions = 0;
  const subscribe = host.services.subscribe.bind(host.services);
  t.mock.method(host.services, "subscribe", (...args: Parameters<typeof subscribe>) => {
    const subscription = subscribe(...args);
    activeSubscriptions += 1;
    let closed = false;
    return {
      ...subscription,
      close(context?: Context) {
        if (!closed) {
          activeSubscriptions -= 1;
          closed = true;
        }
        return subscription.close(context);
      },
    };
  });
  const wire = connect(host);
  const binding = wire.client.services.open({ services: [Large], assertAccess() {}, onError() {} });
  binding.use(Large);
  await assert.rejects(binding.ready(BACKGROUND_CONTEXT));
  assert.equal(wire.client.signal.aborted, true);
  assert.equal(activeSubscriptions, 0, "failed hydration must release the real Chord subscription");
  assert.match(wire.errors[0]!.message, /size limit/);
  await binding.dispose(BACKGROUND_CONTEXT);
});

await test("a separately bundled author frontend consumes the independently bundled frame bridge", async (t) => {
  const frame = await import("../dist/frame-bridge.js");
  const fixture = await backend();
  const wire = connect(fixture.host, { clientFactory: frame.createChordClientConnection });
  t.after(async () => {
    wire.client.close();
    await fixture.host.dispose();
  });
  const bundle = await build({
    stdin: {
      contents: `
        import { createFacetHost, defineFacet, defineService } from '@earendil-works/chord';
        import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
        export async function run(source) {
          let counter;
          const deliveries = [];
          const service = defineService('test.counter');
          const host = await createFacetHost({serviceSources:[source],facets:[defineFacet({
            id:'separate-author', setup(env) {
              counter=env.use(service);
              env.onActivate(()=>env.own(counter.state.subscribe(value=>deliveries.push(value.count))));
            }
          })]});
          await counter.increment('separate-bundle',BACKGROUND_CONTEXT);
          const value=counter.state.value;
          await host.dispose();
          return {value,deliveries};
        }`,
      resolveDir: process.cwd(),
      sourcefile: "author-frontend.js",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
  });
  // This locally generated module is deliberately a second copy of Chord.
  const author = (await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
  )) as {
    run(
      source: RemoteServiceSource,
    ): Promise<{ value: { count: number; labels: string[] }; deliveries: number[] }>;
  };
  const result = await author.run(wire.client.services);
  assert.deepEqual(result, {
    value: { count: 1, labels: ["separate-bundle"] },
    deliveries: [0, 1],
  });
  assert.deepEqual(wire.errors, []);
});
