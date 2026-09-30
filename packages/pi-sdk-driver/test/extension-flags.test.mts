import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { BuiltinExtension } from "../dist/builtin-extensions.js";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-flags-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  return { agentDir, workspace: { workspaceId: "flags-workspace", path: workspacePath } };
}

/** Records what the extension reads with pi.getFlag once the session starts, like a real extension. */
function flagReader(seen: Record<string, unknown>[]): BuiltinExtension {
  return {
    name: "pi-gui-flag-reader",
    displayName: "Flag reader",
    description: "Reads its flags at session start",
    factory: (pi: ExtensionAPI) => {
      pi.registerFlag("plan", { type: "boolean", description: "Plan only" });
      pi.registerFlag("env", { type: "string", description: "Target environment" });
      pi.on("session_start", () => {
        seen.push({ plan: pi.getFlag("plan"), env: pi.getFlag("env") });
      });
    },
  };
}

await test("flag values given to createSession reach the extension through pi", async (t) => {
  const { agentDir, workspace } = await setup(t);
  const seen: Record<string, unknown>[] = [];
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(agentDir, "catalogs.json"),
    builtinExtensions: [flagReader(seen)],
  });
  const { ref } = await driver.createSession(workspace, {
    extensionFlagValues: { plan: true, env: "staging" },
  });
  t.after(() => driver.closeSession(ref));
  assert.deepEqual(seen.at(-1), { plan: true, env: "staging" });

  await driver.reloadSession(ref);
  assert.deepEqual(seen.at(-1), { plan: true, env: "staging" }, "a reload keeps the flags");
});

await test("a reopened session gets the flags it started with again", async (t) => {
  const { agentDir, workspace } = await setup(t);
  const seen: Record<string, unknown>[] = [];
  const flagsBySession = new Map<string, Record<string, boolean | string>>();
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(agentDir, "catalogs.json"),
    builtinExtensions: [flagReader(seen)],
    extensionFlagValuesForSession: (sessionRef) => flagsBySession.get(sessionRef.sessionId),
  });
  const { ref } = await driver.createSession(workspace, {
    extensionFlagValues: { env: "production" },
  });
  flagsBySession.set(ref.sessionId, { env: "production" });
  await driver.closeSession(ref);
  seen.length = 0;

  await driver.openSession(ref);
  t.after(() => driver.closeSession(ref));
  assert.deepEqual(seen.at(-1), { plan: undefined, env: "production" });
});

await test("pi's flag diagnostics reach the first subscriber as extension errors", async (t) => {
  const { agentDir, workspace } = await setup(t);
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(agentDir, "catalogs.json"),
    builtinExtensions: [flagReader([])],
  });
  const { ref } = await driver.createSession(workspace, {
    extensionFlagValues: { gone: true, env: true },
  });
  t.after(() => driver.closeSession(ref));

  const notices: string[] = [];
  const collect = (event: SessionDriverEvent) => {
    if (event.type === "hostUiRequest" && event.request.kind === "notify") {
      notices.push(`${event.request.level}: ${event.request.message}`);
    }
  };
  const unsubscribe = driver.subscribe(ref, collect);
  unsubscribe();
  driver.subscribe(ref, collect)();
  assert.deepEqual(notices, [
    'error: Extension flag "--env" requires a value',
    "error: Unknown option: --gone",
  ]);
});
