import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { savePiProjectSettings } from "../dist/compat/pi-project-settings.js";
import { forcePersistPiSession } from "../dist/compat/pi-session-persistence.js";

await test("forced Pi persistence keeps the private flushed state aligned", () => {
  let receiver;
  const sessionManager = {
    flushed: false,
    _rewriteFile() {
      receiver = this;
    },
  };

  forcePersistPiSession(sessionManager);

  assert.equal(receiver, sessionManager);
  assert.equal(sessionManager.flushed, true);
});

await test("forced Pi persistence does not rewrite a file Pi already writes", () => {
  let rewrites = 0;
  const sessionManager = {
    flushed: true,
    _rewriteFile() {
      rewrites += 1;
    },
  };

  forcePersistPiSession(sessionManager);

  assert.equal(rewrites, 0);
});

await test("forced Pi persistence keeps turns another Pi process appended", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-gui-compat-"));
  try {
    const desktop = SessionManager.create(directory, directory);
    desktop.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    desktop.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "fixture",
      provider: "fixture",
      model: "fixture",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const sessionFile = desktop.getSessionFile();
    assert.ok(sessionFile);
    const external = SessionManager.open(sessionFile, directory);
    external.appendMessage({ role: "user", content: "external turn", timestamp: Date.now() });

    desktop.appendSessionInfo("Renamed");
    forcePersistPiSession(desktop);

    const saved = readFileSync(sessionFile, "utf8");
    assert.match(saved, /external turn/);
    assert.match(saved, /Renamed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("forced Pi persistence is a no-op when Pi has no private rewrite hook", () => {
  assert.doesNotThrow(() => forcePersistPiSession({}));
});

await test("project settings compatibility marks every field before saving", () => {
  const calls: Array<["mark", string] | ["save", Record<string, unknown>]> = [];
  const settingsManager = {
    markProjectModified(field: string): void {
      calls.push(["mark", field]);
    },
    saveProjectSettings(settings: Record<string, unknown>): void {
      calls.push(["save", settings]);
    },
  };
  const settings = { defaultProvider: "openai" };

  savePiProjectSettings(settingsManager, settings, ["defaultProvider", "defaultModel"]);

  assert.deepEqual(calls, [
    ["mark", "defaultProvider"],
    ["mark", "defaultModel"],
    ["save", settings],
  ]);
});

await test("project settings compatibility fails clearly when upstream hooks change", () => {
  assert.throws(
    () => savePiProjectSettings({}, {}, ["defaultProvider"]),
    /does not support project-scoped settings persistence/,
  );
});

await test("compatibility hooks match the bundled Pi runtime", async () => {
  const sessionManager = SessionManager.inMemory("/tmp/pi-gui-compat-fixture");
  sessionManager.appendSessionInfo("Compatibility fixture");
  forcePersistPiSession(sessionManager);
  const compatibleSessionManager = sessionManager as unknown as { flushed: boolean };
  assert.equal(compatibleSessionManager.flushed, true);

  const settingsManager = SettingsManager.inMemory();
  const projectSettings = { defaultProvider: "openai" };
  savePiProjectSettings(settingsManager, projectSettings, ["defaultProvider"]);
  await settingsManager.flush();
  assert.equal(settingsManager.getProjectSettings().defaultProvider, "openai");
});
