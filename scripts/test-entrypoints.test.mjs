import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("root e2e delegates to the built, isolated desktop core lane", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const desktop = JSON.parse(await readFile(path.join(root, "apps/desktop/package.json"), "utf8"));
  assert.equal(manifest.scripts.e2e, "pnpm --filter @pi-gui/desktop run test:e2e:core");
  assert.match(desktop.scripts["test:e2e:core"], /^pnpm build && /);
  assert.match(desktop.scripts["test:e2e:core"], /PI_APP_TEST_MODE=background/);
  assert.match(
    desktop.scripts["test:e2e:core"],
    /playwright test -c apps\/desktop\/playwright\.config\.ts apps\/desktop\/tests\/core$/,
  );
});

test("root Playwright entrypoint preserves desktop safeguards and rejects focused tests", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "pi-gui-entrypoint-guard-"));
  const configPath = path.join(fixtureDir, "playwright.config.ts");
  const specPath = path.join(fixtureDir, "guard.spec.ts");
  const rootConfig = path.join(root, "playwright.config.ts");
  const desktopConfig = path.join(root, "apps/desktop/playwright.config.ts");
  await writeFile(
    configPath,
    [
      `import config from ${JSON.stringify(rootConfig)};`,
      `import desktop from ${JSON.stringify(desktopConfig)};`,
      `if (config !== desktop) throw new Error('Root must reuse the canonical desktop config');`,
      `if (config.testDir !== ${JSON.stringify(path.join(root, "apps/desktop/tests"))}) throw new Error('Canonical testDir must resolve correctly through root');`,
      `export default { ...config, testDir: ${JSON.stringify(fixtureDir)} };`,
    ].join("\n"),
  );
  const runDiscovery = () =>
    spawnSync(
      process.execPath,
      [require.resolve("@playwright/test/cli"), "test", "--config", configPath, "--list"],
      { cwd: root, env: { ...process.env, CI: "true" }, encoding: "utf8", timeout: 30_000 },
    );
  const playwrightEntry = require.resolve("@playwright/test");
  for (const focused of [true, false]) {
    await writeFile(
      specPath,
      `import { test } from ${JSON.stringify(playwrightEntry)};\ntest${focused ? ".only" : ""}('entrypoint guard', () => {});\n`,
    );
    const result = runDiscovery();
    assert.ifError(result.error);
    if (focused) {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /forbidOnly/);
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /entrypoint guard/);
    }
  }
});
