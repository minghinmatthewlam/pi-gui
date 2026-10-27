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
  ...["openai", "openai-codex"].map((provider) => ({
    provider,
    id: "gpt-6.1-sol",
    reason: "Pi 0.99.1 GPT-6.1 Sol support",
    requireReasoning: true,
    requireImageInput: true,
    requireMaxThinking: true,
  })),
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
    provider: "meta",
    id: "muse-wonder-1.0",
    reason: "issue #288 Muse Wonder visibility",
    requireReasoning: true,
    requireImageInput: true,
    requireMaxThinking: true,
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

// Issue #293: Pi before 1.3.0 doubled /v1 on kimi-coding requests.
const kimiModels = models.filter((entry) => entry.provider === "kimi-coding");
if (kimiModels.length === 0) {
  throw new Error("Bundled Pi runtime does not expose kimi-coding models for issue #293.");
}
for (const model of kimiModels) {
  if (model.baseUrl !== "https://api.kimi.com/coding/v1") {
    throw new Error(
      `Bundled kimi-coding/${model.id} uses ${model.baseUrl}; issue #293 needs https://api.kimi.com/coding/v1.`,
    );
  }
}
console.log("Verified bundled kimi-coding models use https://api.kimi.com/coding/v1.");

// Issue #288: Meta exposes muse-wonder-1.0-contributor via its subscription
// /v1/models endpoint, but upstream Pi (including 1.4.0) only bundles
// muse-wonder-1.0. Until it does, users can add the contributor variant in
// models.json; verify that Pi's models.json merge surfaces it.
const overlayDir = await mkdtemp(join(tmpdir(), "pi-gui-runtime-models-overlay-"));
await writeFile(join(overlayDir, "auth.json"), "{}\n");
await writeFile(
  join(overlayDir, "models.json"),
  JSON.stringify({
    providers: {
      meta: {
        models: [
          {
            id: "muse-wonder-1.0-contributor",
            name: "Muse Wonder Contributor",
            api: "openai-responses",
            baseUrl: "https://api.meta.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 131072,
            thinkingLevelMap: {
              off: null,
              minimal: "minimal",
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: null,
            },
            inputLimits: {
              images: {
                resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
              },
            },
          },
        ],
      },
    },
  }),
);
const overlayRuntime = await ModelRuntime.create({
  authPath: join(overlayDir, "auth.json"),
  modelsPath: join(overlayDir, "models.json"),
  refreshOnCreate: false,
});
const overlayModel = overlayRuntime
  .getModels()
  .find((entry) => entry.provider === "meta" && entry.id === "muse-wonder-1.0-contributor");
if (!overlayModel) {
  throw new Error(
    "models.json overlay does not expose meta/muse-wonder-1.0-contributor for issue #288.",
  );
}
if (!overlayModel.reasoning || !overlayModel.input.includes("image")) {
  throw new Error("Overlay meta/muse-wonder-1.0-contributor is missing reasoning/image support.");
}
console.log("Verified models.json overlay exposes meta/muse-wonder-1.0-contributor.");
