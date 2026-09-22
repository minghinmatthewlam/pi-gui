import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { ENTRY_TYPE, OUTPUT_LIMIT, type RunRecord, type Suite } from "../contract.ts";
import { TestRunOwner } from "../run-owner.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (fixture: string) =>
  `node --test --test-reporter=tap ${quote(fileURLToPath(new URL(`../fixtures/${fixture}.test.mjs`, import.meta.url)))}`;
const suites: Suite[] = [
  { id: "passing", label: "Passing", command: command("passing"), timeoutSeconds: 10 },
  { id: "failing", label: "Failing", command: command("failing"), timeoutSeconds: 10 },
  { id: "slow", label: "Slow", command: command("slow"), timeoutSeconds: 10 },
  { id: "timeout", label: "Timeout", command: command("slow"), timeoutSeconds: 0.5 },
];

function realOperations(): BashOperations {
  const operations = createLocalBashOperations();
  // The child is an independent node:test invocation, not this runner's worker.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { exec: (command, cwd, options) => operations.exec(command, cwd, { ...options, env }) };
}

function setup(operations = realOperations(), configured = suites) {
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const owner = new TestRunOwner(configured, operations, (customType, data) => {
    entries.push({ type: "custom", customType, data });
  });
  owner.restore(cwd, []);
  return { owner, entries };
}

async function waitForOutput(owner: TestRunOwner, runId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (
    !owner
      .snapshot()
      .runs.find((run) => run.id === runId)
      ?.output.includes("Slow test started")
  ) {
    if (Date.now() > deadline) throw new Error("Slow fixture did not publish live output.");
    await setTimeout(20);
  }
}

await test("real passing and failing commands preserve their distinct exits and raw output", async () => {
  const { owner, entries } = setup();
  const pass = await owner.wait(owner.start({ suiteId: "passing", requestId: "pass" }).runId);
  assert.deepEqual(pass.outcome, { kind: "completed", exitCode: 0 });
  assert.match(pass.output, /adds two numbers/);
  const fail = await owner.wait(owner.start({ suiteId: "failing", requestId: "fail" }).runId);
  assert.equal(fail.outcome.kind, "completed");
  if (fail.outcome.kind === "completed") assert.notEqual(fail.outcome.exitCode, 0);
  assert.match(fail.output, /This fixture is expected to fail/);
  assert.equal(entries.length, 4);
  assert.equal((entries[0]!.data as { run: RunRecord }).run.outcome.kind, "running");
  assert.ok(pass.endedAt);
  assert.ok(fail.endedAt);
});

await test("Stop cancels a real running process after live output and saves cancellation", async () => {
  const { owner, entries } = setup();
  const { runId } = owner.start({ suiteId: "slow", requestId: "stop" });
  try {
    await waitForOutput(owner, runId);
    await owner.cancel({ runId });
    const run = await owner.wait(runId);
    assert.equal(run.outcome.kind, "cancelled");
    assert.match(run.output, /Slow test started/);
    assert.equal((entries.at(-1)!.data as { run: RunRecord }).run.outcome.kind, "cancelled");
    assert.equal(owner.snapshot().ready, true);
  } finally {
    await owner.suspend();
  }
});

await test("tool abort and configured timeout remain distinct outcomes", async () => {
  const { owner } = setup();
  const controller = new AbortController();
  const { runId } = owner.start({ suiteId: "slow", requestId: "abort" }, controller.signal);
  try {
    await waitForOutput(owner, runId);
    controller.abort();
    assert.equal((await owner.wait(runId)).outcome.kind, "cancelled");
    const timeout = await owner.wait(
      owner.start({ suiteId: "timeout", requestId: "timeout" }).runId,
    );
    assert.equal(timeout.outcome.kind, "timedOut");
  } finally {
    await owner.suspend();
  }
});

await test("closing a subscriber does not cancel a run; runtime suspension does", async () => {
  const { owner } = setup();
  const { runId } = owner.start({ suiteId: "slow", requestId: "close" });
  try {
    const unsubscribe = owner.subscribe(() => {});
    unsubscribe();
    await waitForOutput(owner, runId);
    assert.equal(owner.snapshot().runs[0]!.outcome.kind, "running");
    await owner.suspend();
    assert.equal((await owner.wait(runId)).outcome.kind, "cancelled");
    assert.equal(owner.snapshot().ready, false);
    assert.throws(() => owner.start({ suiteId: "passing", requestId: "stale" }), /unavailable/);
  } finally {
    await owner.suspend();
  }
});

await test("request dedupe and the busy guard prevent duplicate process execution", async () => {
  let executions = 0;
  let resolve: (result: { exitCode: number }) => void = () => {};
  const operations: BashOperations = {
    exec: () => {
      executions += 1;
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const { owner } = setup(operations);
  const request = { suiteId: "passing", requestId: "once" };
  const first = owner.start(request);
  assert.deepEqual(owner.start(request), first);
  assert.throws(() => owner.start({ suiteId: "passing", requestId: "other" }), /already active/);
  assert.throws(() => owner.start({ suiteId: "failing", requestId: "once" }), /another suite/);
  assert.throws(
    () => owner.start({ suiteId: "shell-injection", requestId: "unknown" }),
    /Unknown test suite/,
  );
  await Promise.resolve();
  resolve({ exitCode: 0 });
  await owner.wait(first.runId);
  assert.deepEqual(owner.start(request), first);
  assert.equal(executions, 1);
});

await test("restore selects branch records and marks unfinished work interrupted without rerunning", async () => {
  const { owner, entries } = setup();
  const { runId } = owner.start({ suiteId: "passing", requestId: "restore" });
  const startedEntry = structuredClone(entries[0]!);
  await owner.wait(runId);
  const restored = new TestRunOwner(
    suites,
    {
      exec: () => {
        throw new Error("Must not rerun.");
      },
    },
    () => {},
  );
  restored.restore(cwd, [startedEntry]);
  assert.equal(restored.snapshot().runs[0]!.outcome.kind, "interrupted");
  assert.deepEqual(restored.start({ suiteId: "passing", requestId: "restore" }), { runId });
  restored.restore(cwd, entries);
  assert.deepEqual(restored.snapshot().runs[0]!.outcome, { kind: "completed", exitCode: 0 });
  restored.restore(cwd, []);
  assert.deepEqual(restored.snapshot().runs, []);
  restored.restore(cwd, [{ type: "custom", customType: ENTRY_TYPE, data: { version: 100 } }]);
  assert.match(restored.snapshot().error ?? "", /could not be read/);
});

await test("output truncation is explicit and a null exit is never success", async () => {
  const bytes = Buffer.from("α".repeat(OUTPUT_LIMIT));
  const { owner } = setup({
    exec: async (_command, _cwd, options) => {
      options.onData(bytes.subarray(0, 15));
      options.onData(bytes.subarray(15));
      return { exitCode: null };
    },
  });
  const run = await owner.wait(owner.start({ suiteId: "passing", requestId: "output" }).runId);
  assert.equal(run.outcome.kind, "executionError");
  assert.equal(run.truncated, true);
  assert.equal(run.outputBytes, bytes.length);
  assert.ok(Buffer.byteLength(run.output) <= OUTPUT_LIMIT);
  assert.ok(!run.output.includes("�"));
});

await test("pre-aborted requests and failed initial persistence never launch work", () => {
  let launched = false;
  const operations: BashOperations = {
    exec: async () => {
      launched = true;
      return { exitCode: 0 };
    },
  };
  const { owner, entries } = setup(operations);
  assert.throws(() =>
    owner.start({ suiteId: "passing", requestId: "aborted" }, AbortSignal.abort()),
  );
  assert.equal(entries.length, 0);
  const broken = new TestRunOwner(suites, operations, () => {
    throw new Error("disk full");
  });
  broken.restore(cwd, []);
  assert.throws(() => broken.start({ suiteId: "passing", requestId: "disk" }), /disk full/);
  assert.equal(launched, false);
});

await test("a failed final save is visible without changing the actual command result", async () => {
  let writes = 0;
  const owner = new TestRunOwner(suites, { exec: async () => ({ exitCode: 0 }) }, () => {
    writes += 1;
    if (writes === 2) throw new Error("disk full");
  });
  owner.restore(cwd, []);
  const run = await owner.wait(owner.start({ suiteId: "passing", requestId: "save" }).runId);
  assert.deepEqual(run.outcome, { kind: "completed", exitCode: 0 });
  assert.match(owner.snapshot().error ?? "", /Result could not be saved.*disk full/);
});

await test("stopping for tree navigation does not require a success event to accept later runs", async () => {
  const { owner } = setup();
  const { runId } = owner.start({ suiteId: "slow", requestId: "tree" });
  await owner.stopActive();
  assert.equal((await owner.wait(runId)).outcome.kind, "cancelled");
  assert.equal(owner.snapshot().ready, true);
  const next = await owner.wait(
    owner.start({ suiteId: "passing", requestId: "after-tree-cancel" }).runId,
  );
  assert.deepEqual(next.outcome, { kind: "completed", exitCode: 0 });
});

await test("a throwing subscriber cannot prevent a run from settling and persisting", async () => {
  const { owner, entries } = setup({ exec: async () => ({ exitCode: 7 }) });
  let calls = 0;
  owner.subscribe(() => {
    calls += 1;
    if (calls > 1) throw new Error("View disconnected.");
  });
  const run = await owner.wait(owner.start({ suiteId: "passing", requestId: "listener" }).runId);
  assert.deepEqual(run.outcome, { kind: "completed", exitCode: 7 });
  assert.equal(entries.length, 2);
});
