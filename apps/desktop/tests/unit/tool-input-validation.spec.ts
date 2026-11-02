import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { createJiti } from "jiti";
import type {
  CreateScheduledTaskInput,
  ScheduledTaskSchedule,
} from "../../contracts/scheduled-tasks";
import {
  createOrchestrationRuntimeTools,
  type OrchestrationRuntimeBridge,
} from "../../electron/orchestration/orchestration-runtime";
import {
  createScheduledTaskRuntimeTools,
  type ScheduledTaskRuntimeBridge,
  type ScheduledTaskToolUpdate,
} from "../../electron/scheduled-tasks/scheduled-task-runtime";

// pi checks every tool call against the tool's JSON Schema (validateToolArguments) before the
// tool runs. These tests send model-style arguments through that same check and then into
// pi-gui's own tools, so a pi update that changes the check shows up here.

// The desktop Playwright harness uses CommonJS; pi-ai's public entry is ESM-only.
const jiti = createJiti(__filename);
let validateToolArguments: typeof import("@earendil-works/pi-ai").validateToolArguments;
test.beforeAll(async () => {
  ({ validateToolArguments } =
    await jiti.import<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai"));
});

interface BridgeCalls {
  readonly createChildThread: string[];
  readonly listThreads: { readonly workspace?: string }[];
  readonly readThread: string[];
  readonly sendMessageToThread: { readonly threadId: string; readonly message: string }[];
  readonly archiveChildThreads: (readonly string[])[];
  readonly createScheduledTask: CreateScheduledTaskInput[];
  readonly updateScheduledTask: ScheduledTaskToolUpdate[];
}

function recordingTools() {
  const calls: BridgeCalls = {
    createChildThread: [],
    listThreads: [],
    readThread: [],
    sendMessageToThread: [],
    archiveChildThreads: [],
    createScheduledTask: [],
    updateScheduledTask: [],
  };
  const done = { content: [{ type: "text" as const, text: "ok" }], details: {} as never };
  const orchestration: OrchestrationRuntimeBridge = {
    createChildThread: async (_ctx, input) => (calls.createChildThread.push(input.prompt), done),
    listThreads: async (_ctx, input) => (calls.listThreads.push(input), done),
    readThread: async (_ctx, threadId) => (calls.readThread.push(threadId), done),
    sendMessageToThread: async (_ctx, input) => (calls.sendMessageToThread.push(input), done),
    archiveChildThreads: async (_ctx, ids) => (calls.archiveChildThreads.push(ids), done),
  };
  const scheduled: ScheduledTaskRuntimeBridge = {
    createScheduledTask: async (_ctx, input) => (calls.createScheduledTask.push(input), done),
    listScheduledTasks: async () => done,
    updateScheduledTask: async (_ctx, input) => (calls.updateScheduledTask.push(input), done),
  };
  const tools: readonly ToolDefinition<any, unknown>[] = [
    ...createOrchestrationRuntimeTools(orchestration),
    ...createScheduledTaskRuntimeTools(scheduled, () => "ws-1"),
  ];

  /** Runs one model tool call the way pi does: check the arguments, then execute the tool. */
  async function call(name: string, args: Record<string, unknown>) {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) {
      throw new Error(`missing tool ${name}`);
    }
    const checked: unknown = validateToolArguments(tool, {
      type: "toolCall",
      id: "call-1",
      name,
      arguments: args,
    });
    return tool.execute("call-1", checked, undefined, undefined, {} as never);
  }

  return { calls, tools, call };
}

test("pi accepts a normal call to every pi-gui tool and the tool receives it unchanged", async () => {
  const { calls, tools, call } = recordingTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "archive_child_threads",
    "create_child_thread",
    "create_scheduled_task",
    "list_scheduled_tasks",
    "list_threads",
    "read_thread",
    "send_message_to_thread",
    "update_scheduled_task",
  ]);

  await call("create_child_thread", { prompt: "Write the tests" });
  await call("list_threads", { workspace: "*" });
  await call("read_thread", { thread_id: "child-1" });
  await call("send_message_to_thread", { thread_id: "child-1", message: "Also docs" });
  await call("archive_child_threads", { thread_ids: ["child-1", "child-2"] });
  await call("create_scheduled_task", {
    title: "Standup",
    instruction: "Summarize yesterday",
    repeat: "weekly",
    days: ["mon", "wed"],
    time: "09:30",
    timezone: "UTC",
  });
  await call("list_scheduled_tasks", {});
  await call("update_scheduled_task", { task_id: "task-1", status: "paused" });

  expect(calls.createChildThread).toEqual(["Write the tests"]);
  expect(calls.listThreads).toEqual([{ workspace: "*" }]);
  expect(calls.readThread).toEqual(["child-1"]);
  expect(calls.sendMessageToThread).toEqual([{ threadId: "child-1", message: "Also docs" }]);
  expect(calls.archiveChildThreads).toEqual([["child-1", "child-2"]]);
  expect(calls.createScheduledTask[0]?.schedule).toEqual({
    kind: "weekly",
    days: [1, 3],
    hour: 9,
    minute: 30,
    timeZone: "UTC",
  } satisfies ScheduledTaskSchedule);
  expect(calls.updateScheduledTask[0]).toMatchObject({
    taskId: "task-1",
    patch: { status: "paused" },
  });
});

test("loosely typed model arguments are corrected before pi-gui's tools see them", async () => {
  const { calls, call } = recordingTools();

  await call("create_scheduled_task", {
    title: "Ping",
    instruction: "Check the build",
    repeat: "interval",
    every_minutes: "15",
  });
  await call("create_scheduled_task", {
    title: "Weekly",
    instruction: "Plan the week",
    repeat: "weekly",
    days: "mon",
    time: "08:00",
    timezone: "UTC",
  });
  await call("list_threads", { workspace: null });
  await call("archive_child_threads", { thread_ids: "child-1" });

  expect(calls.createScheduledTask.map((input) => input.schedule)).toEqual([
    { kind: "interval", everyMs: 15 * 60_000 },
    { kind: "weekly", days: [1], hour: 8, minute: 0, timeZone: "UTC" },
  ]);
  expect(calls.listThreads).toEqual([{}]);
  expect(calls.archiveChildThreads).toEqual([["child-1"]]);
});

test("pi rejects calls missing what a pi-gui tool requires, and the tool never runs", async () => {
  const { calls, call } = recordingTools();
  const rejected = [
    ["create_child_thread", {}, "prompt"],
    ["read_thread", { threadId: "child-1" }, "thread_id"],
    ["send_message_to_thread", { thread_id: "child-1" }, "message"],
    ["archive_child_threads", { thread_ids: [] }, "thread_ids"],
    ["create_scheduled_task", { title: "No schedule", instruction: "x" }, "repeat"],
    [
      "create_scheduled_task",
      { title: "t", instruction: "x", repeat: "interval", every_minutes: "soon" },
      "every_minutes",
    ],
    ["update_scheduled_task", { status: "paused" }, "task_id"],
  ] as const;

  for (const [name, args, field] of rejected) {
    await expect(call(name, args), `${name} ${JSON.stringify(args)}`).rejects.toThrow(
      new RegExp(`Validation failed for tool "${name}":\\n  - ${field}: `),
    );
  }
  expect(Object.values(calls).flat()).toEqual([]);
});
