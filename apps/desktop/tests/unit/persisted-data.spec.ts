import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  readPersistedUiState,
  writePersistedUiState,
} from "../../electron/persistence/app-store-persistence";
import { AttachmentStore } from "../../electron/persistence/attachment-store";
import { startTestCore, stopTestCoresAfterEach } from "./rust-core-process";

stopTestCoresAfterEach();

/** A fresh profile folder served by the Rust core, and its ui-state path. */
async function profile(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, path: join(dir, "ui-state.json"), core: await startTestCore(dir) };
}

for (const invalid of [
  { version: 99, composerDraft: "future data" },
  { version: 15, composerDraftsBySession: { one: 42 } },
  { version: 15, workspaceOrder: ["valid", null] },
  { version: 15, orchestrationChildren: [null] },
  { version: 15, appGlobalModelSettings: { defaultThinkingLevel: "unknown" } },
  { version: 15, futureData: "retain" },
  { version: 15, notificationPreferences: { futureSetting: true } },
  { version: 16, lastInteractedAtBySession: { one: 42 } },
  { version: 17, threadGrouping: "priority" },
  { version: 19, extensionFlagsByWorkspace: { ws: { retries: 3 } } },
  { version: 19, extensionFlagsBySession: { "ws:sess": ["plan"] } },
  { version: 19, collapsedWorkspaceIds: ["alpha", 42] },
  [],
]) {
  test(`preserves invalid UI state ${JSON.stringify(invalid)}`, async () => {
    const { path, core } = await profile("ui-state-validation-");
    const original = JSON.stringify(invalid);
    await writeFile(path, original);
    await expect(readPersistedUiState(core)).rejects.toThrow(/Invalid ui-state/);
    await expect(writePersistedUiState(core, { composerDraft: "replacement" })).rejects.toThrow(
      /Invalid ui-state/,
    );
    expect(await readFile(path, "utf8")).toBe(original);
  });
}

test("reads v15 ui-state without lastInteractedAt and writes v18", async () => {
  const { path, core } = await profile("ui-state-recency-");
  await writeFile(path, JSON.stringify({ version: 15, composerDraft: "kept" }));
  const decoded = await readPersistedUiState(core);
  expect(decoded.version).toBe(15);
  expect(decoded.lastInteractedAtBySession).toBeUndefined();
  await writePersistedUiState(core, {
    composerDraft: "kept",
    lastInteractedAtBySession: { "ws:sess": "2026-09-21T12:00:00.000Z" },
  });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    lastInteractedAtBySession: Record<string, string>;
  };
  expect(written.version).toBe(19);
  expect(written.lastInteractedAtBySession).toEqual({ "ws:sess": "2026-09-21T12:00:00.000Z" });
});

test("reads v16 ui-state without threadGrouping and writes the saved choice as v18", async () => {
  const { path, core } = await profile("ui-state-grouping-");
  await writeFile(path, JSON.stringify({ version: 16, composerDraft: "kept" }));
  const decoded = await readPersistedUiState(core);
  expect(decoded.version).toBe(16);
  expect(decoded.threadGrouping).toBeUndefined();
  await writePersistedUiState(core, {
    composerDraft: "kept",
    threadGrouping: "workspace",
  });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    threadGrouping: string;
  };
  expect(written.version).toBe(19);
  expect(written.threadGrouping).toBe("workspace");
});

test("extension flag defaults and per-thread flags round-trip through ui-state", async () => {
  const { path, core } = await profile("ui-state-flags-");
  await writePersistedUiState(core, {
    extensionFlagsByWorkspace: { ws: { plan: true, "dry-run": false, env: "" } },
    extensionFlagsBySession: { "ws:sess": { plan: true }, "ws:empty": {} },
  });
  const decoded = await readPersistedUiState(core);
  expect(decoded.extensionFlagsByWorkspace).toEqual({
    ws: { plan: true, "dry-run": false, env: "" },
  });
  expect(decoded.extensionFlagsBySession).toEqual({ "ws:sess": { plan: true } });
});

test("reads ui-state without folded folders and writes the collapsed ids", async () => {
  const { path, core } = await profile("ui-state-collapsed-");
  await writeFile(path, JSON.stringify({ version: 15, composerDraft: "kept" }));
  expect((await readPersistedUiState(core)).collapsedWorkspaceIds).toBeUndefined();
  await writePersistedUiState(core, { composerDraft: "kept", collapsedWorkspaceIds: ["alpha"] });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    collapsedWorkspaceIds: readonly string[];
  };
  expect(written.version).toBe(19);
  expect(written.collapsedWorkspaceIds).toEqual(["alpha"]);
  expect((await readPersistedUiState(core)).collapsedWorkspaceIds).toEqual(["alpha"]);
});

test("backup recovery retains damaged bytes and the good backup", async () => {
  const { dir, path, core } = await profile("ui-state-backup-");
  const good = JSON.stringify({ version: 15, composerDraft: "retained draft" });
  await writeFile(`${path}.bak`, good);
  await writeFile(path, "{damaged");
  expect((await readPersistedUiState(core)).composerDraft).toBe("retained draft");
  await writePersistedUiState(core, { composerDraft: "retained draft" });
  expect(await readFile(`${path}.bak`, "utf8")).toBe(good);
  const preserved = (await readdir(dir)).filter((name) =>
    name.startsWith("ui-state.json.corrupt."),
  );
  expect(preserved).toHaveLength(1);
  expect(await readFile(join(dir, preserved[0]!), "utf8")).toBe("{damaged");
});

test("unrecoverable syntax errors cannot be overwritten", async () => {
  const { path, core } = await profile("ui-state-broken-");
  await writeFile(path, "{damaged");
  await expect(readPersistedUiState(core)).rejects.toThrow(/original data was retained/);
  await expect(writePersistedUiState(core, {})).rejects.toThrow(/Cannot overwrite/);
  expect(await readFile(path, "utf8")).toBe("{damaged");
});

test("attachment owner rejects malformed entries before read, replacement or pruning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attachment-validation-"));
  const store = new AttachmentStore(await startTestCore(dir));
  const valid = {
    id: "one",
    kind: "image" as const,
    name: "image.png",
    mimeType: "image/png",
    data: "eA==",
  };
  await store.write("session", [valid]);
  const path = join(dir, "attachments", "session.json");
  const original = JSON.stringify([valid, null]);
  await writeFile(path, original);
  await expect(store.read("session")).rejects.toThrow(/Invalid saved attachment/);
  await expect(store.write("session", [])).rejects.toThrow(/Invalid saved attachment/);
  await expect(store.remove("session")).rejects.toThrow(/Invalid saved attachment/);
  expect(await readFile(path, "utf8")).toBe(original);
  await writeFile(
    path,
    JSON.stringify([
      { id: valid.id, name: valid.name, mimeType: valid.mimeType, data: valid.data },
    ]),
  );
  expect(await store.read("session")).toEqual([valid]);
});

test("unknown attachment fields survive rejected replacement and pruning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attachment-unknown-"));
  const store = new AttachmentStore(await startTestCore(dir));
  await store.write("session", []);
  const path = join(dir, "attachments", "session.json");
  const original = JSON.stringify([
    { id: "one", name: "image.png", mimeType: "image/png", data: "eA==", futureData: "retain" },
  ]);
  await writeFile(path, original);
  await expect(store.read("session")).rejects.toThrow(/unsupported field/);
  await expect(store.write("session", [])).rejects.toThrow(/unsupported field/);
  await expect(store.remove("session")).rejects.toThrow(/unsupported field/);
  expect(await readFile(path, "utf8")).toBe(original);
});
