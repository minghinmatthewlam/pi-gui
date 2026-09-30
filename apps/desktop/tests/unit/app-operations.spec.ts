import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  expectExtensionAction,
  runExtensionAction as runChecked,
  type AppOperationHost,
} from "../../electron/extensions/app-operations";

/** What the IPC handler does: decode the renderer's request, then run it. */
const runExtensionAction = async (host: AppOperationHost, target: SessionRef, raw: unknown) =>
  runChecked(host, target, expectExtensionAction(raw));

const target = { workspaceId: "workspace", sessionId: "session" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-app-ops-"));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, "src"), { recursive: true });
  await writeFile(join(checkout, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "outside.ts"), "secret\n");
  const opened: string[] = [];
  const commands: string[] = [];
  const host: AppOperationHost = {
    workspacePath: (workspaceId) => (workspaceId === "workspace" ? checkout : undefined),
    openExternal: async (url) => {
      opened.push(url);
    },
    runExtensionCommand: async (_target, command) => {
      commands.push(command);
    },
  };
  return { host, opened, commands };
}

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
