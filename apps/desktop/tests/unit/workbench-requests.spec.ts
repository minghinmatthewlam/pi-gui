import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver/types";
import {
  decodeTaskWorkbenchTemplate,
  toolRefId,
  type TaskWorkbenchTemplate,
} from "../../contracts/workbench";
import { WorkbenchRequests, type WorkbenchOwner } from "../../electron/ipc/workbench-requests";

const firstTask = { workspaceId: "repo", sessionId: "first" };
const secondTask = { workspaceId: "repo", sessionId: "second" };

function template(kind: "files" | "changes" | "terminal" = "changes"): TaskWorkbenchTemplate {
  return {
    visibility: "visible",
    tools: [{ kind }],
    selection: { kind: "tool", toolId: kind },
    files: {
      workspaceId: "repo",
      tabs: { tabs: [], active: null, line: null, lineNonce: 0, retained: [] },
    },
    changes: { workspaceId: "repo", selectedPath: null },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownerFixture(beforeSave?: () => Promise<void>) {
  const saved = new Map<string, TaskWorkbenchTemplate>();
  const writes: { target: SessionRef; template: TaskWorkbenchTemplate }[] = [];
  const owner: WorkbenchOwner = {
    async getTaskWorkbenchTemplate(target) {
      return structuredClone(saved.get(JSON.stringify(target)) ?? null);
    },
    async saveTaskWorkbenchTemplate(target, value) {
      await beforeSave?.();
      saved.set(JSON.stringify(target), structuredClone(value));
      writes.push({ target, template: value });
    },
  };
  return { requests: new WorkbenchRequests(owner), writes };
}

test("saves stay bound to their explicit task and stale renderer sequences cannot replace them", async () => {
  const { requests, writes } = ownerFixture();
  const sender = {};
  await Promise.all([
    requests.save(sender, { target: firstTask, template: template("files"), sequence: 2 }),
    requests.save(sender, { target: firstTask, template: template("changes"), sequence: 1 }),
    requests.save(sender, { target: secondTask, template: template("terminal"), sequence: 3 }),
    requests.save(sender, { target: secondTask, template: template("changes"), sequence: 3 }),
  ]);
  expect(writes.map(({ target }) => target)).toEqual([firstTask, secondTask]);
  expect(await requests.get(firstTask)).toEqual(template("files"));
  expect(await requests.get(secondTask)).toEqual(template("terminal"));
});

test("windows sequence independently while host writes serialize in receipt order", async () => {
  const gate = deferred();
  let callCount = 0;
  const { requests, writes } = ownerFixture(async () => {
    callCount += 1;
    if (callCount === 1) await gate.promise;
  });
  const firstWindow = {};
  const firstWindowSave = requests.save(firstWindow, {
    target: firstTask,
    template: template("files"),
    sequence: 42,
  });
  const firstWindowNextSave = requests.save(firstWindow, {
    target: firstTask,
    template: template("changes"),
    sequence: 43,
  });
  const secondWindowSave = requests.save(
    {},
    { target: firstTask, template: template("terminal"), sequence: 1 },
  );
  await Promise.resolve();
  expect(callCount).toBe(1);
  expect(writes).toHaveLength(0);
  gate.resolve();
  await Promise.all([firstWindowSave, firstWindowNextSave, secondWindowSave]);
  expect(writes.map(({ template }) => template.selection)).toEqual([
    { kind: "tool", toolId: "files" },
    { kind: "tool", toolId: "changes" },
    { kind: "tool", toolId: "terminal" },
  ]);
  expect(await requests.get(firstTask)).toEqual(template("terminal"));
});

test("reload cancels a former renderer's queued saves and accepts a fresh sequence", async () => {
  const gate = deferred();
  const started = deferred();
  let callCount = 0;
  const { requests, writes } = ownerFixture(async () => {
    callCount += 1;
    if (callCount === 1) {
      started.resolve();
      await gate.promise;
    }
  });
  const sender = {};
  const firstSave = requests.save({}, { target: secondTask, template: template(), sequence: 1 });
  await started.promise;
  const oldSave = requests.save(sender, {
    target: firstTask,
    template: template("files"),
    sequence: 100,
  });
  requests.resetRenderer(sender);
  const reloadedSave = requests.save(sender, {
    target: firstTask,
    template: template("terminal"),
    sequence: 1,
  });
  gate.resolve();
  await Promise.all([firstSave, oldSave, reloadedSave]);
  expect(writes).toHaveLength(2);
  expect(await requests.get(firstTask)).toEqual(template("terminal"));
});

test("write errors do not poison later saves or independent template reads", async () => {
  let failNext = true;
  const { requests } = ownerFixture(async () => {
    if (failNext) {
      failNext = false;
      throw new Error("disk unavailable");
    }
  });
  const sender = {};
  await expect(
    requests.save(sender, { target: firstTask, template: template("files"), sequence: 1 }),
  ).rejects.toThrow("disk unavailable");
  expect(await requests.get(firstTask)).toBeNull();
  await requests.save(sender, { target: firstTask, template: template("terminal"), sequence: 2 });
  const firstWindow = await requests.get(firstTask);
  await requests.save({}, { target: firstTask, template: template("changes"), sequence: 1 });
  expect(firstWindow).toEqual(template("terminal"));
  expect(await requests.get(firstTask)).toEqual(template("changes"));
});

test("workbench boundary accepts unavailable extension references but rejects content and malformed saves", async () => {
  const extension = { kind: "extension" as const, extensionId: "review", viewId: "findings" };
  const extensionTemplate = {
    ...template(),
    tools: [extension],
    selection: { kind: "tool" as const, toolId: toolRefId(extension) },
  };
  expect(decodeTaskWorkbenchTemplate(extensionTemplate)).toEqual(extensionTemplate);
  const { requests } = ownerFixture();
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => requests.save({}, { target: firstTask, template: template(), sequence })).toThrow(
      /positive safe integer/,
    );
  }
  expect(() =>
    requests.save({}, { target: { workspaceId: "repo" }, template: template(), sequence: 1 }),
  ).toThrow(/sessionId/);
  expect(() =>
    requests.save({}, { target: firstTask, template: template(), sequence: 1, content: "bytes" }),
  ).toThrow(/unsupported field/);
  expect(() =>
    decodeTaskWorkbenchTemplate({ ...template(), tools: [{ kind: "terminal", ptyId: "live" }] }),
  ).toThrow(/unsupported field/);
  expect(() =>
    decodeTaskWorkbenchTemplate({
      ...template(),
      files: { ...template().files, content: "bytes" },
    }),
  ).toThrow(/unsupported field/);
  expect(() =>
    decodeTaskWorkbenchTemplate({
      ...template(),
      changes: { workspaceId: "repo", selectedPath: "x".repeat(4097) },
    }),
  ).toThrow(/oversized reference/);
  expect(await requests.get(firstTask)).toBeNull();
});
