import { expect, test } from "@playwright/test";
import type {
  RuntimeModelRecord,
  RuntimeProviderRecord,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import { buildModelOptions } from "../../src/features/conversation/composer-commands";

function model(providerId: string, modelId: string, available = true): RuntimeModelRecord {
  return {
    providerId,
    providerName: providerId,
    modelId,
    label: modelId,
    available,
    authType: "api_key",
    reasoning: false,
    supportsImages: false,
  };
}

function provider(id: string): RuntimeProviderRecord {
  return {
    id,
    name: id,
    hasAuth: false,
    authType: "api_key",
    authSource: "none",
    oauthSupported: false,
    apiKeySetupSupported: true,
  };
}

function runtimeSnapshot(): RuntimeSnapshot {
  return {
    workspace: { workspaceId: "model-cache", path: "/model-cache" },
    providers: [provider("anthropic"), provider("openai")],
    models: [
      model("anthropic", "claude"),
      model("openai", "gpt-5"),
      model("openai", "gpt-4o", false),
    ],
    skills: [],
    extensions: [],
    settings: { enableSkillCommands: true, enabledModelPatterns: ["**"] },
  };
}

test("model options reuse unchanged catalog inputs through fresh runtime and settings wrappers", () => {
  const runtime = runtimeSnapshot();
  const options = buildModelOptions(runtime);
  expect(options.map((option) => option.modelId)).toEqual(["claude", "gpt-5"]);

  const wrapped: RuntimeSnapshot = {
    ...runtime,
    settings: {
      ...runtime.settings,
      defaultProvider: "openai",
      defaultModelId: "gpt-5",
      defaultThinkingLevel: "high",
      enabledModelPatterns: [...runtime.settings.enabledModelPatterns],
    },
  };
  expect(buildModelOptions(runtime)).toBe(options);
  expect(buildModelOptions(wrapped)).toBe(options);
});

test("model options invalidate when enabled pattern values change", () => {
  const runtime = runtimeSnapshot();
  const initial = buildModelOptions(runtime);
  const filtered: RuntimeSnapshot = {
    ...runtime,
    settings: { ...runtime.settings, enabledModelPatterns: ["openai/**"] },
  };
  const options = buildModelOptions(filtered);
  expect(options).not.toBe(initial);
  expect(options.map((option) => option.modelId)).toEqual(["gpt-5"]);
  expect(
    buildModelOptions({
      ...filtered,
      settings: { ...filtered.settings, enabledModelPatterns: ["anthropic/**"] },
    }).map((option) => option.modelId),
  ).toEqual(["claude"]);
  expect(
    buildModelOptions({ ...runtime, settings: { ...runtime.settings, enabledModelPatterns: [] } }),
  ).toEqual(initial);
});

test("model options invalidate when models change and preserve availability filtering", () => {
  const runtime = runtimeSnapshot();
  const initial = buildModelOptions(runtime);
  const updated: RuntimeSnapshot = {
    ...runtime,
    models: runtime.models.map((entry) => ({ ...entry, available: true })),
  };
  const options = buildModelOptions(updated);
  expect(options).not.toBe(initial);
  expect(options.map((option) => option.modelId)).toEqual(["claude", "gpt-4o", "gpt-5"]);
});

test("model options invalidate when provider authentication changes their sort order", () => {
  const runtime = runtimeSnapshot();
  const initial = buildModelOptions(runtime);
  const updated: RuntimeSnapshot = {
    ...runtime,
    providers: runtime.providers.map((entry) => ({ ...entry, hasAuth: entry.id === "openai" })),
  };
  const options = buildModelOptions(updated);
  expect(options).not.toBe(initial);
  expect(options.map((option) => option.providerId)).toEqual(["openai", "anthropic"]);
});

test("model options cache an empty match result and tolerate a missing runtime", () => {
  expect(buildModelOptions(undefined)).toEqual([]);
  const runtime = runtimeSnapshot();
  const filtered: RuntimeSnapshot = {
    ...runtime,
    settings: { ...runtime.settings, enabledModelPatterns: ["missing/**"] },
  };
  const options = buildModelOptions(filtered);
  expect(options).toEqual([]);
  expect(
    buildModelOptions({
      ...filtered,
      settings: {
        ...filtered.settings,
        enabledModelPatterns: [...filtered.settings.enabledModelPatterns],
      },
    }),
  ).toBe(options);
});
