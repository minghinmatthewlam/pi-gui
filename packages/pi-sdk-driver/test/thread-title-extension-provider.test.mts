import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";

/**
 * Thread titles come from a separate session that loads no extensions. Its
 * model must still resolve through the providers the workspace's extensions
 * registered, or every workspace whose provider comes from an extension (for
 * example one that routes a built-in provider through a proxy) keeps the
 * "New thread" placeholder.
 */

interface RecordedRequest {
  readonly path: string;
  readonly authorization: string | undefined;
}

async function startTitleServer(title: string): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly RecordedRequest[];
  readonly close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finishReason: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            id: "title",
            object: "chat.completion.chunk",
            model: "title",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      chunk({ role: "assistant", content: title }, null);
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function providerExtensionSource(providerId: string, baseUrl: string, apiKey: string): string {
  return `export default async function providerExtension(pi) {
  pi.registerProvider(${JSON.stringify(providerId)}, {
    baseUrl: ${JSON.stringify(baseUrl)},
    apiKey: ${JSON.stringify(apiKey)},
    api: "openai-completions",
    models: [
      {
        id: "title-model",
        name: "Title model",
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

async function makeAgentDir(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-thread-title-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  return { root, agentDir };
}

async function makeWorkspaceDir(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, ".pi", "extensions"), { recursive: true });
  await writeFile(join(path, ".pi", "extensions", "provider.ts"), source);
  return path;
}

await test("generates a thread title through a provider a workspace extension registered", async () => {
  const server = await startTitleServer("Fix title generation");
  try {
    const { root, agentDir } = await makeAgentDir();
    const path = await makeWorkspaceDir(
      root,
      "workspace",
      providerExtensionSource("ext-provider", `${server.baseUrl}/v1`, "EXT_KEY"),
    );
    const driver = new PiSdkDriver({ agentDir, catalogFilePath: join(root, "catalogs.json") });
    const { workspace } = await driver.syncWorkspace(path);

    const title = await driver.generateThreadTitle(workspace, {
      prompt: "Thread titles never appear when my provider comes from an extension",
      model: { provider: "ext-provider", modelId: "title-model" },
    });

    assert.equal(title, "Fix title generation");
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.path, "/v1/chat/completions");
    assert.equal(server.requests[0]?.authorization, "Bearer EXT_KEY");
  } finally {
    await server.close();
  }
});

await test("a thread title uses the provider its own workspace registered", async () => {
  const serverA = await startTitleServer("Title from A");
  const serverB = await startTitleServer("Title from B");
  try {
    const { root, agentDir } = await makeAgentDir();
    const pathA = await makeWorkspaceDir(
      root,
      "workspace-a",
      providerExtensionSource("shared-id", `${serverA.baseUrl}/v1`, "KEY_A"),
    );
    const pathB = await makeWorkspaceDir(
      root,
      "workspace-b",
      providerExtensionSource("shared-id", `${serverB.baseUrl}/v1`, "KEY_B"),
    );
    const driver = new PiSdkDriver({ agentDir, catalogFilePath: join(root, "catalogs.json") });
    const { workspace: workspaceA } = await driver.syncWorkspace(pathA);
    const { workspace: workspaceB } = await driver.syncWorkspace(pathB);
    await driver.runtimeSupervisor.getRuntimeSnapshot(workspaceA);
    await driver.runtimeSupervisor.getRuntimeSnapshot(workspaceB);

    const title = await driver.generateThreadTitle(workspaceA, {
      prompt: "Which endpoint answers this title request",
      model: { provider: "shared-id", modelId: "title-model" },
    });

    assert.equal(title, "Title from A");
    assert.equal(serverA.requests.length, 1);
    assert.equal(serverA.requests[0]?.authorization, "Bearer KEY_A");
    assert.equal(serverB.requests.length, 0);
  } finally {
    await serverA.close();
    await serverB.close();
  }
});
