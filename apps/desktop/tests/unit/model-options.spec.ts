import { expect, test } from "@playwright/test";
import type {
  RuntimeModelRecord,
  RuntimeModelScope,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import { buildModelOptions } from "../../src/features/conversation/composer-commands";

function model(
  providerId: string,
  modelId: string,
  scope: RuntimeModelScope,
  available = true,
): RuntimeModelRecord {
  return {
    providerId,
    providerName: providerId,
    modelId,
    label: modelId,
    available,
    authType: "api_key",
    reasoning: false,
    supportsImages: false,
    scope,
  };
}

test("model options list available models that pi's enabledModels scope includes", () => {
  const runtime: RuntimeSnapshot = {
    workspace: { workspaceId: "model-options", path: "/model-options" },
    providers: [
      {
        id: "openai",
        name: "openai",
        hasAuth: true,
        authType: "api_key",
        authSource: "auth_file",
        oauthSupported: false,
        apiKeySetupSupported: true,
      },
    ],
    models: [
      model("anthropic", "claude", "listed"),
      model("openai", "gpt-5", "matched"),
      model("openai", "gpt-4o", "off"),
      model("openai", "gpt-4-turbo", "matched", false),
    ],
    skills: [],
    extensions: [],
    settings: {
      enableSkillCommands: true,
      enabledModelPatterns: ["openai/gpt-5*", "anthropic/claude"],
    },
  };

  // Providers with auth sort first.
  expect(
    buildModelOptions(runtime).map((option) => `${option.providerId}/${option.modelId}`),
  ).toEqual(["openai/gpt-5", "anthropic/claude"]);
  expect(buildModelOptions(undefined)).toEqual([]);
});
