import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import type { PiDesktopExtensionRuntime } from "../dist/desktop-extension-bridge.js";

await test(
  "installed Pi discovers one loaded closure per runtime without waiting for stalled desktop work",
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-desktop-bridge-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const extensionDirectory = join(cwd, ".pi", "extensions", "counter");
    await mkdir(agentDir);
    await mkdir(extensionDirectory, { recursive: true });
    await writeFile(join(agentDir, "auth.json"), "{}");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [], cacheWarming: "off" }),
    );
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "bridge-test": {
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
    const network = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Discovery test must not use network");
    });
    t.after(() => assert.equal(network.mock.callCount(), 0));
    const extensionPath = join(extensionDirectory, "index.ts");
    const factoryLog = join(root, "factory.log");
    const helperPath = fileURLToPath(import.meta.resolve("@pi-gui/extension-ui"));
    await writeFile(
      extensionPath,
      `
import { appendFileSync } from "node:fs";
import { registerDesktopView } from ${JSON.stringify(helperPath)};
export default function extension(pi) {
  appendFileSync(${JSON.stringify(factoryLog)}, "factory\\n");
  let value = 0;
  const registration = registerDesktopView(pi, {
    id: "counter", title: "Counter", source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () => ({ id: "counter-" + (++value), setup() {} }),
  });
  if (!registration.available) throw new Error("Desktop bootstrap did not acknowledge registration");
}
`,
    );
    const changed: PiDesktopExtensionRuntime[] = [];
    const invalidated: Array<{ generation: string; sessionId: string }> = [];
    const stalledDesktopWork = new Promise<void>(() => {});
    let externalFactoryCalls = 0;
    const driver = new PiSdkDriver({
      agentDir,
      catalogFilePath: join(root, "catalogs.json"),
      builtinExtensions: [
        {
          name: "external",
          displayName: "External",
          factory: () => {
            externalFactoryCalls += 1;
          },
        },
      ],
      desktopExtensions: {
        onChanged(runtime) {
          changed.push(runtime);
          return stalledDesktopWork;
        },
        onInvalidated(runtime) {
          invalidated.push({ generation: runtime.generation, sessionId: runtime.target.sessionId });
          return stalledDesktopWork;
        },
      },
    });
    const { ref } = await driver.createSession(
      { workspaceId: "bridge-workspace", path: cwd },
      { initialModel: { provider: "bridge-test", modelId: "scripted" } },
    );
    t.after(() => driver.closeSession(ref));
    assert.equal(externalFactoryCalls, 1, "bootstrap preserves other internal factories");
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0]!.target, ref);
    assert.ok(changed[0]!.extensions.some(({ resolvedPath }) => resolvedPath === extensionPath));
    assert.equal(changed[0]!.declarations.length, 1);
    const first = changed[0]!.declarations[0]!;
    assert.equal(first.backend().id, "counter-1");
    assert.equal(first.backend().id, "counter-2", "declaration retains one Pi extension closure");
    assert.equal(await readFile(factoryLog, "utf8"), "factory\n");
    await driver.reloadSession(ref);
    assert.equal(externalFactoryCalls, 2);
    assert.equal(invalidated.length, 1);
    assert.equal(invalidated[0]!.generation, changed[0]!.generation);
    const newest = changed.at(-1)!;
    assert.notEqual(newest.generation, changed[0]!.generation);
    assert.equal(newest.declarations.length, 1);
    assert.notEqual(newest.declarations[0], first);
    assert.equal(newest.declarations[0]!.backend().id, "counter-1");
    assert.equal(await readFile(factoryLog, "utf8"), "factory\nfactory\n");
    await driver.closeSession(ref);
    assert.equal(
      invalidated.length,
      2,
      "close revokes the generation even while desktop work is stalled",
    );
    assert.equal(invalidated[1]!.generation, newest.generation);
  },
);
