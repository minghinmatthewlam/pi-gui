import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";

const ROUTER = "scope-test-router";
const ZAI = "scope-test-zai";
const DIRECT = "scope-test-direct";

function provider(models: readonly string[]) {
  return {
    baseUrl: "http://localhost:9/v1",
    api: "openai-completions",
    apiKey: "test-key",
    models: models.map((id) => ({ id, input: ["text"], reasoning: true })),
  };
}

async function supervisorWithEnabledModels(enabledModels?: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-model-scope-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], ...(enabledModels ? { enabledModels } : {}) }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [ROUTER]: provider(["z-ai/glm-5.3", "qwen/qwen-4"]),
        [ZAI]: provider(["glm-5.3"]),
        [DIRECT]: provider(["solo-model-7", "pair-model-8"]),
      },
    }),
  );
  return {
    supervisor: new RuntimeSupervisor({ agentDir }),
    workspace: { workspaceId: "model-scope", path: workspacePath },
  };
}

function scopes(models: readonly { providerId: string; modelId: string; scope: string }[]) {
  return Object.fromEntries(
    models
      .filter((model) => model.providerId.startsWith("scope-test-"))
      .map((model) => [`${model.providerId}/${model.modelId}`, model.scope]),
  );
}

await test("every model is in scope when enabledModels is unset", async () => {
  const { supervisor, workspace } = await supervisorWithEnabledModels();
  const snapshot = await supervisor.getRuntimeSnapshot(workspace);
  assert.deepEqual(new Set(Object.values(scopes(snapshot.models))), new Set(["all"]));
});

await test("globs enable models the way pi does, and lock them on", async () => {
  const { supervisor, workspace } = await supervisorWithEnabledModels([
    `${ROUTER}/**`,
    `${ROUTER}/z-ai/glm-5.3`,
    `${DIRECT}/pair-model-8`,
  ]);
  const snapshot = await supervisor.getRuntimeSnapshot(workspace);
  assert.deepEqual(scopes(snapshot.models), {
    [`${ROUTER}/qwen/qwen-4`]: "matched",
    [`${ROUTER}/z-ai/glm-5.3`]: "matched",
    [`${ZAI}/glm-5.3`]: "off",
    [`${DIRECT}/pair-model-8`]: "listed",
    [`${DIRECT}/solo-model-7`]: "off",
  });
});

await test("single-star, bare-id, case-insensitive and thinking-suffix entries match like pi", async () => {
  const { supervisor, workspace } = await supervisorWithEnabledModels();
  const { models } = await supervisor.getRuntimeSnapshot(workspace);
  const scopeFor = async (patterns: readonly string[]) =>
    scopes(await supervisor.scopeModels(workspace, models, patterns));

  // `*` does not cross the `/` inside a nested model id.
  assert.equal((await scopeFor([`${ROUTER}/*`]))[`${ROUTER}/z-ai/glm-5.3`], "off");
  // A glob also matches the bare model id, where `*` still stops at a `/`.
  const glm = await scopeFor(["*glm*"]);
  assert.equal(glm[`${ZAI}/glm-5.3`], "matched");
  assert.equal(glm[`${ROUTER}/z-ai/glm-5.3`], "off");
  assert.equal(glm[`${ROUTER}/qwen/qwen-4`], "off");
  // Globs ignore case and a trailing thinking level.
  assert.equal(
    (await scopeFor([`${ROUTER.toUpperCase()}/z-ai/*:high`]))[`${ROUTER}/z-ai/glm-5.3`],
    "matched",
  );
  // A bare id and a `provider/id:thinking` entry are not globs, and pi still resolves them.
  const nonGlob = await scopeFor(["solo-model-7", `${DIRECT}/pair-model-8:high`]);
  assert.equal(nonGlob[`${DIRECT}/solo-model-7`], "matched");
  assert.equal(nonGlob[`${DIRECT}/pair-model-8`], "matched");
  assert.equal(nonGlob[`${ZAI}/glm-5.3`], "off");
  // Clearing the patterns enables everything again.
  assert.equal((await scopeFor([]))[`${ZAI}/glm-5.3`], "all");
});

await test("refreshing keeps a glob-only enabledModels list instead of adding every connected model", async () => {
  const { supervisor, workspace } = await supervisorWithEnabledModels([`${ROUTER}/**`]);
  const snapshot = await supervisor.refreshRuntime(workspace);
  assert.deepEqual(snapshot.settings.enabledModelPatterns, [`${ROUTER}/**`]);
  assert.equal(scopes(snapshot.models)[`${DIRECT}/solo-model-7`], "off");
});
