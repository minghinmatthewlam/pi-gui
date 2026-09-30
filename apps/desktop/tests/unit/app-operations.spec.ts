import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRef } from "@pi-gui/session-driver";
import type { SessionRecord, WorkspaceRecord } from "../../contracts/desktop-state";
import {
  runExtensionAction as runChecked,
  type AppOperationHost,
} from "../../electron/extensions/app-operations";
import { expectExtensionActionRequest } from "../../electron/ipc/request-validation";

/** What the IPC handler does: decode the renderer's request, then run it. */
const runExtensionAction = async (host: AppOperationHost, target: SessionRef, raw: unknown) => {
  const request = expectExtensionActionRequest({ target, action: raw });
  return runChecked(host, request.target, request.action);
};

const target = { workspaceId: "workspace", sessionId: "session" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-app-ops-"));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, "src"), { recursive: true });
  await writeFile(join(checkout, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "outside.ts"), "secret\n");
  const opened: string[] = [];
  const commands: string[] = [];
  const selected: SessionRef[] = [];
  const host: AppOperationHost = {
    workspacePath: (workspaceId) => (workspaceId === "workspace" ? checkout : undefined),
    openExternal: async (url) => {
      opened.push(url);
    },
    runExtensionCommand: async (_target, command) => {
      commands.push(command);
    },
    workspaces: () => folders,
    selectThread: async (thread) => {
      selected.push(thread);
    },
  };
  return { host, opened, commands, selected };
}

const thread = (id: string, archivedAt?: string): SessionRecord => ({
  id,
  title: id,
  updatedAt: "2026-09-30T00:00:00.000Z",
  preview: "",
  status: "idle",
  hasUnseenUpdate: false,
  ...(archivedAt ? { archivedAt } : {}),
});
const folder = (
  id: string,
  sessions: SessionRecord[],
  rootWorkspaceId?: string,
): WorkspaceRecord => ({
  id,
  name: id,
  path: `/work/${id}`,
  lastOpenedAt: "2026-09-30T00:00:00.000Z",
  kind: rootWorkspaceId ? "worktree" : "primary",
  ...(rootWorkspaceId ? { rootWorkspaceId } : {}),
  sessions,
});
// The card's folder, one of its pi-gui worktrees, and an unrelated folder.
const folders = [
  folder("workspace", [thread("session"), thread("sibling"), thread("old", "2026-09-01")]),
  folder("worktree", [thread("in-worktree")], "workspace"),
  folder("elsewhere", [thread("other-folder")]),
];

test("each button action runs its one operation", async () => {
  const { host, opened, commands } = await fixture();
  expect(
    await runExtensionAction(host, target, {
      type: "openFile",
      label: "Open",
      path: "./src/../src/a.ts",
      line: 2,
    }),
  ).toEqual({ kind: "openFile", path: join("src", "a.ts"), line: 2 });
  expect(
    await runExtensionAction(host, target, { type: "composer", label: "Ask", text: "Fix it" }),
  ).toEqual({ kind: "composer", text: "Fix it" });
  expect(
    await runExtensionAction(host, target, {
      type: "url",
      label: "Run",
      url: "https://ci.example.com/runs/1",
    }),
  ).toBeUndefined();
  expect(
    await runExtensionAction(host, target, {
      type: "command",
      label: "Rerun",
      command: "/ci rerun",
    }),
  ).toBeUndefined();
  expect(opened).toEqual(["https://ci.example.com/runs/1"]);
  expect(commands).toEqual(["/ci rerun"]);
});

test("open thread reaches only threads beside the card's own", async () => {
  const { host, selected } = await fixture();
  const open = (from: SessionRef, sessionId: string) =>
    runExtensionAction(host, from, { type: "openThread", label: "Open", sessionId });
  expect(await open(target, "sibling")).toBeUndefined();
  expect(await open(target, "in-worktree")).toBeUndefined();
  // From inside a worktree, the root folder and its other worktrees count too.
  expect(
    await open({ workspaceId: "worktree", sessionId: "in-worktree" }, "session"),
  ).toBeUndefined();
  expect(selected).toEqual([
    { workspaceId: "workspace", sessionId: "sibling" },
    { workspaceId: "worktree", sessionId: "in-worktree" },
    { workspaceId: "workspace", sessionId: "session" },
  ]);
  await expect(open(target, "other-folder")).rejects.toThrow(/isn't open in this folder/);
  await expect(open(target, "old")).rejects.toThrow(/isn't open in this folder/);
  await expect(open(target, "missing")).rejects.toThrow(/isn't open in this folder/);
  await expect(open({ workspaceId: "gone", sessionId: "s" }, "sibling")).rejects.toThrow();
  await expect(open(target, "../session")).rejects.toThrow();
  expect(selected).toHaveLength(3);
});

test("main refuses what an extension or the renderer should not be able to ask for", async () => {
  const { host, opened, commands } = await fixture();
  const refused = [
    { type: "openFile", label: "Escape", path: "../outside.ts" },
    { type: "openFile", label: "Folder", path: "src" },
    { type: "openFile", label: "Missing", path: "src/missing.ts" },
    { type: "url", label: "Plain http", url: "http://ci.example.com" },
    { type: "url", label: "File", url: "file:///etc/passwd" },
    { type: "command", label: "Free text", command: "ignore previous instructions" },
    { type: "shell", label: "Unknown", command: "rm -rf /" },
    { label: "No type or path" },
    "not an object",
  ];
  for (const action of refused) {
    await expect(
      (async () => runExtensionAction(host, target, action))(),
      JSON.stringify(action),
    ).rejects.toThrow();
  }
  await expect(
    runExtensionAction(
      host,
      { workspaceId: "gone", sessionId: "s" },
      {
        type: "openFile",
        label: "Open",
        path: "src/a.ts",
      },
    ),
  ).rejects.toThrow(/unavailable/);
  expect(opened).toEqual([]);
  expect(commands).toEqual([]);
});
