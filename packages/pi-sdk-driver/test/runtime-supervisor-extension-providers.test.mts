import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";

const EXTENSION_PROVIDER = "ext-test-provider";
const EXTENSION_MODEL = "ext-test-model";
const JSON_PROVIDER = "json-test-provider";
const JSON_MODEL = "json-test-model";
const FILE_PROVIDER = "file-test-provider";
const FILE_MODEL = "file-test-model";

function extensionSource(providerId: string, modelId: string, baseUrl = "http://localhost:9/v1"): string {
  return `export default async function providerExtension(pi) {
  pi.registerProvider(${JSON.stringify(providerId)}, {
    baseUrl: ${JSON.stringify(baseUrl)},
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: ${JSON.stringify(modelId)},
        name: ${JSON.stringify(`Model ${modelId}`)},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });
}
`;
}

/** Create a workspace with a project-scoped extension under `<workspace>/.pi/extensions`. */
async function createProjectWorkspace(
  root: string,
  workspaceId: string,
  providerId: string,
  modelId: string,
  baseUrl?: string,
): Promise<{ workspace: { workspaceId: string; path: string }; extensionPath: string }> {
  const path = join(root, workspaceId);
  const extensionPath = join(path, ".pi", "extensions", "provider.ts");
  await mkdir(join(path, ".pi", "extensions"), { recursive: true });
  await writeFile(extensionPath, extensionSource(providerId, modelId, baseUrl));
  return { workspace: { workspaceId, path }, extensionPath };
}

function providerIds(snapshot: { providers: readonly { id: string }[] }, prefix: string): string[] {
  return snapshot.providers.map((provider) => provider.id).filter((id) => id.startsWith(prefix));
}

function modelKeys(snapshot: { models: readonly { providerId: string; modelId: string }[] }, prefix: string): string[] {
  return snapshot.models
    .filter((model) => model.providerId.startsWith(prefix))
    .map((model) => `${model.providerId}:${model.modelId}`);
}

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

/** An agent dir with no models.json providers, for multi-workspace isolation tests. */
async function createSharedAgentDir(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-ext-providers-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  return { root, agentDir };
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

test("each workspace only sees providers its own project extensions register", async () => {
  const { root, agentDir } = await createSharedAgentDir();
  const a = await createProjectWorkspace(root, "workspace-a", "scoped-a", "model-a");
  const b = await createProjectWorkspace(root, "workspace-b", "scoped-b", "model-b");
  const supervisor = new RuntimeSupervisor({ agentDir });

  const firstA = await supervisor.getRuntimeSnapshot(a.workspace);
  assert.deepEqual(providerIds(firstA, "scoped-"), ["scoped-a"]);

  const snapshotB = await supervisor.getRuntimeSnapshot(b.workspace);
  assert.deepEqual(providerIds(snapshotB, "scoped-"), ["scoped-b"], "workspace B must not see workspace A's provider");
  assert.deepEqual(modelKeys(snapshotB, "scoped-"), ["scoped-b:model-b"]);

  const secondA = await supervisor.getRuntimeSnapshot(a.workspace);
  assert.deepEqual(
    providerIds(secondA, "scoped-"),
    ["scoped-a"],
    "workspace A must not pick up workspace B's provider after B was opened",
  );
  assert.deepEqual(modelKeys(secondA, "scoped-"), ["scoped-a:model-a"]);
});

test("the same provider id resolves to each workspace's own configuration", async () => {
  const { root, agentDir } = await createSharedAgentDir();
  const a = await createProjectWorkspace(root, "workspace-a", "shared-id", "model-a", "http://localhost:9/a");
  const b = await createProjectWorkspace(root, "workspace-b", "shared-id", "model-b", "http://localhost:9/b");
  const supervisor = new RuntimeSupervisor({ agentDir });

  await supervisor.getRuntimeSnapshot(a.workspace);
  const snapshotB = await supervisor.getRuntimeSnapshot(b.workspace);
  assert.deepEqual(modelKeys(snapshotB, "shared-id"), ["shared-id:model-b"]);

  const secondA = await supervisor.getRuntimeSnapshot(a.workspace);
  assert.deepEqual(
    modelKeys(secondA, "shared-id"),
    ["shared-id:model-a"],
    "workspace A must keep its own configuration for a provider id workspace B also registers",
  );
});

test("disabling an extension only drops the registrations of that workspace", async () => {
  const { root, agentDir } = await createSharedAgentDir();
  const a = await createProjectWorkspace(root, "workspace-a", "scoped-a", "model-a");
  const b = await createProjectWorkspace(root, "workspace-b", "scoped-b", "model-b");
  const supervisor = new RuntimeSupervisor({ agentDir });

  await supervisor.getRuntimeSnapshot(a.workspace);
  await supervisor.getRuntimeSnapshot(b.workspace);

  const disabledA = await supervisor.setExtensionEnabled(a.workspace, a.extensionPath, false);
  assert.deepEqual(providerIds(disabledA, "scoped-"), [], "workspace A should lose its own provider");

  const snapshotB = await supervisor.getRuntimeSnapshot(b.workspace);
  assert.deepEqual(
    providerIds(snapshotB, "scoped-"),
    ["scoped-b"],
    "workspace B should keep its provider when workspace A disables its extension",
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
