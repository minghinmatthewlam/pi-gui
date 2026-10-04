import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ComposerAttachment } from "../../contracts/desktop-state";
import type { ScheduledTaskRecord } from "../../contracts/scheduled-tasks";
import {
  readPersistedUiState,
  writePersistedUiState,
  type PersistedUiState,
} from "../../electron/persistence/app-store-persistence";
import { AttachmentStore } from "../../electron/persistence/attachment-store";
import {
  readScheduledTasksFile,
  writeScheduledTasksFile,
} from "../../electron/scheduled-tasks/scheduled-task-store";
import { ReviewedStore } from "../../electron/workbench/reviewed-store";
import type { RpcPeer } from "../../rpc/rpc-peer";
import { startTestCore, stopTestCoresAfterEach } from "./rust-core-process";
import * as oracleUiState from "./saved-data-oracle/app-store-persistence";
import { AttachmentStore as OracleAttachmentStore } from "./saved-data-oracle/attachment-store";
import { ReviewedStore as OracleReviewedStore } from "./saved-data-oracle/reviewed-store";
import * as oracleTasks from "./saved-data-oracle/scheduled-task-store";

/**
 * The Rust core replaced the TypeScript ui-state, attachment, scheduled-task and review-mark
 * stores. Here the old code (kept in `saved-data-oracle/`) and the core run side by side on
 * the same files and calls, and must give the same answers, the same errors and leave the
 * same files behind. Needs `pnpm --filter @pi-gui/desktop run build:core` first.
 */

stopTestCoresAfterEach();

interface Pair {
  readonly typescript: string;
  readonly rust: string;
  readonly core: RpcPeer;
}

async function pair(): Promise<Pair> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-core-saved-data-"));
  const typescript = join(root, "typescript");
  const rust = join(root, "rust");
  await mkdir(typescript);
  await mkdir(rust);
  return { typescript, rust, core: await startTestCore(rust) };
}

/** Writes the same files into both profile folders. */
async function seed(dirs: Pair, files: Record<string, string | undefined>) {
  for (const dir of [dirs.typescript, dirs.rust]) {
    for (const [name, contents] of Object.entries(files)) {
      if (contents === undefined) continue;
      await mkdir(join(dir, name, ".."), { recursive: true });
      await writeFile(join(dir, name), contents);
    }
  }
}

type Outcome = { readonly value: unknown } | { readonly error: string; readonly code?: unknown };

async function outcome(dir: string, run: () => Promise<unknown>): Promise<Outcome> {
  try {
    const value = await run();
    // Compare what JSON carries: the app reads the core's answers as JSON.
    return {
      value: value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown),
    };
  } catch (error) {
    const failure = error as Error & { code?: unknown };
    return {
      error: failure.message.split(dir).join("<dir>"),
      ...(failure.code ? { code: failure.code } : {}),
    };
  }
}

async function same(
  dirs: Pair,
  label: string,
  typescript: () => Promise<unknown>,
  rust: () => Promise<unknown>,
) {
  const expected = await outcome(dirs.typescript, typescript);
  const actual = await outcome(dirs.rust, rust);
  expect(actual, label).toEqual(expected);
  return actual;
}

/** Every file in a profile folder with its bytes; random ids in names are blanked. */
async function files(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (folder: string, prefix: string) => {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name);
      const key = `${prefix}${name}`.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        "<uuid>",
      );
      if ((await stat(path)).isDirectory()) await walk(path, `${key}/`);
      else found[key] = (found[key] ?? "") + (await readFile(path, "utf8"));
    }
  };
  await walk(dir, "");
  return found;
}

async function sameFiles(dirs: Pair, label: string) {
  expect(await files(dirs.rust), label).toEqual(await files(dirs.typescript));
}

const TIME = "2026-09-21T12:00:00.000Z";

function template(overrides: Record<string, unknown> = {}) {
  return {
    visibility: "visible",
    tools: [{ kind: "files" }, { kind: "extension", extensionId: "pr-review", viewId: "findings" }],
    selection: { kind: "tool", toolId: '["extension","pr-review","findings"]' },
    files: {
      workspaceId: "ws",
      tabs: {
        tabs: ["a.ts", "b.ts"],
        active: "a.ts",
        line: { start: 2, end: 3 },
        lineNonce: 1,
        retained: ["b.ts"],
      },
    },
    changes: { workspaceId: "ws", selectedPath: null, scope: { kind: "branch", baseRef: "main" } },
    ...overrides,
  };
}

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    sourceToolCallId: "tool-1",
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childSessionId: "kid",
    title: "Child",
    goal: "Do the thing",
    status: "waiting",
    transcript: Array.from({ length: 45 }, (_, index) => ({
      id: `m${index}`,
      role: index % 3 === 0 ? "parent" : index % 3 === 1 ? "child" : "system",
      text: index === 44 ? "" : `message ${index}`,
      createdAt: TIME,
    })),
    evidence: [
      ...Array.from({ length: 82 }, (_, index) => ({
        id: `e${index}`,
        kind: "command",
        source: "command",
        status: "passed",
        title: `Check ${index}`,
        command: index % 2 ? "pnpm test" : "",
        severity: index % 5 === 0 ? "P1" : undefined,
        git: index % 7 === 0 ? { workspaceId: "ws", branchName: "", headSha: "abc" } : undefined,
        createdAt: TIME,
      })),
    ],
    supervisionLoop: {
      id: "loop",
      status: "monitoring",
      gate: "continue",
      intervalMs: 60_000,
      iterationCount: 0,
      lastCheckedAt: TIME,
      reason: "watching",
    },
    createdAt: TIME,
    updatedAt: TIME,
    ...overrides,
  };
}

const fullState = {
  version: 19,
  taskWorkbenchTemplatesBySession: {
    "ws:task": template(),
    "ws:retired": template({
      tools: [{ kind: "worktrees" }, { kind: "terminal" }],
      selection: { kind: "tool", toolId: "worktrees" },
    }),
    "ws:bad": template({ visibility: "expanded" }),
    "": template(),
    "2": template({ tools: [], selection: { kind: "chooser" } }),
  },
  selectedWorkspaceId: "ws",
  selectedSessionId: "s",
  activeView: "settings",
  composerDraft: "draft",
  composerDraftsBySession: { "ws:s": "one", "ws:empty": "", "10": "ten", "9": "nine" },
  extensionCommandCompatibilityByWorkspace: {
    ws: [
      {
        commandName: "plan",
        extensionPath: "/x",
        status: "terminal-only",
        message: "m",
        capability: "c",
        updatedAt: TIME,
      },
    ],
    empty: [],
  },
  extensionFlagsByWorkspace: { ws: { plan: true, env: "" }, other: {} },
  extensionFlagsBySession: { "ws:s": { plan: false } },
  notificationPreferences: { backgroundFailure: false },
  disabledBuiltinExtensions: ["a", "b"],
  integratedTerminalShell: "/bin/zsh",
  lastViewedAtBySession: { "ws:s": TIME },
  lastInteractedAtBySession: { "ws:s": TIME },
  pinnedAtBySession: { "ws:s": TIME },
  pinnedSessionOrder: ["ws:s"],
  workspaceOrder: ["ws", "other"],
  modelSettingsScopeMode: "app-global",
  appGlobalModelSettings: { defaultProvider: "anthropic", defaultThinkingLevel: "high" },
  sidebarCollapsed: true,
  threadGrouping: "workspace",
  collapsedWorkspaceIds: ["other"],
  allowMultiple: false,
  enableTransparency: true,
  themeMode: "dark",
  themePresetId: "nord",
  orchestrationChildren: [
    child(),
    child({ id: "child-2", childWorkspaceId: "", latestTranscript: "", transcript: [] }),
    child({ id: "child-3", status: "unknown", supervisionLoop: undefined, evidence: [] }),
  ],
};

const legacyState = {
  version: 15,
  composerDraft: "legacy",
  composerAttachmentsBySession: {
    "ws:s": [{ id: "a", name: "a.png", mimeType: "image/png", data: "eA==" }],
    "ws:none": [],
  },
  transcripts: { "ws:s": [{ role: "user", text: "hi" }], "": [] },
};

const uiStates: Record<string, unknown> = {
  "a full v19 state": fullState,
  "legacy v15 attachments and transcripts": legacyState,
  "a state without a version": { composerDraft: "old" },
  ...Object.fromEntries(
    [2, 10, 16, 17, 18].map((version) => [`version ${version}`, { version, composerDraft: "x" }]),
  ),
  "an empty object": {},
  "a future version": { version: 99, composerDraft: "future data" },
  "a fractional version": { version: 17.5 },
  "an array": [],
  "a string": "text",
  "null draft": { version: 19, composerDraft: null },
  "a non-string draft record": { version: 15, composerDraftsBySession: { one: 42 } },
  "a mixed order list": { version: 15, workspaceOrder: ["valid", null] },
  "a null child": { version: 15, orchestrationChildren: [null] },
  "an unknown thinking level": {
    version: 15,
    appGlobalModelSettings: { defaultThinkingLevel: "unknown" },
  },
  "an unknown model setting": { version: 19, appGlobalModelSettings: { future: 1 } },
  "an unknown top-level field": { version: 15, futureData: "retain" },
  "unknown fields, numeric first": { version: 15, zeta: 1, "7": 1 },
  "an unknown notification setting": {
    version: 15,
    notificationPreferences: { futureSetting: true },
  },
  "a non-boolean notification setting": {
    version: 15,
    notificationPreferences: { attentionNeeded: "yes" },
  },
  "a numeric interaction time": { version: 16, lastInteractedAtBySession: { one: 42 } },
  "an unknown grouping": { version: 17, threadGrouping: "priority" },
  "an unknown theme": { version: 19, themePresetId: "solarized" },
  "a numeric workspace flag": { version: 19, extensionFlagsByWorkspace: { ws: { retries: 3 } } },
  "flags as a list": { version: 19, extensionFlagsBySession: { "ws:sess": ["plan"] } },
  "an empty flag name": { version: 19, extensionFlagsBySession: { "ws:sess": { "": true } } },
  "a non-string folded folder": { version: 19, collapsedWorkspaceIds: ["alpha", 42] },
  "layouts before v18": { version: 17, taskWorkbenchTemplatesBySession: {} },
  "a layout list": { version: 19, taskWorkbenchTemplatesBySession: ["not", "a", "map"] },
  "a bad compatibility record": {
    version: 19,
    extensionCommandCompatibilityByWorkspace: { ws: [{ commandName: "x" }] },
  },
  "a compatibility record with an extra field": {
    version: 19,
    extensionCommandCompatibilityByWorkspace: {
      ws: [
        {
          commandName: "plan",
          extensionPath: "/x",
          status: "supported",
          message: "m",
          capability: "c",
          updatedAt: TIME,
          future: 1,
        },
      ],
    },
  },
  "a bad legacy attachment": {
    version: 15,
    composerAttachmentsBySession: { "ws:s": [{ id: "a", name: "a", mimeType: "m" }] },
  },
  "a legacy attachment with an extra field": {
    version: 15,
    composerAttachmentsBySession: {
      "ws:s": [{ id: "a", name: "a", mimeType: "m", data: "x", extra: 1 }],
    },
  },
  "a non-object transcript entry": { version: 15, transcripts: { "ws:s": ["text"] } },
  "a child with an unknown field": { orchestrationChildren: [child({ future: 1 })] },
  "a child missing its goal": { orchestrationChildren: [child({ goal: "" })] },
  "a child with a bad status": { orchestrationChildren: [child({ status: 3 })] },
  "a child with a bad transcript role": {
    orchestrationChildren: [
      child({ transcript: [{ id: "m", role: "bot", text: "t", createdAt: TIME }] }),
    ],
  },
  "a child with bad evidence": {
    orchestrationChildren: [child({ evidence: [{ id: "e", kind: "command" }] })],
  },
  "a child with evidence git without a folder": {
    orchestrationChildren: [
      child({
        evidence: [
          {
            id: "e",
            kind: "command",
            source: "command",
            status: "passed",
            title: "t",
            git: { branchName: "main" },
            createdAt: TIME,
          },
        ],
      }),
    ],
  },
  "a child with a zero supervision interval": {
    orchestrationChildren: [
      child({ supervisionLoop: { ...child().supervisionLoop, intervalMs: 0 } }),
    ],
  },
  "a child with a supervision field the app does not know": {
    orchestrationChildren: [child({ supervisionLoop: { ...child().supervisionLoop, x: 1 } })],
  },
};

for (const [name, state] of Object.entries(uiStates)) {
  test(`ui-state: ${name} reads, saves and reads back the same`, async () => {
    const dirs = await pair();
    await seed(dirs, { "ui-state.json": JSON.stringify(state, null, 1) });
    const typescriptPath = join(dirs.typescript, "ui-state.json");
    await same(
      dirs,
      "read",
      () => oracleUiState.readPersistedUiState(typescriptPath),
      () => readPersistedUiState(dirs.core),
    );
    const { version: _version, ...withoutVersion } = fullState;
    const payloads = [{ composerDraft: "replacement" }, withoutVersion as PersistedUiState];
    for (const [index, payload] of payloads.entries()) {
      await same(
        dirs,
        `write ${index}`,
        () => oracleUiState.writePersistedUiState(typescriptPath, payload),
        () => writePersistedUiState(dirs.core, payload),
      );
      await sameFiles(dirs, `files after write ${index}`);
    }
    await same(
      dirs,
      "read back",
      () => oracleUiState.readPersistedUiState(typescriptPath),
      () => readPersistedUiState(dirs.core),
    );
  });
}

const damage: Record<string, Record<string, string | undefined>> = {
  "a damaged file with a good backup": {
    "ui-state.json": "{damaged",
    "ui-state.json.bak": JSON.stringify({ version: 17, composerDraft: "from backup" }),
  },
  "a damaged file without a backup": { "ui-state.json": "{damaged" },
  "a damaged file and a damaged backup": {
    "ui-state.json": "{damaged",
    "ui-state.json.bak": "also damaged",
  },
  "a missing file with a backup": {
    "ui-state.json.bak": JSON.stringify({ version: 19, composerDraft: "kept" }),
  },
  "a damaged backup only": { "ui-state.json.bak": "{" },
  "bad UTF-8 inside a string": { "ui-state.json": '{"composerDraft":"aÿ"}' },
  "an empty file": { "ui-state.json": "" },
  "a byte order mark": { "ui-state.json": '﻿{"version":19}' },
  "an invalid backup behind a good file": {
    "ui-state.json": JSON.stringify({ version: 18, composerDraft: "good" }),
    "ui-state.json.bak": JSON.stringify({ version: 99 }),
  },
};

for (const [name, seeded] of Object.entries(damage)) {
  test(`ui-state: ${name} is handled the same`, async () => {
    const dirs = await pair();
    await seed(dirs, seeded);
    if (name === "bad UTF-8 inside a string") {
      for (const dir of [dirs.typescript, dirs.rust]) {
        await writeFile(
          join(dir, "ui-state.json"),
          Buffer.concat([
            Buffer.from('{"composerDraft":"a'),
            Buffer.from([0xff]),
            Buffer.from('"}'),
          ]),
        );
      }
    }
    const typescriptPath = join(dirs.typescript, "ui-state.json");
    await same(
      dirs,
      "read",
      () => oracleUiState.readPersistedUiState(typescriptPath),
      () => readPersistedUiState(dirs.core),
    );
    await same(
      dirs,
      "write",
      () => oracleUiState.writePersistedUiState(typescriptPath, { composerDraft: "next" }),
      () => writePersistedUiState(dirs.core, { composerDraft: "next" }),
    );
    await sameFiles(dirs, "files after write");
  });
}

test("ui-state: invalid saves are refused with the same message and numbers save like JSON.stringify", async () => {
  const dirs = await pair();
  const typescriptPath = join(dirs.typescript, "ui-state.json");
  const payloads: unknown[] = [
    { themeMode: "sepia" },
    { taskWorkbenchTemplatesBySession: { "": template() } },
    { version: 12, taskWorkbenchTemplatesBySession: {} },
    { future: true },
    {
      orchestrationChildren: [
        child({
          supervisionLoop: { ...child().supervisionLoop, intervalMs: 1.5, iterationCount: 1e21 },
          evidence: [],
        }),
      ],
      taskWorkbenchTemplatesBySession: { "ws:task": template() },
      composerDraft: "tab\t   é \u0001",
      workspaceOrder: ["7", "1"],
      composerDraftsBySession: { b: "x", "3": "y", "01": "z" },
    },
  ];
  for (const [index, payload] of payloads.entries()) {
    await same(
      dirs,
      `write ${index}`,
      () => oracleUiState.writePersistedUiState(typescriptPath, payload as PersistedUiState),
      () => writePersistedUiState(dirs.core, payload as PersistedUiState),
    );
    await sameFiles(dirs, `files after write ${index}`);
  }
});

test("ui-state: concurrent saves land in order with one migration copy", async () => {
  const dirs = await pair();
  await seed(dirs, { "ui-state.json": '{ "version": 17, "composerDraft": "v17" }\r\n' });
  const typescriptPath = join(dirs.typescript, "ui-state.json");
  const drafts = ["one", "two", "three", "four"];
  await Promise.all(
    drafts.map((composerDraft) =>
      oracleUiState.writePersistedUiState(typescriptPath, { composerDraft }),
    ),
  );
  await Promise.all(
    drafts.map((composerDraft) => writePersistedUiState(dirs.core, { composerDraft })),
  );
  await sameFiles(dirs, "files after concurrent saves");
});

const image = (id: string): ComposerAttachment => ({
  id,
  kind: "image",
  name: `${id}.png`,
  mimeType: "image/png",
  data: "eA==",
});

test("attachments: writes, reads, listing and pruning agree", async () => {
  const dirs = await pair();
  const typescript = new OracleAttachmentStore(dirs.typescript);
  const rust = new AttachmentStore(dirs.core);
  const keys = ["ws:sess", "ws:a/b", "ws:ü é", "ws:%41", "ws:*'()!~"];
  const file: ComposerAttachment = {
    id: "f",
    kind: "file",
    name: "notes.txt",
    mimeType: "text/plain",
    fsPath: "/tmp/notes.txt",
    sizeBytes: 12,
  };
  for (const [index, key] of keys.entries()) {
    const value = index % 2 ? [image(key), file] : [image(key)];
    await same(
      dirs,
      `write ${key}`,
      () => typescript.write(key, value),
      () => rust.write(key, value),
    );
    await same(
      dirs,
      `rewrite ${key}`,
      () => typescript.write(key, []),
      () => rust.write(key, []),
    );
  }
  await sameFiles(dirs, "files after writes");
  for (const key of [...keys, "ws:missing"]) {
    await same(
      dirs,
      `read ${key}`,
      () => typescript.read(key),
      () => rust.read(key),
    );
  }
  await seed(dirs, {
    "attachments/%E0%A4%A.json": "[]",
    "attachments/notes.txt": "",
    "attachments/legacy.json": JSON.stringify([
      { id: "l", name: "l.png", mimeType: "image/png", data: "eA==" },
    ]),
  });
  await same(
    dirs,
    "list",
    async () => (await typescript.listKeys()).sort(),
    async () => (await rust.listKeys()).sort(),
  );
  await same(
    dirs,
    "read legacy",
    () => typescript.read("legacy"),
    () => rust.read("legacy"),
  );
  for (const key of [keys[0]!, keys[1]!, "ws:missing"]) {
    await same(
      dirs,
      `remove ${key}`,
      () => typescript.remove(key),
      () => rust.remove(key),
    );
  }
  await sameFiles(dirs, "files after pruning");
});

const badAttachments: Record<string, string> = {
  "not a list": "{}",
  "a null entry": JSON.stringify([image("a"), null]),
  "missing metadata": JSON.stringify([{ id: "a", name: "a" }]),
  "an unknown field": JSON.stringify([{ ...image("a"), futureData: "retain" }]),
  "a negative size": JSON.stringify([
    { id: "a", kind: "file", name: "a", mimeType: "m", fsPath: "/a", sizeBytes: -1 },
  ]),
  "an image without data": JSON.stringify([{ id: "a", kind: "image", name: "a", mimeType: "m" }]),
  "a null kind": JSON.stringify([{ id: "a", kind: null, name: "a", mimeType: "m", data: "x" }]),
  "damaged bytes": "[{",
};

for (const [name, contents] of Object.entries(badAttachments)) {
  test(`attachments: ${name} is refused for reading, saving and pruning alike`, async () => {
    const dirs = await pair();
    await seed(dirs, { "attachments/ws%3As.json": contents });
    const typescript = new OracleAttachmentStore(dirs.typescript);
    const rust = new AttachmentStore(dirs.core);
    await same(
      dirs,
      "read",
      () => typescript.read("ws:s"),
      () => rust.read("ws:s"),
    );
    await same(
      dirs,
      "write",
      () => typescript.write("ws:s", []),
      () => rust.write("ws:s", []),
    );
    await same(
      dirs,
      "remove",
      () => typescript.remove("ws:s"),
      () => rust.remove("ws:s"),
    );
    await sameFiles(dirs, "files");
  });
}

test("attachments: a damaged file recovers from its backup but is never pruned", async () => {
  const dirs = await pair();
  await seed(dirs, {
    "attachments/ws%3As.json": "[{",
    "attachments/ws%3As.json.bak": JSON.stringify([image("b")]),
  });
  const typescript = new OracleAttachmentStore(dirs.typescript);
  const rust = new AttachmentStore(dirs.core);
  await same(
    dirs,
    "read",
    () => typescript.read("ws:s"),
    () => rust.read("ws:s"),
  );
  await same(
    dirs,
    "remove",
    () => typescript.remove("ws:s"),
    () => rust.remove("ws:s"),
  );
  await same(
    dirs,
    "write",
    () => typescript.write("ws:s", [image("c")]),
    () => rust.write("ws:s", [image("c")]),
  );
  await sameFiles(dirs, "files");
});

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    title: "Ping",
    instruction: "Say ping",
    status: "active",
    schedule: { kind: "interval", everyMs: 60_000 },
    target: { kind: "new-thread", workspaceId: "ws" },
    createdAt: TIME,
    updatedAt: TIME,
    nextRunAt: "2026-09-21T12:01:00.000Z",
    runs: [],
    ...overrides,
  };
}

const run = (index: number, overrides: Record<string, unknown> = {}) => ({
  id: `run-${index}`,
  sessionId: "s",
  workspaceId: "ws",
  firedAt: TIME,
  instruction: "Say ping",
  outcome: index % 2 ? "failed" : "started",
  ...(index % 2 ? { error: " boom " } : { userMessageId: `msg-${index}` }),
  ...overrides,
});

const taskFiles: Record<string, unknown> = {
  "every schedule kind": {
    version: 1,
    tasks: [
      task(),
      task({
        id: " padded ",
        title: "﻿Title ",
        schedule: { kind: "daily", hour: 9, minute: 30, timeZone: " Europe/London " },
        status: "paused",
        nextRunAt: undefined,
        lastRunAt: TIME,
        originSessionId: "origin",
        lastError: "late",
        runs: Array.from({ length: 45 }, (_, index) => run(index)),
      }),
      task({
        schedule: {
          kind: "weekly",
          days: ["fri", 1, "MONDAY", " thurs ", 1.0, "0"],
          hour: 23,
          minute: 59,
          timeZone: "asia/calcutta",
        },
        target: { kind: "existing-thread", workspaceId: " ws ", sessionId: " s " },
      }),
      task({ schedule: { kind: "daily", hour: 0, minute: 0 } }),
      task({
        status: "completed",
        nextRunAt: undefined,
        completedAt: TIME,
        schedule: { kind: "once", at: "2026-09-21T14:00:00+02:00" },
      }),
      ...[
        "2026-09-21",
        "2026-09",
        "2026-09-21T12:00",
        "2026-09-21T12:00:00.5Z",
        "2026-02-31T00:00:00Z",
        "+002026-09-21T00:00:00Z",
        "2026-09-21T24:00:00Z",
        " 2026-09-21T12:00:00.000Z ",
      ].map((at) => task({ schedule: { kind: "once", at } })),
      task({ schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "+05:30" } }),
      task({ schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "PST" } }),
      task({ schedule: { kind: "interval", everyMs: 604_800_000 } }),
    ],
  },
  "a newer version": { version: 2, tasks: [] },
  "a fractional version": { version: 1.0, tasks: [] },
  "an extra top-level field": { version: 1, tasks: {}, extra: true },
  "tasks not in a list": { version: 1, tasks: "nope" },
  "an array": [],
  "an unknown task field": { version: 1, tasks: [task({ futureField: true })] },
  "an active task without a next run": { version: 1, tasks: [task({ nextRunAt: undefined })] },
  "a paused task with a next run": { version: 1, tasks: [task({ status: "paused" })] },
  "a completed task without a time": {
    version: 1,
    tasks: [task({ status: "completed", nextRunAt: undefined })],
  },
  "an unknown status": { version: 1, tasks: [task({ status: "done" })] },
  "a blank title": { version: 1, tasks: [task({ title: " 　 " })] },
  "a title that is only U+0085": { version: 1, tasks: [task({ title: "\u0085" })] },
  "a bad id and a bad run": {
    version: 1,
    tasks: [task({ id: "", runs: [run(0, { outcome: "x" })] })],
  },
  "a run with an unknown field": { version: 1, tasks: [task({ runs: [run(1, { x: 1 })] })] },
  "a run with a blank error": { version: 1, tasks: [task({ runs: [run(1, { error: " " })] })] },
  "runs not in a list": { version: 1, tasks: [task({ runs: {} })] },
  "an unknown time zone": {
    version: 1,
    tasks: [task({ schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "Not/A_Zone" } })],
  },
  "an hour out of range": {
    version: 1,
    tasks: [task({ schedule: { kind: "daily", hour: 24, minute: 0, timeZone: "UTC" } })],
  },
  "a fractional minute": {
    version: 1,
    tasks: [task({ schedule: { kind: "daily", hour: 9, minute: 0.5, timeZone: "UTC" } })],
  },
  "no weekdays": {
    version: 1,
    tasks: [task({ schedule: { kind: "weekly", days: [], hour: 9, minute: 0 } })],
  },
  "an unknown weekday": {
    version: 1,
    tasks: [task({ schedule: { kind: "weekly", days: ["someday"], hour: 9, minute: 0 } })],
  },
  "a short interval": {
    version: 1,
    tasks: [task({ schedule: { kind: "interval", everyMs: 59_999 } })],
  },
  "a bad once time": {
    version: 1,
    tasks: [task({ schedule: { kind: "once", at: "2026-13-01" } })],
  },
  "an unknown schedule kind": { version: 1, tasks: [task({ schedule: { kind: "hourly" } })] },
  "a target without a thread": {
    version: 1,
    tasks: [task({ target: { kind: "existing-thread", workspaceId: "ws" } })],
  },
  "an unknown target": { version: 1, tasks: [task({ target: { kind: "x", workspaceId: "ws" } })] },
};

for (const [name, contents] of Object.entries(taskFiles)) {
  test(`scheduled tasks: ${name} reads and saves the same`, async () => {
    const dirs = await pair();
    await seed(dirs, { "scheduled-tasks.json": `${JSON.stringify(contents)}\n` });
    const typescriptPath = join(dirs.typescript, "scheduled-tasks.json");
    const read = await same(
      dirs,
      "read",
      () => oracleTasks.readScheduledTasksFile(typescriptPath),
      () => readScheduledTasksFile(dirs.core),
    );
    const tasks = (
      "value" in read ? (read.value as { tasks: ScheduledTaskRecord[] }).tasks : [task()]
    ) as ScheduledTaskRecord[];
    await same(
      dirs,
      "write",
      () => oracleTasks.writeScheduledTasksFile(typescriptPath, tasks),
      () => writeScheduledTasksFile(dirs.core, tasks),
    );
    await sameFiles(dirs, "files after write");
  });
}

test("scheduled tasks: invalid tasks are refused before saving, and a damaged file recovers", async () => {
  const dirs = await pair();
  const typescriptPath = join(dirs.typescript, "scheduled-tasks.json");
  await same(
    dirs,
    "missing file",
    () => oracleTasks.readScheduledTasksFile(typescriptPath),
    () => readScheduledTasksFile(dirs.core),
  );
  const invalid = [task({ status: "paused" })] as unknown as ScheduledTaskRecord[];
  await same(
    dirs,
    "invalid write",
    () => oracleTasks.writeScheduledTasksFile(typescriptPath, invalid),
    () => writeScheduledTasksFile(dirs.core, invalid),
  );
  const valid = [task()] as unknown as ScheduledTaskRecord[];
  for (const label of ["first write", "second write"]) {
    await same(
      dirs,
      label,
      () => oracleTasks.writeScheduledTasksFile(typescriptPath, valid),
      () => writeScheduledTasksFile(dirs.core, valid),
    );
  }
  await seed(dirs, { "scheduled-tasks.json": "{damaged" });
  await same(
    dirs,
    "recovered read",
    () => oracleTasks.readScheduledTasksFile(typescriptPath),
    () => readScheduledTasksFile(dirs.core),
  );
  await same(
    dirs,
    "write after recovery",
    () => oracleTasks.writeScheduledTasksFile(typescriptPath, valid),
    () => writeScheduledTasksFile(dirs.core, valid),
  );
  await sameFiles(dirs, "files");
  await seed(dirs, { "scheduled-tasks.json": "{damaged", "scheduled-tasks.json.bak": "{" });
  await same(
    dirs,
    "unrecoverable read",
    () => oracleTasks.readScheduledTasksFile(typescriptPath),
    () => readScheduledTasksFile(dirs.core),
  );
});

test("scheduled tasks: every time zone Intl knows is accepted", async () => {
  const zones = [
    ...Intl.supportedValuesOf("timeZone"),
    ...["UTC", "Etc/UTC", "GMT", "US/Eastern", "Asia/Calcutta", "EST5EDT", "Etc/GMT-14"],
    ...["SystemV/AST4", "Canada/East-Saskatchewan", "US/Pacific-New", "ROC", "Zulu"],
    ...["america/new_york", "EUROPE/LONDON", "+05", "+0530", "-23:59", "−05:00"],
  ];
  const tasks = zones.map((timeZone, index) =>
    task({ id: `t${index}`, schedule: { kind: "daily", hour: 9, minute: 0, timeZone } }),
  );
  const dirs = await pair();
  await seed(dirs, { "scheduled-tasks.json": JSON.stringify({ version: 1, tasks }) });
  const read = await same(
    dirs,
    "read",
    () => oracleTasks.readScheduledTasksFile(join(dirs.typescript, "scheduled-tasks.json")),
    () => readScheduledTasksFile(dirs.core),
  );
  expect("value" in read).toBe(true);

  for (const timeZone of ["GMT+5", "Etc/GMT+13", "+24:00", "+5:00", "Factory", "Mars/Base"]) {
    await seed(dirs, {
      "scheduled-tasks.json": JSON.stringify({
        version: 1,
        tasks: [task({ schedule: { kind: "daily", hour: 9, minute: 0, timeZone } })],
      }),
    });
    await same(
      dirs,
      timeZone,
      () => oracleTasks.readScheduledTasksFile(join(dirs.typescript, "scheduled-tasks.json")),
      () => readScheduledTasksFile(dirs.core),
    );
  }
});

test("review marks: changes, order and refusals agree", async () => {
  const dirs = await pair();
  const typescript = new OracleReviewedStore(dirs.typescript);
  const rust = new ReviewedStore(dirs.core);
  const marks = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(64));
  const steps: Array<[string, boolean]> = [
    [marks[0]!, true],
    [marks[1]!, true],
    [marks[0]!, true],
    [marks[2]!, true],
    [marks[1]!, false],
    [marks[1]!, true],
    [marks[3]!, false],
  ];
  for (const [mark, reviewed] of steps) {
    await same(
      dirs,
      `set ${mark[0]} ${reviewed}`,
      () => typescript.set(mark, reviewed),
      () => rust.set(mark, reviewed),
    );
    await same(
      dirs,
      "snapshot",
      async () => [...(await typescript.snapshot())],
      async () => [...(await rust.snapshot())],
    );
    await sameFiles(dirs, `files after ${mark[0]} ${reviewed}`);
  }

  for (const contents of [
    '{"version":99,"marks":[],"future":"retain"}\n',
    JSON.stringify({ version: 1, marks: ["A".repeat(64)] }),
    JSON.stringify({ version: 1, marks: [marks[0], marks[0]] }),
    "{damaged",
  ]) {
    const fresh = await pair();
    await seed(fresh, { "reviewed-files.json": contents });
    const oracle = new OracleReviewedStore(fresh.typescript);
    const store = new ReviewedStore(fresh.core);
    await same(
      fresh,
      `snapshot of ${contents}`,
      async () => [...(await oracle.snapshot())],
      async () => [...(await store.snapshot())],
    );
    await same(
      fresh,
      `set on ${contents}`,
      () => oracle.set(marks[4]!, true),
      () => store.set(marks[4]!, true),
    );
    await sameFiles(fresh, `files for ${contents}`);
  }
});
