import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

test("waits long enough to exercise Stop and timeout", async () => {
  console.log("Slow test started. Stop this run or wait for completion.");
  console.log(`Slow test PID: ${process.pid}`);
  await setTimeout(8_000);
  assert.ok(true);
});
