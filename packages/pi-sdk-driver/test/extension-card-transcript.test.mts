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
        "not a row",
      ],
      actions: [
        { label: "Open search.ts:3", path: "search.ts", line: 3 },
        { label: "Open README", path: "README.md", line: 0 },
        { label: "No path" },
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
        { label: "Open search.ts:3", path: "search.ts", line: 3 },
        { label: "Open README", path: "README.md" },
      ],
    },
  });
  const minimal = transcriptItemFromCardEntry(cardEntry({ title: "Done", tone: "loud" }));
  assert.ok(minimal.kind === "card");
  assert.deepEqual(minimal.card, { title: "Done", tone: "neutral", rows: [], actions: [] });
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
  await driver.closeSession(ref);
  assert.deepEqual(await cards(), [live], "the closed session reads it from disk once");
});
