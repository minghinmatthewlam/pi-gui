import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
const models = registry.getAll();
const modelChecks = [
  ...["luna", "sol", "terra"].map((variant) => ({
    provider: "openai-codex",
    id: `gpt-5.6-${variant}`,
    reason: "GPT 5.6 Codex support",
    requireReasoning: true,
    requireImageInput: true,
    requireMaxThinking: true,
  })),
  {
    provider: "anthropic",
    id: "claude-opus-4-7",
    reason: "issue #12 Opus 4.7 visibility",
    requireReasoning: true,
    requireImageInput: true,
  },
  {
    provider: "zai",
    id: "glm-5.1",
    reason: "issue #12 GLM 5.1 visibility",
    requireReasoning: true,
    requireImageInput: false,
  },
];

for (const check of modelChecks) {
  const model = models.find((entry) => entry.provider === check.provider && entry.id === check.id);
  const modelKey = `${check.provider}/${check.id}`;
  if (!model) {
    throw new Error(`Bundled Pi runtime does not expose ${modelKey} for ${check.reason}.`);
  }
  if (check.requireReasoning && !model.reasoning) {
    throw new Error(`Bundled ${modelKey} is missing reasoning support for ${check.reason}.`);
  }
  if (check.requireImageInput && !model.input.includes("image")) {
    throw new Error(`Bundled ${modelKey} is missing image input support for ${check.reason}.`);
  }
  if (check.requireMaxThinking && model.thinkingLevelMap?.max !== "max") {
    throw new Error(`Bundled ${modelKey} is missing max thinking support for ${check.reason}.`);
  }
}

console.log(
  modelChecks
    .map((check) => `Verified bundled Pi runtime exposes ${check.provider}/${check.id}.`)
    .join("\n"),
);
