import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gatedBuiltinExtensions, type BuiltinExtension } from "../dist/builtin-extensions.js";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";

const DEMO: BuiltinExtension = {
  name: "pi-gui-demo",
  displayName: "Demo tools",
  description: "Adds a demo tool",
  factory: (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "demo_tool",
      label: "Demo",
      description: "Demo tool",
      parameters: { type: "object", properties: {} },
      execute: () => Promise.resolve({ content: [], details: undefined }),
    });
  },
};

async function createDirs(): Promise<{ agentDir: string; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-builtins-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  return { agentDir, workspacePath };
}

await test("a switched-off built-in contributes no tools, and comes back on the next reload", async () => {
  const { agentDir, workspacePath } = await createDirs();
  let enabled = false;
  const loader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: gatedBuiltinExtensions([DEMO], () => enabled),
  });
  const demoTools = () =>
    loader
      .getExtensions()
      .extensions.filter((extension) => extension.path === "<inline:pi-gui-demo>")
      .flatMap((extension) => [...extension.tools.keys()]);

  await loader.reload();
  assert.deepEqual(demoTools(), []);

  enabled = true;
  await loader.reload();
  assert.deepEqual(demoTools(), ["demo_tool"]);
});

await test("Settings lists a switched-off built-in with its tools and name", async () => {
  const { agentDir, workspacePath } = await createDirs();
  let enabled = true;
  const supervisor = new RuntimeSupervisor({
    agentDir,
    builtinExtensions: [DEMO],
    isBuiltinExtensionEnabled: () => enabled,
  });
  const workspace = { workspaceId: "workspace-1", path: workspacePath };
  const demoRecord = async (refresh: boolean) => {
    const snapshot = refresh
      ? await supervisor.refreshRuntime(workspace)
      : await supervisor.getRuntimeSnapshot(workspace);
    const record = snapshot.extensions.find((entry) => entry.path === "<inline:pi-gui-demo>");
    return record && { name: record.displayName, enabled: record.enabled, tools: record.tools };
  };

  assert.deepEqual(await demoRecord(false), {
    name: "Demo tools",
    enabled: true,
    tools: ["demo_tool"],
  });

  enabled = false;
  assert.deepEqual(await demoRecord(true), {
    name: "Demo tools",
    enabled: false,
    tools: ["demo_tool"],
  });

  assert.equal(supervisor.builtinExtensionName("<inline:pi-gui-demo>"), "pi-gui-demo");
  assert.equal(supervisor.builtinExtensionName(join(workspacePath, "ext.ts")), undefined);
});

await test(
  "a session loads a built-in only while it is switched on, rechecked on reload",
  { timeout: 10_000 },
  async (t) => {
    const { agentDir, workspacePath } = await createDirs();
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "builtin-test": {
            baseUrl: "http://127.0.0.1:9/never-contact",
            apiKey: "LOCAL_TEST_CANARY",
            api: "openai-completions",
            models: [{ id: "scripted", contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }),
    );
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    });
    let enabled = false;
    let loads = 0;
    const driver = new PiSdkDriver({
      agentDir,
      catalogFilePath: join(agentDir, "catalogs.json"),
      builtinExtensions: [
        {
          ...DEMO,
          factory: (pi) => {
            loads += 1;
            return DEMO.factory(pi);
          },
        },
      ],
      isBuiltinExtensionEnabled: () => enabled,
    });
    const { ref } = await driver.createSession(
      { workspaceId: "builtin-workspace", path: workspacePath },
      { initialModel: { provider: "builtin-test", modelId: "scripted" } },
    );
    t.after(() => driver.closeSession(ref));
    assert.equal(loads, 0, "a switched-off built-in never registers in a new session");

    enabled = true;
    await driver.reloadSession(ref);
    assert.equal(loads, 1, "switching on takes effect on the open session's reload");

    enabled = false;
    await driver.reloadSession(ref);
    assert.equal(loads, 1, "switching off stops it registering again");
  },
);
