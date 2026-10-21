import { expect, test } from "@playwright/test";
import type { RuntimeModelRecord } from "@pi-gui/session-driver/runtime-types";
import { modelMatchesPattern } from "../../src/features/settings/model-settings";

const model = (providerId: string, modelId: string): RuntimeModelRecord => ({
  providerId,
  providerName: providerId,
  modelId,
  label: modelId,
  available: true,
  authType: "api_key",
  reasoning: false,
  supportsImages: false,
});

test("enabled model patterns match like pi's model scope, globs included", () => {
  const nested = model("openrouter", "z-ai/glm-5.3");
  expect(modelMatchesPattern(nested, "openrouter/z-ai/glm-5.3")).toBe(true);
  expect(modelMatchesPattern(nested, "openrouter/**")).toBe(true);
  expect(modelMatchesPattern(nested, "openrouter/*")).toBe(false);
  expect(modelMatchesPattern(model("zai", "glm-5.3"), "*glm*")).toBe(true);
  expect(modelMatchesPattern(nested, "OpenRouter/**:high")).toBe(true);
  expect(modelMatchesPattern(nested, "anthropic/**")).toBe(false);
  expect(modelMatchesPattern(model("cursor", "grok-4.7@1m:fast"), "cursor/grok-4.7@*")).toBe(true);
  expect(modelMatchesPattern(model("cursor", "grok-4.7"), "cursor/grok")).toBe(false);
});

test("a glob reused across models keeps matching each one on its own", () => {
  const pattern = "openrouter/z-ai/*:high";
  expect(modelMatchesPattern(model("openrouter", "z-ai/glm-5.3"), pattern)).toBe(true);
  expect(modelMatchesPattern(model("openrouter", "qwen/qwen-4"), pattern)).toBe(false);
  expect(modelMatchesPattern(model("OPENROUTER", "Z-AI/GLM-5.4"), pattern)).toBe(true);
  expect(modelMatchesPattern(model("anthropic", "z-ai/glm-5.3"), pattern)).toBe(false);
});
