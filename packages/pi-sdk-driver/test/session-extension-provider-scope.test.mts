import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

/**
 * Sessions must resolve models against the registry `createAgentSessionServices`
 * builds for their own cwd. These cover what a shared, cross-workspace registry
 * got wrong: two workspaces claiming one provider id would resolve to whichever
 * synced last, mixing one workspace's endpoint with another's credentials.
 *
 * Endpoints are discard ports and every key is a canary; nothing here sends a
 * request.
 */

const ENDPOINT_A = "http://127.0.0.1:9/workspace-a";
const ENDPOINT_B = "http://127.0.0.1:9/workspace-b";
const KEY_A = "CANARY_A_DO_NOT_USE";
const KEY_B = "CANARY_B_DO_NOT_USE";

function modelDefinition(modelId: string): string {
  return `{
        id: ${JSON.stringify(modelId)},
        name: ${JSON.stringify(`Model ${modelId}`)},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      }`;
}

function providerExtensionSource(
  providerId: string,
  modelId: string,
  baseUrl: string,
  apiKey: string,
): string {
  return `export default async function providerExtension(pi) {
  pi.registerProvider(${JSON.stringify(providerId)}, {
    baseUrl: ${JSON.stringify(baseUrl)},
    apiKey: ${JSON.stringify(apiKey)},
    api: "openai-completions",
    models: [${modelDefinition(modelId)}],
  });
}
`;
}

async function makeAgentDir(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-session-ext-scope-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  return { root, agentDir };
}

/** Write a workspace whose project extension registers `providerId`. */
async function makeWorkspaceDir(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, ".pi", "extensions"), { recursive: true });
  await writeFile(join(path, ".pi", "extensions", "provider.ts"), source);
  return path;
}

/**
 * A driver whose session runtimes are the real ones, wrapped only to keep the
 * `AgentSessionRuntime` around so a test can inspect the registry the session
 * actually resolves against.
 */
function makeDriver(root: string, agentDir: string) {
  const created: { cwd: string | undefined; runtime: { session: { modelRegistry: any } } }[] = [];
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (options: any) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback(options);
      created.push({ cwd: options?.cwd, runtime: runtime as never });
      return runtime;
    },
  });
  const registryFor = (cwd: string) => {
    const entry = created.findLast((candidate) => candidate.cwd === cwd);
    assert.ok(entry, `no session runtime was created for ${cwd}`);
    return entry.runtime.session.modelRegistry;
  };
  return { driver, registryFor };
}

test("a workspace resolves its own models for a provider id another workspace also registers", async () => {
  const { root, agentDir } = await makeAgentDir();
  const pathA = await makeWorkspaceDir(
    root,
    "workspace-a",
    providerExtensionSource("shared-id", "model-a", ENDPOINT_A, KEY_A),
  );
  const pathB = await makeWorkspaceDir(
    root,
    "workspace-b",
    providerExtensionSource("shared-id", "model-b", ENDPOINT_B, KEY_B),
  );
  const { driver } = makeDriver(root, agentDir);

  const { workspace: workspaceA } = await driver.syncWorkspace(pathA);
  const { workspace: workspaceB } = await driver.syncWorkspace(pathB);
  await driver.runtimeSupervisor.getRuntimeSnapshot(workspaceA);
  await driver.runtimeSupervisor.getRuntimeSnapshot(workspaceB);

  // B registered `shared-id` last. A must still resolve the model A advertises.
  const snapshot = await driver.createSession(workspaceA, {
    initialModel: { provider: "shared-id", modelId: "model-a" },
  });
  assert.equal(snapshot.config?.provider, "shared-id");
  assert.equal(snapshot.config?.modelId, "model-a");
  await driver.closeSession(snapshot.ref);
});

test("a session keeps its own workspace's endpoint and key for a shared provider and model id", async () => {
  const { root, agentDir } = await makeAgentDir();
  const pathA = await makeWorkspaceDir(
    root,
    "workspace-a",
    providerExtensionSource("shared-id", "model-x", ENDPOINT_A, KEY_A),
  );
  const pathB = await makeWorkspaceDir(
    root,
    "workspace-b",
    providerExtensionSource("shared-id", "model-x", ENDPOINT_B, KEY_B),
  );
  const { driver, registryFor } = makeDriver(root, agentDir);

  const { workspace: workspaceA } = await driver.syncWorkspace(pathA);
  const { workspace: workspaceB } = await driver.syncWorkspace(pathB);
  await driver.runtimeSupervisor.getRuntimeSnapshot(workspaceA);

  const snapshot = await driver.createSession(workspaceA, {
    initialModel: { provider: "shared-id", modelId: "model-x" },
  });

  // Opening workspace B while A has a live session must not re-point that
  // session — the mixing a registry shared across workspaces produced.
  await driver.runtimeSupervisor.getRuntimeSnapshot(workspaceB);

  const registry = registryFor(workspaceA.path);
  const model = registry.find("shared-id", "model-x");
  assert.ok(model, "workspace A's session must resolve the shared model id");
  assert.equal(model.baseUrl, ENDPOINT_A, "workspace A's session must keep workspace A's endpoint");

  const auth = await registry.getApiKeyAndHeaders(model);
  assert.equal(auth.ok, true);
  assert.equal(auth.apiKey, KEY_A, "workspace A's session must use workspace A's credential");
  await driver.closeSession(snapshot.ref);
});

test("removing a workspace leaves another workspace's session resolution intact", async () => {
  const { root, agentDir } = await makeAgentDir();
  const pathA = await makeWorkspaceDir(
    root,
    "workspace-a",
    providerExtensionSource("shared-id", "model-a", ENDPOINT_A, KEY_A),
  );
  const pathB = await makeWorkspaceDir(
    root,
    "workspace-b",
    providerExtensionSource("shared-id", "model-b", ENDPOINT_B, KEY_B),
  );
  const { driver, registryFor } = makeDriver(root, agentDir);

  const { workspace: workspaceA } = await driver.syncWorkspace(pathA);
  const { workspace: workspaceB } = await driver.syncWorkspace(pathB);
  await driver.runtimeSupervisor.getRuntimeSnapshot(workspaceA);
  await driver.runtimeSupervisor.getRuntimeSnapshot(workspaceB);

  await driver.removeWorkspace(workspaceA.workspaceId);

  const snapshot = await driver.createSession(workspaceB, {
    initialModel: { provider: "shared-id", modelId: "model-b" },
  });
  const registry = registryFor(workspaceB.path);
  const model = registry.find("shared-id", "model-b");
  assert.ok(model, "workspace B must still resolve its own model after workspace A is removed");
  assert.equal(model.baseUrl, ENDPOINT_B);
  await driver.closeSession(snapshot.ref);
});

test("removing a workspace evicts its runtime context", async () => {
  const { root, agentDir } = await makeAgentDir();
  const path = await makeWorkspaceDir(
    root,
    "workspace-a",
    providerExtensionSource("before-removal", "model-a", ENDPOINT_A, KEY_A),
  );
  const { driver } = makeDriver(root, agentDir);

  const { workspace } = await driver.syncWorkspace(path);
  const before = await driver.runtimeSupervisor.getRuntimeSnapshot(workspace);
  assert.ok(before.providers.some((provider) => provider.id === "before-removal"));

  await driver.removeWorkspace(workspace.workspaceId);

  // A cached context is served without reloading resources, so an extension
  // added after the removal only shows up if the context was actually dropped.
  await writeFile(
    join(path, ".pi", "extensions", "added-after-removal.ts"),
    providerExtensionSource("after-removal", "model-b", ENDPOINT_B, KEY_B),
  );
  const after = await driver.runtimeSupervisor.getRuntimeSnapshot(workspace);
  assert.ok(
    after.providers.some((provider) => provider.id === "after-removal"),
    "reopening a removed workspace must build a fresh context that reloads its extensions",
  );
});

test("an override-only registration keeps the models the first registration defined", async () => {
  const { root, agentDir } = await makeAgentDir();
  const path = await makeWorkspaceDir(
    root,
    "workspace-a",
    `export default async function providerExtension(pi) {
  pi.registerProvider("merge-id", {
    baseUrl: ${JSON.stringify(ENDPOINT_A)},
    apiKey: ${JSON.stringify(KEY_A)},
    api: "openai-completions",
    models: [${modelDefinition("model-a")}],
  });
  pi.registerProvider("merge-id", { baseUrl: ${JSON.stringify(ENDPOINT_B)} });
}
`,
  );
  const { driver, registryFor } = makeDriver(root, agentDir);

  const { workspace } = await driver.syncWorkspace(path);
  const runtimeSnapshot = await driver.runtimeSupervisor.getRuntimeSnapshot(workspace);
  assert.ok(
    runtimeSnapshot.models.some((model) => model.providerId === "merge-id" && model.modelId === "model-a"),
    "the override-only registration must not drop the model the first call defined",
  );

  const snapshot = await driver.createSession(workspace, {
    initialModel: { provider: "merge-id", modelId: "model-a" },
  });
  const model = registryFor(workspace.path).find("merge-id", "model-a");
  assert.ok(model, "the merged provider must stay resolvable for sessions");
  assert.equal(model.baseUrl, ENDPOINT_B, "the override-only registration must re-point the model");
  await driver.closeSession(snapshot.ref);
});
