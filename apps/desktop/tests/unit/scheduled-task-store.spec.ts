import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  readScheduledTasksFile,
  writeScheduledTasksFile,
} from "../../electron/scheduled-tasks/scheduled-task-store";
import type { ScheduledTaskRecord } from "../../contracts/scheduled-tasks";
import type { RpcPeer } from "../../rpc/rpc-peer";
import { startTestCorePeer, stopTestCoresAfterEach } from "../helpers/rust-core";

stopTestCoresAfterEach();

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

/** A fresh profile folder served by the Rust core, and its scheduled-tasks path. */
async function profile(): Promise<{ path: string; core: RpcPeer }> {
  const dir = await mkdtemp(join(tmpdir(), "scheduled-tasks-"));
  return { path: join(dir, "scheduled-tasks.json"), core: await startTestCorePeer(dir) };
}

for (const invalid of [
  { version: 2, tasks: [] },
  { version: 1, tasks: {}, extra: true },
  { version: 1, tasks: [{ ...validTask, futureField: true }] },
  { version: 1, tasks: "nope" },
  { version: 1, tasks: [{ ...validTask, status: "active", nextRunAt: undefined }] },
]) {
  test(`refuses invalid scheduled-tasks payload ${JSON.stringify(invalid)}`, async () => {
    const { path, core } = await profile();
    const original = `${JSON.stringify(invalid)}\n`;
    await writeFile(path, original);
    await expect(readScheduledTasksFile(core)).rejects.toThrow(/Invalid scheduled-tasks/);
    await expect(writeScheduledTasksFile(core, [validTask])).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });
}

test("active tasks without nextRunAt fail decode", async () => {
  const { path, core } = await profile();
  await writeFile(
    path,
    JSON.stringify({ version: 1, tasks: [{ ...validTask, nextRunAt: undefined }] }),
  );
  await expect(readScheduledTasksFile(core)).rejects.toThrow(/nextRunAt/);
});

test("invalid IANA time zones fail decode and do not overwrite the file", async () => {
  const { path, core } = await profile();
  const invalid = {
    version: 1,
    tasks: [
      {
        ...validTask,
        schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "Not/A_Zone" },
      },
    ],
  };
  const original = `${JSON.stringify(invalid)}\n`;
  await writeFile(path, original);
  await expect(readScheduledTasksFile(core)).rejects.toThrow(/Invalid scheduled-tasks/);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("round-trips a valid scheduled-tasks file", async () => {
  const { path, core } = await profile();
  await writeScheduledTasksFile(core, [validTask]);
  const loaded = await readScheduledTasksFile(core);
  expect(loaded.tasks).toEqual([validTask]);
  expect(loaded.recovered).toBe(false);
});
