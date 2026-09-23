import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

// This file runs in a grandchild of the run's shell, which the example's own
// test cannot wait for. The kernel closes this connection when the file exits.
const exitProbe = process.env.PI_TEST_RUNS_EXIT_PROBE;
if (exitProbe) connect(exitProbe).unref();

test("waits long enough to exercise Stop and timeout", async () => {
  console.log("Slow test started. Stop this run or wait for completion.");
  console.log(`Slow test PID: ${process.pid}`);
  await setTimeout(8_000);
  assert.ok(true);
});
