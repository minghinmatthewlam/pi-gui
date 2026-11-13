import { expect, test } from "@playwright/test";
import type {
  RuntimeModelRecord,
  RuntimeSnapshot,
  RuntimeThinkingLevel,
} from "@pi-gui/session-driver/runtime-types";
import { buildThinkingOptions } from "../../src/features/conversation/composer-commands";

function model(
  modelId: string,
  thinkingLevels?: readonly RuntimeThinkingLevel[],
): RuntimeModelRecord {
  return {
    providerId: "opencode-go",
    providerName: "opencode-go",
    modelId,
    label: modelId,
    available: true,
    authType: "api_key",
    reasoning: true,
    supportsImages: false,
    ...(thinkingLevels ? { thinkingLevels } : {}),
    scope: "all",
  };
}

function runtime(models: readonly RuntimeModelRecord[]): RuntimeSnapshot {
  return {
    workspace: { workspaceId: "thinking-options", path: "/thinking-options" },
    providers: [],
    models,
    skills: [],
    extensions: [],
    settings: { enableSkillCommands: true, enabledModelPatterns: [] },
  };
}

function values(snapshot: RuntimeSnapshot | undefined, modelId: string): readonly string[] {
  return buildThinkingOptions(snapshot, {
    provider: "opencode-go",
    modelId,
  }).map((option) => option.value);
}

test("thinking options list only the levels the model maps", () => {
  // DeepSeek V4.1 Flash maps low/high/max; pi resolves that to exactly those levels.
  const snapshot = runtime([model("deepseek-v4.1-flash", ["low", "high", "max"])]);

  expect(values(snapshot, "deepseek-v4.1-flash")).toEqual(["low", "high", "max"]);
  expect(
    buildThinkingOptions(snapshot, { provider: "opencode-go", modelId: "deepseek-v4.1-flash" }).map(
      (option) => option.label,
    ),
  ).toEqual(["Low", "High", "Max"]);
});

test("thinking options keep pi's strength order", () => {
  const snapshot = runtime([model("scrambled", ["max", "off", "low"])]);

  expect(values(snapshot, "scrambled")).toEqual(["off", "low", "max"]);
});

test("a model that does not reason only offers off", () => {
  const snapshot = runtime([model("plain", ["off"])]);

  expect(values(snapshot, "plain")).toEqual(["off"]);
});

test("thinking options fall back to every standard level when the runtime is silent", () => {
  const legacy = runtime([model("legacy")]);

  expect(values(legacy, "legacy")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(values(undefined, "legacy")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(values(legacy, "unknown-model")).toEqual(["low", "medium", "high", "xhigh", "max"]);
});
