import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalPanelSnapshot,
} from "../../contracts/ipc";
import { appendTerminalReplay } from "../../contracts/terminal-model";
import { startCore, type CoreProcess } from "../../core-process/launch";
import { coreMethods, coreNotifications } from "../../core-process/protocol";

/**
 * The integrated terminal runs in the Rust core. This drives a real shell through the same
 * calls and notifications main uses, and checks the core's replay against the renderer's
 * `appendTerminalReplay` over the same output.
 * Needs `pnpm --filter @pi-gui/desktop run build:core` first (part of `pnpm build`).
 */

test.skip(process.platform === "win32", "Uses /bin/sh");

const binaryPath = join(__dirname, "..", "..", "build", "native", "pi-gui-core");

let dir: string;
let core: CoreProcess;

test.beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "pi-gui-core-terminal-")));
  core = await startCore({
    binaryPath,
    initialize: { userDataDir: dir },
    onUnexpectedExit: (detail) => {
      throw new Error(`pi-gui-core exited: ${detail}`);
    },
  });
});

test.afterEach(async () => {
  await core?.stop(1_000);
  await rm(dir, { recursive: true, force: true });
});

test("a shell's output, replay and exit reach the window that owns it", async () => {
  const data: (TerminalDataEvent & { ownerId: number })[] = [];
  let exit: (TerminalExitEvent & { ownerId: number }) | undefined;
  core.peer.onNotification(coreNotifications.terminalData, (params) => {
    data.push(params as TerminalDataEvent & { ownerId: number });
  });
  core.peer.onNotification(coreNotifications.terminalExit, (params) => {
    exit = params as TerminalExitEvent & { ownerId: number };
  });

  const params = {
    ownerId: 3,
    workspaceId: "w1",
    workspacePath: dir,
    terminalScopeId: "thread-1",
    size: { cols: 100, rows: 30 },
    shell: "/bin/sh",
  };
  const panel = (await core.peer.request(
    coreMethods.terminalEnsurePanel,
    params,
  )) as TerminalPanelSnapshot;
  expect(panel.rootKey).toBe(`3\0${dir}\0thread-1`);
  expect(panel.sessions).toHaveLength(1);
  const terminalId = panel.activeSessionId;
  expect(panel.sessions[0]).toMatchObject({
    id: terminalId,
    workspaceId: "w1",
    cwd: dir,
    shell: "/bin/sh",
    title: "Terminal 1",
    status: "running",
    truncated: false,
  });

  // Another window cannot reach this shell.
  await expect(
    core.peer.request(coreMethods.terminalWrite, { ownerId: 4, terminalId, data: "x" }),
  ).rejects.toThrow(`Unknown terminal session: ${terminalId}`);

  await core.peer.request(coreMethods.terminalWrite, {
    ownerId: 3,
    terminalId,
    // Multi-byte output, so characters split across reads are decoded whole.
    data: "i=0; while [ $i -lt 300 ]; do printf 'é😀%s ' $i; i=$((i+1)); done; exit 5\n",
  });
  await expect.poll(() => exit, { timeout: 10_000 }).toBeDefined();
  expect(exit).toEqual({ ownerId: 3, terminalId, exitCode: 5, signal: 0 });
  expect(data.every((event) => event.ownerId === 3 && event.terminalId === terminalId)).toBe(true);
  const output = data.map((event) => event.data).join("");
  expect(output).toContain("é😀299 ");
  expect(output).not.toContain("\uFFFD");

  const after = (await core.peer.request(
    coreMethods.terminalEnsurePanel,
    params,
  )) as TerminalPanelSnapshot;
  let expected = { replay: "", truncated: false };
  for (const event of data) {
    expected = appendTerminalReplay(expected.replay, event.data, expected.truncated);
  }
  expect(after.sessions[0]).toMatchObject({
    status: "exited",
    exitCode: 5,
    signal: 0,
    replay: expected.replay,
    truncated: false,
  });
});
