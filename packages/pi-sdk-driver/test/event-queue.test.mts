import test from "node:test";
import assert from "node:assert/strict";
import { chainRecoveringEventQueue, singleFlight } from "../dist/session-supervisor-utils.js";

await test("event queue keeps delivering after a work item throws", async () => {
  const delivered: string[] = [];
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);

  let queue: Promise<void> = Promise.resolve();
  queue = chainRecoveringEventQueue(
    queue,
    async () => {
      delivered.push("a");
    },
    onError,
  );
  queue = chainRecoveringEventQueue(
    queue,
    async () => {
      throw new Error("listener boom");
    },
    onError,
  );
  queue = chainRecoveringEventQueue(
    queue,
    async () => {
      delivered.push("c");
    },
    onError,
  );

  await queue;

  // The throwing item must not freeze the chain: "c" still runs, and the queue
  // tail resolves (never a rejected promise that would drop all future events).
  assert.deepEqual(delivered, ["a", "c"]);
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /boom/);
});

await test("singleFlight runs the factory once for concurrent callers and yields one result", async () => {
  const inFlight = new Map<string, Promise<{ id: number }>>();
  let created = 0;
  const factory = async () => {
    created += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { id: created };
  };

  const [a, b, c] = await Promise.all([
    singleFlight(inFlight, "session-1", factory),
    singleFlight(inFlight, "session-1", factory),
    singleFlight(inFlight, "session-1", factory),
  ]);

  assert.equal(created, 1, "factory (runtime creation) must run exactly once");
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(inFlight.size, 0, "settled key is cleared for the next call");
});

await test("singleFlight clears the entry on failure and lets the next call retry", async () => {
  const inFlight = new Map<string, Promise<number>>();
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("first attempt fails");
    }
    return attempts;
  };

  await assert.rejects(singleFlight(inFlight, "k", flaky), /first attempt fails/);
  assert.equal(inFlight.size, 0);
  const result = await singleFlight(inFlight, "k", flaky);
  assert.equal(result, 2);
});

await test("distinct keys run their own factory concurrently", async () => {
  const inFlight = new Map<string, Promise<string>>();
  const a = await singleFlight(inFlight, "a", async () => "ra");
  const b = await singleFlight(inFlight, "b", async () => "rb");
  assert.equal(a, "ra");
  assert.equal(b, "rb");
});
