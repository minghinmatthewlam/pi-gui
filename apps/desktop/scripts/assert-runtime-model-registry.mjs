import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const dir = await mkdtemp(join(tmpdir(), "pi-gui-runtime-models-"));
await writeFile(join(dir, "auth.json"), "{}\n");
const runtime = await ModelRuntime.create({
  authPath: join(dir, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
});
const models = runtime.getModels();
const modelChecks = [
  ...["openai", "openai-codex", "github-copilot"].flatMap((provider) =>
    ["sol", "luna"].map((variant) => ({
      provider,
      id: `gpt-6-${variant}`,
      reason: "Pi 0.87.1 GPT-6 support",
      requireReasoning: true,
      requireImageInput: true,
      requireMaxThinking: true,
    })),
  ),
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
    id: "glm-5.3",
    reason: "issue #12 GLM visibility",
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
