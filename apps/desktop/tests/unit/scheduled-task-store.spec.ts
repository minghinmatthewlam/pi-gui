import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  decodeScheduledTasksFile,
  readScheduledTasksFile,
  writeScheduledTasksFile,
} from "../../electron/scheduled-tasks/scheduled-task-store";
import type { ScheduledTaskRecord } from "../../contracts/scheduled-tasks";

const validTask: ScheduledTaskRecord = {
  id: "task-1",
  title: "Ping",
  instruction: "Say ping",
  status: "active",
  schedule: { kind: "interval", everyMs: 60_000 },
  target: { kind: "new-thread", workspaceId: "ws" },
  createdAt: "2026-09-21T12:00:00.000Z",
  updatedAt: "2026-09-21T12:00:00.000Z",
  nextRunAt: "2026-09-21T12:01:00.000Z",
  runs: [],
};

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "scheduled-tasks-")), "scheduled-tasks.json");
}

for (const invalid of [
  { version: 2, tasks: [] },
  { version: 1, tasks: {}, extra: true },
  { version: 1, tasks: [{ ...validTask, futureField: true }] },
  { version: 1, tasks: "nope" },
  { version: 1, tasks: [{ ...validTask, status: "active", nextRunAt: undefined }] },
]) {
  test(`refuses invalid scheduled-tasks payload ${JSON.stringify(invalid)}`, async () => {
    const path = await tempPath();
    const original = `${JSON.stringify(invalid)}\n`;
    await writeFile(path, original);
    await expect(readScheduledTasksFile(path)).rejects.toThrow(/Invalid scheduled-tasks/);
    await expect(writeScheduledTasksFile(path, [validTask])).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });
}

test("active tasks without nextRunAt fail decode", () => {
  expect(() =>
    decodeScheduledTasksFile({
      version: 1,
      tasks: [{ ...validTask, nextRunAt: undefined }],
    }),
  ).toThrow(/nextRunAt/);
});

test("round-trips a valid scheduled-tasks file", async () => {
  const path = await tempPath();
  await writeScheduledTasksFile(path, [validTask]);
  const loaded = await readScheduledTasksFile(path);
  expect(loaded.tasks).toEqual([validTask]);
  expect(loaded.recovered).toBe(false);
});
