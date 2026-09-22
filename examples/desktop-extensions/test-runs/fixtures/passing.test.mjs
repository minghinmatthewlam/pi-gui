import assert from "node:assert/strict";
import test from "node:test";

test("adds two numbers", () => {
  assert.equal(2 + 3, 5);
});

test("preserves the original list", () => {
  const values = [3, 1, 2];
  assert.deepEqual(values.toSorted(), [1, 2, 3]);
  assert.deepEqual(values, [3, 1, 2]);
});
