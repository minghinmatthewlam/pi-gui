import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";

const MCP_SERVER_FIXTURE = fileURLToPath(
  new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url),
);

async function setup(t: test.TestContext, settings: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-addons-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], ...settings }));
  // pi's MCP extension reads mcp.json from pi's agent directory, not from driver options.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  return { root, agentDir, workspace: { workspaceId: "addons-workspace", path: workspacePath } };
}

async function readSettings(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

await test("Settings lists pi's add-ons by their builtin: path and switches them in pi's setting", async (t) => {
  const { agentDir, workspace } = await setup(t);
  const supervisor = new RuntimeSupervisor({ agentDir });
  const addons = async (refresh: boolean) => {
    const snapshot = refresh
      ? await supervisor.refreshRuntime(workspace)
      : await supervisor.getRuntimeSnapshot(workspace);
    return snapshot.extensions
      .filter((record) => record.path.startsWith("builtin:"))
      .map((record) => ({
        path: record.path,
        name: record.displayName,
        enabled: record.enabled,
        source: record.sourceInfo.source,
        scope: record.sourceInfo.scope,
      }));
  };

  assert.deepEqual(await addons(false), [
    {
      path: "builtin:codemode",
      name: "Code mode",
      enabled: true,
      source: "builtin",
      scope: "user",
    },
    { path: "builtin:mcp", name: "MCP servers", enabled: true, source: "builtin", scope: "user" },
    {
      path: "builtin:tool-search",
      name: "Tool search",
      enabled: true,
      source: "builtin",
      scope: "user",
    },
  ]);
  const mcp = (await supervisor.getRuntimeSnapshot(workspace)).extensions.find(
    (record) => record.path === "builtin:mcp",
  );
  assert.deepEqual(mcp?.commands, ["mcp"]);

  const off = await supervisor.setExtensionEnabled(workspace, "builtin:mcp", false);
  assert.equal(off.extensions.find((record) => record.path === "builtin:mcp")?.enabled, false);
  assert.deepEqual((await readSettings(agentDir)).extensions, ["-builtin:mcp"]);

  const on = await supervisor.setExtensionEnabled(workspace, "builtin:mcp", true);
  assert.equal(on.extensions.find((record) => record.path === "builtin:mcp")?.enabled, true);
  assert.deepEqual((await readSettings(agentDir)).extensions, ["+builtin:mcp"]);
  assert.equal(
    (await addons(true)).every((addon) => addon.enabled),
    true,
  );
});

await test(
  "a new session loads pi's add-ons and starts mcp.json servers, unless -builtin:mcp",
  { timeout: 30_000 },
  async (t) => {
    const { root, agentDir, workspace } = await setup(t);
    const markerDir = join(root, "markers");
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [MCP_SERVER_FIXTURE, markerDir] },
        },
      }),
    );
    const driver = new PiSdkDriver({ agentDir, catalogFilePath: join(agentDir, "catalogs.json") });
    const { ref } = await driver.createSession(workspace);
    t.after(() => driver.closeSession(ref));

    const commands = await driver.getSessionCommands(ref);
    const mcpCommand = commands.find((command) => command.name === "mcp");
    assert.equal(mcpCommand?.sourceInfo.path, "builtin:mcp");
    await waitFor(
      () => existsSync(join(markerDir, "initialized.txt")),
      "the session to start the mcp.json server",
    );

    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [], extensions: ["-builtin:mcp"] }),
    );
    const second = await driver.createSession(workspace);
    t.after(() => driver.closeSession(second.ref));
    const secondCommands = await driver.getSessionCommands(second.ref);
    assert.equal(
      secondCommands.some((command) => command.name === "mcp"),
      false,
      "-builtin:mcp leaves MCP out of a new session",
    );
  },
);
