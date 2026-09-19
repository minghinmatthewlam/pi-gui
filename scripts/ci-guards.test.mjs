import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ESLint } from "eslint";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("the real lint config rejects shortcuts across source and script scopes", async () => {
  const eslint = new ESLint({
    cwd: root,
    // These repeated lintText calls replace project members in memory. CI's
    // single-run optimization otherwise reads their unchanged disk contents.
    // Keep every production rule/project; use the parser's editable program mode.
    overrideConfig: {
      languageOptions: {
        parserOptions: { disallowAutomaticSingleRunInference: true },
      },
    },
  });
  for (const filePath of [
    "apps/desktop/src/app/App.tsx",
    "apps/desktop/electron/main.ts",
    "apps/desktop/tests/core/smoke.spec.ts",
    "apps/website/app/page.tsx",
    "packages/session-driver/src/index.ts",
    "video/src/Root.tsx",
    "scripts/guard-fixture.mjs",
    ".github/scripts/guard-fixture.mjs",
  ]) {
    const [invalid] = await eslint.lintText("debugger;\n", { filePath });
    assert(
      invalid.messages.some((message) => message.ruleId === "no-debugger"),
      filePath,
    );
    const [valid] = await eslint.lintText("export const value = 1;\n", { filePath });
    assert.equal(valid.errorCount + valid.warningCount, 0, filePath);
  }
  const [unsafe] = await eslint.lintText("new Promise(async (resolve) => { resolve(1); });\n", {
    filePath: "apps/desktop/src/ui/syntax-highlight.ts",
  });
  assert(unsafe.messages.some((message) => message.ruleId === "no-async-promise-executor"));
});

test("CI rejects a focused Playwright test but discovers an ordinary test", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "pi-gui-ci-guard-"));
  const configPath = path.join(fixtureDir, "playwright.config.ts");
  const specPath = path.join(fixtureDir, "guard.spec.ts");
  const desktopConfig = path.join(root, "apps/desktop/playwright.config.ts");
  const playwrightEntry = require.resolve("@playwright/test");
  await writeFile(
    configPath,
    [
      `import config from ${JSON.stringify(desktopConfig)};`,
      `export default { ...config, testDir: ${JSON.stringify(fixtureDir)} };`,
    ].join("\n"),
  );
  const runDiscovery = () =>
    spawnSync(
      process.execPath,
      [require.resolve("@playwright/test/cli"), "test", "--config", configPath, "--list"],
      { cwd: root, env: { ...process.env, CI: "true" }, encoding: "utf8", timeout: 30_000 },
    );

  await writeFile(
    specPath,
    `import { test } from ${JSON.stringify(playwrightEntry)};\ntest.only('guard fixture', () => {});\n`,
  );
  const rejected = runDiscovery();
  assert.ifError(rejected.error);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, /forbidOnly/);

  await writeFile(
    specPath,
    `import { test } from ${JSON.stringify(playwrightEntry)};\ntest('guard fixture', () => {});\n`,
  );
  const accepted = runDiscovery();
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /guard fixture/);
});
