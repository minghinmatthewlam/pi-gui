import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent, SessionTranscriptItem } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";
import {
  transcriptFromSession,
  transcriptItemFromCardEntry,
  transcriptItemFromPinEntry,
} from "../dist/session-supervisor-utils.js";

const cardEntry = (data: unknown): CustomEntry => ({
  type: "custom",
  customType: "pi-gui.card",
  id: "entry-1",
  parentId: null,
  timestamp: "2026-09-30T00:00:00.000Z",
  data,
});

await test("a card entry becomes a card item with the entry id; unknown fields are ignored", () => {
  const item = transcriptItemFromCardEntry(
    cardEntry({
      title: "CI failed on main",
      subtitle: "unit-tests",
      tone: "error",
      color: "#f00",
      rows: [
        { label: "Job", value: "unit-tests" },
        { label: "Failed", value: 2 },
        { label: "Bad row" },
        { label: " ", value: "blank label" },
        { label: "Not finite", value: Number.NaN },
        "not a row",
      ],
      actions: [
        { type: "openFile", label: "Open search.ts:3", path: "search.ts", line: 3 },
        { type: "openFile", label: "Open README", path: "README.md", line: 0 },
        { type: "openFile", label: "No path" },
        { type: "openFile", label: "", path: "search.ts" },
        { label: "No type", path: "search.ts" },
      ],
    }),
  );
  assert.deepEqual(item, {
    kind: "card",
    id: "entry-1",
    createdAt: "2026-09-30T00:00:00.000Z",
    card: {
      title: "CI failed on main",
      subtitle: "unit-tests",
      tone: "error",
      rows: [
        { label: "Job", value: "unit-tests" },
        { label: "Failed", value: "2" },
      ],
      actions: [
        { type: "openFile", label: "Open search.ts:3", path: "search.ts", line: 3 },
        { type: "openFile", label: "Open README", path: "README.md" },
      ],
    },
  });
  const minimal = transcriptItemFromCardEntry(cardEntry({ title: "Done", tone: "loud" }));
  assert.ok(minimal.kind === "card");
  assert.deepEqual(minimal.card, { title: "Done", tone: "neutral", rows: [], actions: [] });
});

await test("card buttons parse into the fixed action list; anything else is dropped", () => {
  const item = transcriptItemFromCardEntry(
    cardEntry({
      title: "Buttons",
      actions: [
        { type: "openFile", label: "Open", path: "src/a.ts", line: 4 },
        { type: "composer", label: "Ask", text: "  Fix the failing test  " },
        { type: "url", label: "Run", url: "https://ci.example.com/runs/1" },
        { type: "command", label: "Rerun", command: "/ci rerun" },
        { type: "url", label: "Plain http", url: "http://ci.example.com" },
        { type: "url", label: "With password", url: "https://me:secret@ci.example.com" },
        { type: "url", label: "Script", url: "javascript:alert(1)" },
        { type: "command", label: "Not a command", command: "rerun" },
        { type: "command", label: "Two lines", command: "/ci\n/model" },
        { type: "composer", label: "Empty", text: " " },
        { type: "shell", label: "Unknown kind", command: "rm -rf /" },
      ],
    }),
  );
  assert.ok(item.kind === "card");
  assert.deepEqual(item.card.actions, [
    { type: "openFile", label: "Open", path: "src/a.ts", line: 4 },
    { type: "composer", label: "Ask", text: "Fix the failing test" },
    { type: "url", label: "Run", url: "https://ci.example.com/runs/1" },
    { type: "command", label: "Rerun", command: "/ci rerun" },
  ]);
  const many = transcriptItemFromCardEntry(
    cardEntry({
      title: "Many",
      actions: Array.from({ length: 12 }, (_, i) => ({
        type: "openFile",
        label: `Open ${i}`,
        path: `f${i}.ts`,
      })),
    }),
  );
  assert.ok(many.kind === "card");
  assert.equal(many.card.actions.length, 8);
});

await test("a keyed card has a key-based id; a bad key is a visible error row", () => {
  const keyed = transcriptItemFromCardEntry(cardEntry({ key: "ci-main", title: "CI running" }));
  assert.ok(keyed.kind === "card");
  assert.equal(keyed.id, "card:ci-main");
  assert.equal(keyed.card.key, "ci-main");
  for (const key of ["", "has space", "x".repeat(65), 7]) {
    const item = transcriptItemFromCardEntry(cardEntry({ key, title: "Bad key" }));
    assert.equal(item.kind, "custom", JSON.stringify(key));
    assert.equal(item.id, "entry-1");
  }
});

await test("the projection keeps a keyed card where it first appeared with its latest write", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("pi-gui.card", { key: "ci", title: "CI running" });
  const userId = manager.appendMessage({ role: "user", content: "rerun", timestamp: Date.now() });
  const otherId = manager.appendCustomEntry("pi-gui.card", { title: "Unkeyed" });
  manager.appendCustomEntry("pi-gui.card", { key: "ci", title: "CI passed", tone: "success" });
  const transcript = transcriptFromSession(manager);
  assert.deepEqual(
    transcript.map((item) => [item.kind, item.id]),
    [
      ["card", "card:ci"],
      ["message", userId],
      ["card", otherId],
    ],
  );
  const first = transcript[0];
  assert.ok(first?.kind === "card");
  assert.equal(first.card.title, "CI passed");
  assert.equal(first.card.tone, "success");
});

await test("a card without a title is a visible custom row saying what is wrong", () => {
  for (const data of [{ subtitle: "no title" }, { title: "   " }, undefined, "text"]) {
    const item = transcriptItemFromCardEntry(cardEntry(data));
    assert.equal(item.kind, "custom", JSON.stringify(data));
    assert.ok(item.kind === "custom");
    assert.equal(item.id, "entry-1");
    assert.equal(item.customType, "pi-gui.card");
    assert.match(item.text, /^This card was not shown: /);
  }
});

await test("the session projection places cards in entry order and skips other custom entries", () => {
  const manager = SessionManager.inMemory();
  const userId = manager.appendMessage({ role: "user", content: "run ci", timestamp: Date.now() });
  const cardId = manager.appendCustomEntry("pi-gui.card", { title: "CI passed", tone: "success" });
  manager.appendCustomEntry("status-card", { title: "not for pi-gui" });
  manager.appendCustomEntry("pi-gui.card", { rows: [] });
  const transcript = transcriptFromSession(manager);
  assert.deepEqual(
    transcript.map((item) => [item.kind, item.id]),
    [
      ["message", userId],
      ["card", cardId],
      ["custom", transcript[2]?.id],
    ],
  );
});

const pinEntry = (data: unknown): CustomEntry => ({
  ...cardEntry(data),
  customType: "pi-gui.pin",
});

await test("a pin entry parses like a card with a required key; remove unpins it", () => {
  const item = transcriptItemFromPinEntry(
    pinEntry({
      key: "todo",
      title: "Plan",
      subtitle: "1 done",
      tone: "warning",
      rows: [{ label: "✓", value: "Read the code" }, { label: "Bad row" }],
      actions: [{ type: "command", label: "Open list", command: "/todos" }],
    }),
  );
  assert.deepEqual(item, {
    kind: "pin",
    id: "pin:todo",
    createdAt: "2026-09-30T00:00:00.000Z",
    card: {
      key: "todo",
      title: "Plan",
      subtitle: "1 done",
      tone: "warning",
      rows: [{ label: "✓", value: "Read the code" }],
      actions: [{ type: "command", label: "Open list", command: "/todos" }],
    },
  });
  assert.deepEqual(transcriptItemFromPinEntry(pinEntry({ key: "todo", remove: true })), {
    kind: "pin",
    id: "pin:todo",
    createdAt: "2026-09-30T00:00:00.000Z",
    card: null,
  });
});

await test("a malformed pin is one error row per key; without a valid key it keeps the entry id", () => {
  for (const data of [{ title: "No key" }, { key: "has space", title: "Bad key" }, "text", null]) {
    const item = transcriptItemFromPinEntry(pinEntry(data));
    assert.ok(item.kind === "custom", JSON.stringify(data));
    assert.equal(item.id, "entry-1");
    assert.equal(item.customType, "pi-gui.pin");
    assert.match(item.text, /^This pinned card was not shown: it needs a `key`/);
  }
  for (const data of [{ key: "todo" }, { key: "todo", title: "  " }, { key: "todo", remove: 1 }]) {
    const item = transcriptItemFromPinEntry(pinEntry(data));
    assert.ok(item.kind === "custom", JSON.stringify(data));
    assert.equal(item.id, "pin-error:todo");
    assert.match(item.text, /^This pinned card was not shown: it needs a non-empty string `title`/);
  }
});

await test("the projection keeps each pin's latest write, removes it, and re-pins it as new", () => {
  const manager = SessionManager.inMemory();
  const userId = manager.appendMessage({ role: "user", content: "plan", timestamp: Date.now() });
  manager.appendCustomEntry("pi-gui.pin", { key: "todo", title: "Plan", subtitle: "0 done" });
  manager.appendCustomEntry("pi-gui.pin", { key: "ci", title: "CI running" });
  manager.appendCustomEntry("pi-gui.pin", { key: "todo", title: "Plan", subtitle: "1 done" });
  manager.appendCustomEntry("pi-gui.pin", { key: "ci", rows: [] });
  const pins = () =>
    transcriptFromSession(manager).flatMap((item) =>
      item.kind === "pin" ? [[item.id, item.card?.subtitle ?? item.card?.title ?? null]] : [],
    );
  // One row per pin key in first-write order; the broken write leaves its pin as it was.
  assert.deepEqual(pins(), [
    ["pin:todo", "1 done"],
    ["pin:ci", "CI running"],
  ]);
  assert.deepEqual(
    transcriptFromSession(manager).map((item) => [item.kind, item.id]),
    [
      ["message", userId],
      ["custom", "pin-error:ci"],
      ["pin", "pin:todo"],
      ["pin", "pin:ci"],
    ],
    "a pin's only row in the conversation is its error row",
  );

  manager.appendCustomEntry("pi-gui.pin", { key: "todo", remove: true });
  assert.deepEqual(pins(), [
    ["pin:todo", null],
    ["pin:ci", "CI running"],
  ]);
  manager.appendCustomEntry("pi-gui.pin", { key: "todo", title: "New plan" });
  assert.deepEqual(pins(), [
    ["pin:ci", "CI running"],
    ["pin:todo", "New plan"],
  ]);
});

await test("a pin written before a compaction's kept range survives it", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "summarized question", timestamp: Date.now() });
  manager.appendCustomEntry("pi-gui.pin", { key: "todo", title: "Plan" });
  manager.appendCustomEntry("pi-gui.card", { key: "ci", title: "CI passed" });
  const keptId = manager.appendMessage({
    role: "user",
    content: "kept question",
    timestamp: Date.now(),
  });
  manager.appendCompaction("summary", keptId, 1000);
  const transcript = transcriptFromSession(manager);
  assert.equal(
    transcript.some((item) => item.kind === "card"),
    false,
    "a card before the kept range is summarized away",
  );
  const pins = transcript.filter((item) => item.kind === "pin");
  assert.equal(pins.length, 1);
  assert.ok(pins[0]?.kind === "pin");
  assert.equal(pins[0].card?.title, "Plan");
});

await test("a pin on another branch is not shown", () => {
  const manager = SessionManager.inMemory();
  const rootId = manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
  manager.appendCustomEntry("pi-gui.pin", { key: "todo", title: "Abandoned plan" });
  manager.branch(rootId);
  manager.appendCustomEntry("pi-gui.pin", { key: "other", title: "This branch" });
  assert.deepEqual(
    transcriptFromSession(manager).flatMap((item) => (item.kind === "pin" ? [item.id] : [])),
    ["pin:other"],
  );
});

await test("a live card and the reopened transcript show the same card once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-card-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("This test must never use the network");
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }),
  );
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: (runtimeOptions) =>
      createAgentSessionRuntimeWithNpmFallback({
        ...runtimeOptions,
        tools: [],
        resourceLoaderOptions: {
          ...runtimeOptions.resourceLoaderOptions,
          extensionFactories: [
            ...(runtimeOptions.resourceLoaderOptions?.extensionFactories ?? []),
            (pi) => {
              pi.registerCommand("card", {
                description: "Append a card",
                handler: async () => {
                  pi.appendEntry("pi-gui.card", { title: "Deployed", tone: "success" });
                },
              });
              pi.registerCommand("ci", {
                description: "Append or update the keyed CI card",
                handler: async (args) => {
                  pi.appendEntry("pi-gui.card", { key: "ci", title: `CI ${args || "running"}` });
                },
              });
              pi.registerCommand("pin", {
                description: "Pin or update the plan",
                handler: async (args) => {
                  pi.appendEntry("pi-gui.pin", { key: "plan", title: `Plan ${args || "draft"}` });
                },
              });
            },
          ],
        },
      }),
  });
  const { ref } = await driver.createSession({ workspaceId: "card-workspace", path: cwd });
  const appended: SessionTranscriptItem[] = [];
  const unsubscribe = driver.subscribe(ref, (event: SessionDriverEvent) => {
    if (event.type === "transcriptItemAppended") appended.push(event.item);
  });
  t.after(unsubscribe);

  await driver.sendUserMessage(ref, { text: "/card" });
  const deadline = Date.now() + 5_000;
  while (appended.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(appended.length, 1);
  const live = appended[0];
  assert.ok(live?.kind === "card");
  assert.equal(live.card.title, "Deployed");

  const cards = async () =>
    (await driver.getTranscript(ref)).filter((item) => item.kind === "card");
  assert.deepEqual(await cards(), [live], "the running session reads the same item");

  await driver.sendUserMessage(ref, { text: "/ci", extensionCommandOnly: true });
  await driver.sendUserMessage(ref, { text: "/ci passed", extensionCommandOnly: true });
  const keyed = (await cards()).filter((item) => item.id === "card:ci");
  assert.equal(keyed.length, 1, "two writes with one key are one card");
  assert.ok(keyed[0]?.kind === "card");
  assert.equal(keyed[0].card.title, "CI passed");
  assert.deepEqual(
    appended
      .filter((item) => item.id === "card:ci")
      .map((item) => item.kind === "card" && item.card.title),
    ["CI running", "CI passed"],
    "each write reaches the app live under the same id",
  );

  const before = (await driver.getTranscript(ref)).length;
  for (const text of ["/model", "/nope", "hello"]) {
    await assert.rejects(
      driver.sendUserMessage(ref, { text, extensionCommandOnly: true }),
      /is not an extension command/,
      text,
    );
  }
  assert.equal((await driver.getTranscript(ref)).length, before, "a refused button sends nothing");

  await driver.sendUserMessage(ref, { text: "/pin", extensionCommandOnly: true });
  await driver.sendUserMessage(ref, { text: "/pin final", extensionCommandOnly: true });
  const livePins = appended.filter((item) => item.kind === "pin");
  assert.deepEqual(
    livePins.map((item) => item.kind === "pin" && item.card?.title),
    ["Plan draft", "Plan final"],
  );
  const pins = async () => (await driver.getTranscript(ref)).filter((item) => item.kind === "pin");
  assert.deepEqual(await pins(), [livePins[1]], "the projection reads the live pin's latest write");

  const allCards = await cards();
  await driver.closeSession(ref);
  assert.deepEqual(await cards(), allCards, "the closed session reads the same cards from disk");
  assert.deepEqual(allCards[0], live);
  assert.deepEqual(await pins(), [livePins[1]], "and the same pin");
});
