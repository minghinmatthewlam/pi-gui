import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";

const EXTENSION_PROVIDER = "ext-test-provider";
const EXTENSION_MODEL = "ext-test-model";
const JSON_PROVIDER = "json-test-provider";
const JSON_MODEL = "json-test-model";
const FILE_PROVIDER = "file-test-provider";
const FILE_MODEL = "file-test-model";

async function createAgentDir(): Promise<{ agentDir: string; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-ext-providers-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [JSON_PROVIDER]: {
          baseUrl: "http://localhost:9/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: JSON_MODEL, input: ["text"] }],
        },
      },
    }),
  );
  return { agentDir, workspacePath };
}

function createSupervisor(agentDir: string) {
  return new RuntimeSupervisor({
    agentDir,
    extensionFactories: [
      (pi) => {
        pi.registerProvider(EXTENSION_PROVIDER, {
          baseUrl: "http://localhost:9/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [
            {
              id: EXTENSION_MODEL,
              name: "Extension Test Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        });
      },
    ],
  });
}

test("runtime snapshot includes providers registered by extensions", async () => {
  const { agentDir, workspacePath } = await createAgentDir();
  const supervisor = createSupervisor(agentDir);
  const workspace = { workspaceId: "workspace-1", path: workspacePath };

  const snapshot = await supervisor.getRuntimeSnapshot(workspace);

  assert.ok(
    snapshot.models.some((model) => model.providerId === JSON_PROVIDER && model.modelId === JSON_MODEL),
    "models.json provider should be listed",
  );
  assert.ok(
    snapshot.models.some((model) => model.providerId === EXTENSION_PROVIDER && model.modelId === EXTENSION_MODEL),
    "extension-registered provider should be listed",
  );
  assert.ok(
    snapshot.providers.some((provider) => provider.id === EXTENSION_PROVIDER),
    "extension-registered provider should appear in the provider list",
  );
});

test("disabling an extension drops the providers it registered", async () => {
  const { agentDir, workspacePath } = await createAgentDir();
  const extensionPath = join(agentDir, "extensions", "file-provider.ts");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    extensionPath,
    `export default async function fileProviderExtension(pi) {
  pi.registerProvider(${JSON.stringify(FILE_PROVIDER)}, {
    baseUrl: "http://localhost:9/v1",
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: ${JSON.stringify(FILE_MODEL)},
        name: "File Extension Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });
}
`,
  );

  const supervisor = new RuntimeSupervisor({ agentDir });
  const workspace = { workspaceId: "workspace-1", path: workspacePath };

  const enabled = await supervisor.getRuntimeSnapshot(workspace);
  assert.ok(
    enabled.models.some((model) => model.providerId === FILE_PROVIDER && model.modelId === FILE_MODEL),
    "file-based extension provider should be listed while enabled",
  );

  const disabled = await supervisor.setExtensionEnabled(workspace, extensionPath, false);
  assert.ok(
    !disabled.models.some((model) => model.providerId === FILE_PROVIDER),
    "provider should be dropped once its extension is disabled",
  );
});

test("extension providers survive a runtime refresh", async () => {
  const { agentDir, workspacePath } = await createAgentDir();
  const supervisor = createSupervisor(agentDir);
  const workspace = { workspaceId: "workspace-1", path: workspacePath };

  await supervisor.getRuntimeSnapshot(workspace);
  const refreshed = await supervisor.refreshRuntime(workspace);

  assert.ok(
    refreshed.models.some((model) => model.providerId === EXTENSION_PROVIDER && model.modelId === EXTENSION_MODEL),
    "extension-registered provider should still be listed after refreshRuntime",
  );
});
