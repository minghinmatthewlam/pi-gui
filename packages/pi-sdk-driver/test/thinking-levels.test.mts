import test from "node:test";
import assert from "node:assert/strict";
import { supportedThinkingLevels } from "../dist/thinking-levels.js";

await test("non-reasoning models expose only off", () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(supportedThinkingLevels({}), ["off"]);
});

await test("contributor-style maps drop max (clamp parity)", () => {
  assert.deepEqual(
    supportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
});

await test("full maps keep max", () => {
  assert.deepEqual(
    supportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    }),
    ["minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

await test("xhigh and max require a defined mapping", () => {
  const levels = supportedThinkingLevels({ reasoning: true });
  assert.ok(!levels.includes("xhigh"));
  assert.ok(!levels.includes("max"));
  assert.ok(levels.includes("high"));
});
