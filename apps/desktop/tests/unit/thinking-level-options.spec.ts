import { expect, test } from "@playwright/test";
import { filterThinkingOptionsForModelLevels } from "../../src/features/conversation/composer-commands";

test("contributor-style levels hide Max instead of letting it clamp", () => {
  const options = filterThinkingOptionsForModelLevels([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  const values = options.map((option) => option.value);
  expect(values).not.toContain("max");
  expect(values).toEqual(["low", "medium", "high", "xhigh"]);
});

test("full levels keep Max", () => {
  const values = filterThinkingOptionsForModelLevels([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]).map((option) => option.value);
  expect(values).toContain("max");
});

test("unknown model falls back to the full list", () => {
  expect(filterThinkingOptionsForModelLevels(undefined).map((o) => o.value)).toContain("max");
  expect(filterThinkingOptionsForModelLevels([]).map((o) => o.value)).toContain("max");
});
