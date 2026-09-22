import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { SessionSupervisor } from "../dist/session-supervisor.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";
import {
  displayMessagesFromSession,
  transcriptFromMessages,
} from "../dist/session-supervisor-utils.js";
import { forcePersistPiSession } from "../dist/compat/pi-session-persistence.js";

const assistant = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-completions" as const,
  provider: "fixture",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: Date.now(),
});

await test("model context edits preserve original desktop history and fork targets on live and reopened sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-edit-transcript-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspacePath);
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const runtimes: AgentSessionRuntime[] = [];
  const supervisor = new SessionSupervisor({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (options) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback(options);
      runtimes.push(runtime);
      return runtime;
    },
  });
  const workspace = await supervisor.registerWorkspace(workspacePath);
  const snapshot = await supervisor.createSession(workspace);
  const session = runtimes[0]!.session;
  const manager = session.sessionManager;
  const userId = manager.appendMessage({
    role: "user",
    content: "original question",
    timestamp: Date.now(),
  });
  const answerId = manager.appendMessage(assistant("original answer"));
  manager.appendContextEdit(userId, null);
  manager.appendContextEdit(answerId, { content: "replacement for model only" });
  session.refreshContext();
  forcePersistPiSession(manager);

  assert.equal(
    session.messages.some((message) => message.role === "user"),
    false,
  );
  assert.match(JSON.stringify(session.messages), /replacement for model only/);
  const expected = [
    { id: userId, text: "original question" },
    { id: answerId, text: "original answer" },
  ];
  const readVisible = async () =>
    (await supervisor.getTranscript(snapshot.ref))
      .filter((item) => item.kind === "message")
      .map((item) => ({ id: item.id, text: item.text }));
  assert.deepEqual(await readVisible(), expected);
  assert.deepEqual(await readVisible(), expected, "live reads retain the same original content");
  await supervisor.validateForkSession(snapshot.ref, {
    targetWorkspace: workspace,
    sourceMessageId: answerId,
  });
  await supervisor.validateForkSession(snapshot.ref, {
    targetWorkspace: workspace,
    sourceMessageIndex: 1,
  });
  await supervisor.validateForkSession(snapshot.ref, {
    targetWorkspace: workspace,
    userMessageIndex: 0,
  });
  const fork = await supervisor.forkSession(snapshot.ref, {
    targetWorkspace: workspace,
    sourceMessageId: answerId,
    position: "at",
  });
  assert.deepEqual(
    (await supervisor.getTranscript(fork.snapshot.ref))
      .filter((item) => item.kind === "message")
      .map((item) => ({ id: item.id, text: item.text })),
    expected,
  );
  await supervisor.closeSession(fork.snapshot.ref);
  await supervisor.closeSession(snapshot.ref);
  assert.deepEqual(
    await readVisible(),
    expected,
    "closed-session disk reads use the same display projection",
  );
  await supervisor.openSession(snapshot.ref);
  assert.deepEqual(await readVisible(), expected);
  await supervisor.closeSession(snapshot.ref);
});

await test("display projection preserves compaction ranges and original tool results", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "summarized question", timestamp: Date.now() });
  const keptId = manager.appendMessage({
    role: "user",
    content: "kept question",
    timestamp: Date.now(),
  });
  const call = assistant("");
  manager.appendMessage({
    ...call,
    content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } }],
  });
  const toolId = manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "read",
    content: [{ type: "text", text: "original tool content" }],
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendCompaction("first summary", keptId, 1000);
  manager.appendCompaction("latest summary", keptId, 2000);
  manager.appendContextEdit(toolId, { content: "redacted model content" });
  const transcript = transcriptFromMessages(displayMessagesFromSession(manager));
  assert.equal(
    transcript.some((item) => item.kind === "message" && item.text === "summarized question"),
    false,
  );
  const summaries = transcript.filter(
    (item) => item.kind === "message" && item.role === "compactionSummary",
  );
  assert.equal(summaries.length, 1);
  const summary = summaries[0];
  assert.ok(summary?.kind === "message");
  assert.match(summary.text, /latest summary/);
  const tool = transcript.find((item) => item.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  assert.match(JSON.stringify(tool.output), /original tool content/);
  assert.doesNotMatch(JSON.stringify(tool.output), /redacted model content/);
});
