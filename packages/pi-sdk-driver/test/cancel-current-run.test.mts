import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent, SessionStatus } from "@pi-gui/session-driver";
import { SessionSupervisor } from "../dist/index.js";

interface FakeControl {
  promptCalls: number;
  abortCalls: number;
  disposeCalls: number;
  prompt: "hang" | "reject" | "resolve";
  abort: "hang" | "reject" | "resolve";
}

function createFakeRuntime(control: FakeControl) {
  return async (options?: {
    sessionManager?: SessionManager;
    cwd?: string;
  }): Promise<AgentSessionRuntime> => {
    const sessionManager =
      options?.sessionManager ?? SessionManager.create(options?.cwd ?? process.cwd());
    const session = {
      sessionId: sessionManager.getSessionId(),
      sessionManager,
      sessionFile: sessionManager.getSessionFile(),
      sessionName: undefined,
      isStreaming: false,
      messages: [],
      promptTemplates: [],
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      agent: { waitForIdle: async () => undefined, state: {} },
      subscribe: () => () => undefined,
      bindExtensions: async () => undefined,
      dispose: () => undefined,
      clearQueue: () => undefined,
      prompt: async () => {
        control.promptCalls += 1;
        if (control.prompt === "hang") {
          return new Promise(() => {});
        }
        if (control.prompt === "reject") {
          throw new Error("injected prompt failure");
        }
      },
      abort: async () => {
        control.abortCalls += 1;
        if (control.abort === "hang") {
          return new Promise(() => {});
        }
        if (control.abort === "reject") {
          throw new Error("injected abort failure");
        }
      },
    } as unknown as AgentSession;

    return {
      session,
      setRebindSession: () => undefined,
      dispose: async () => {
        control.disposeCalls += 1;
      },
    } as unknown as AgentSessionRuntime;
  };
}

async function withSupervisor(
  control: FakeControl,
  fn: (
    supervisor: SessionSupervisor,
    sessionRef: { workspaceId: string; sessionId: string },
  ) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cancel-run-"));
  try {
    const workspacePath = join(dir, "workspace");
    await mkdir(workspacePath);
    const supervisor = new SessionSupervisor({
      catalogFilePath: join(dir, "catalogs.json"),
      createAgentSessionRuntimeImpl: createFakeRuntime(control),
      abortTimeoutMs: 80,
    });
    const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");
    const snapshot = await supervisor.createSession(workspace, { title: "Hang session" });
    await fn(supervisor, snapshot.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function latestStatus(events: SessionDriverEvent[]): SessionStatus | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "sessionUpdated" ||
      event?.type === "sessionOpened" ||
      event?.type === "runCompleted"
    ) {
      return event.snapshot.status;
    }
    if (event?.type === "runFailed") {
      return "failed";
    }
  }
  return undefined;
}

await test("sendUserMessage returns while prompt is still in flight", async () => {
  const control: FakeControl = {
    promptCalls: 0,
    abortCalls: 0,
    disposeCalls: 0,
    prompt: "hang",
    abort: "resolve",
  };
  await withSupervisor(control, async (supervisor, sessionRef) => {
    const started = Date.now();
    await supervisor.sendUserMessage(sessionRef, { text: "follow-up that never ends" });
    assert.ok(Date.now() - started < 500);
    assert.equal(control.promptCalls, 1);
    const listing = await supervisor.listSessions(sessionRef.workspaceId);
    assert.equal(listing.sessions[0]?.status, "running");
  });
});

await test("cancelCurrentRun aborts an in-flight hanging prompt within a short bound", async () => {
  const control: FakeControl = {
    promptCalls: 0,
    abortCalls: 0,
    disposeCalls: 0,
    prompt: "hang",
    abort: "resolve",
  };
  await withSupervisor(control, async (supervisor, sessionRef) => {
    const events: SessionDriverEvent[] = [];
    supervisor.subscribe(sessionRef, (event) => {
      events.push(event);
    });
    await supervisor.sendUserMessage(sessionRef, { text: "never-resolving prompt" });
    const started = Date.now();
    const outcome = await supervisor.cancelCurrentRun(sessionRef);
    assert.ok(Date.now() - started < 500);
    assert.equal(outcome, "stopped");
    assert.equal(control.abortCalls, 1);
    assert.equal(latestStatus(events), "idle");
  });
});

await test("never-resolving abort quarantines and does not report idle", async () => {
  const control: FakeControl = {
    promptCalls: 0,
    abortCalls: 0,
    disposeCalls: 0,
    prompt: "hang",
    abort: "hang",
  };
  await withSupervisor(control, async (supervisor, sessionRef) => {
    const events: SessionDriverEvent[] = [];
    supervisor.subscribe(sessionRef, (event) => {
      events.push(event);
    });
    await supervisor.sendUserMessage(sessionRef, { text: "never-resolving prompt" });
    const started = Date.now();
    const outcome = await supervisor.cancelCurrentRun(sessionRef);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(outcome, "quarantined");
    assert.equal(control.abortCalls, 1);
    assert.ok(control.disposeCalls >= 1);
    assert.equal(latestStatus(events), "failed");
    assert.notEqual(latestStatus(events), "idle");
    const failed = events.find((event) => event.type === "runFailed");
    assert.equal(failed?.type === "runFailed" ? failed.error.code : undefined, "ABORT_TIMEOUT");
  });
});

await test("rejecting abort quarantines and does not report idle", async () => {
  const control: FakeControl = {
    promptCalls: 0,
    abortCalls: 0,
    disposeCalls: 0,
    prompt: "hang",
    abort: "reject",
  };
  await withSupervisor(control, async (supervisor, sessionRef) => {
    const events: SessionDriverEvent[] = [];
    supervisor.subscribe(sessionRef, (event) => {
      events.push(event);
    });
    await supervisor.sendUserMessage(sessionRef, { text: "never-resolving prompt" });
    const outcome = await supervisor.cancelCurrentRun(sessionRef);
    assert.equal(outcome, "quarantined");
    assert.equal(latestStatus(events), "failed");
    const failed = events.find((event) => event.type === "runFailed");
    assert.equal(failed?.type === "runFailed" ? failed.error.code : undefined, "ABORT_FAILED");
  });
});
