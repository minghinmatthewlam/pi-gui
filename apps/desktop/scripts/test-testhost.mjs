// Runs the core specs listed in tests/testhost-ready.txt against pi-gui-testhost.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const entries = readFileSync(resolve(desktopDir, "tests/testhost-ready.txt"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((entry) => `apps/desktop/tests/core/${entry}`);
const extra = process.argv.slice(2).filter((arg) => arg !== "--");
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "playwright",
    "test",
    "-c",
    "apps/desktop/playwright.testhost.config.ts",
    ...entries,
    ...extra,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PI_APP_TEST_TARGET: "testhost",
      PI_APP_TEST_LANE: "core",
      PI_APP_REAL_AUTH: "0",
    },
  },
);
process.exit(result.status ?? 1);
