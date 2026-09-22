import assert from "node:assert/strict";
import test from "node:test";

test("intentional failure demonstrates a nonzero command exit", () => {
  assert.equal(2 + 3, 6, "This fixture is expected to fail.");
});
