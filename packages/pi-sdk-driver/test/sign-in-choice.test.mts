import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";

const PROVIDER = "sign-in-choice-provider";

/**
 * A provider whose sign-in opens with a choice, the way pi's Anthropic, OpenAI Codex and
 * Radius sign-ins do, and records the option it was given.
 */
async function startSupervisor(options: readonly { id: string; label: string }[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-sign-in-choice-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const chosen: (string | undefined)[] = [];
  const supervisor = new RuntimeSupervisor({
    agentDir,
    builtinExtensions: [
      {
        name: "sign-in-choice",
        displayName: "Sign-in choice",
        factory: (pi) => {
          pi.registerProvider(PROVIDER, {
            baseUrl: "http://localhost:9/v1",
            api: "openai-completions",
            models: [
              {
                id: "model",
                name: "Model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
            ],
            oauth: {
              name: "Sign-in choice",
              async login(callbacks) {
                chosen.push(await callbacks.onSelect({ message: "Select login method:", options }));
                return { access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 };
              },
              async refreshToken(credentials) {
                return credentials;
              },
              getApiKey: (credentials) => String(credentials.access),
            },
          });
        },
      },
    ],
  });
  return { supervisor, workspace: { workspaceId: "workspace", path: workspacePath }, chosen };
}

await test("a sign-in that offers browser login takes it without asking", async () => {
  const { supervisor, workspace, chosen } = await startSupervisor([
    { id: "browser", label: "Browser login (default)" },
    { id: "copy_code", label: "Copy code login (headless)" },
  ]);
  const prompts: string[] = [];

  await supervisor.login(workspace, PROVIDER, {
    onAuth: () => undefined,
    onPrompt: async (prompt) => {
      prompts.push(prompt.message);
      return "";
    },
  });

  assert.deepEqual(chosen, ["browser"]);
  assert.deepEqual(prompts, []);
});

await test("a sign-in choice without browser login still asks", async () => {
  const { supervisor, workspace, chosen } = await startSupervisor([
    { id: "work", label: "Work account" },
    { id: "personal", label: "Personal account" },
  ]);
  const prompts: string[] = [];

  await supervisor.login(workspace, PROVIDER, {
    onAuth: () => undefined,
    onPrompt: async (prompt) => {
      prompts.push(prompt.message);
      return "2";
    },
  });

  assert.deepEqual(chosen, ["personal"]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /1\. Work account\n2\. Personal account/);
});
