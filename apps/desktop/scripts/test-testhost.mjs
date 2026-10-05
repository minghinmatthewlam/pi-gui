// Runs the core specs listed in tests/testhost-ready.txt against pi-gui-testhost.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
} from "node:fs";
import { resolve } from "node:path";

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const entries = readFileSync(resolve(desktopDir, "tests/testhost-ready.txt"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((entry) => `apps/desktop/tests/core/${entry}`);
const build = process.argv.includes("--build");
if (build) {
  // Cargo can take another checkout's build of these sources as fresh when they share a target
  // folder; newer sources here make it rebuild from this checkout.
  const now = new Date();
  for (const entry of readdirSync(resolve(repoRoot, "crates"), { recursive: true })) {
    if (String(entry).endsWith(".rs"))
      utimesSync(resolve(repoRoot, "crates", String(entry)), now, now);
  }
  const cargo = spawnSync("cargo", ["build", "-p", "pi-gui-testhost"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (cargo.status !== 0) process.exit(cargo.status ?? 1);
}
// Run a private copy of the test host: checkouts that share a cargo target folder rebuild the
// same binary path from their own sources, which would swap it out mid-run. The copy is taken
// right after this checkout's build; without `--build` the last copy is reused.
let testHostBin = process.env.PI_GUI_TESTHOST_BIN?.trim();
if (!testHostBin) {
  testHostBin = resolve(desktopDir, "out/testhost/pi-gui-testhost");
  if (build) {
    const built = resolve(
      process.env.CARGO_TARGET_DIR ?? resolve(repoRoot, "target"),
      "debug/pi-gui-testhost",
    );
    mkdirSync(resolve(testHostBin, ".."), { recursive: true });
    // Copy then rename, so a test host still running from the old copy keeps its file.
    copyFileSync(built, `${testHostBin}.new`);
    renameSync(`${testHostBin}.new`, testHostBin);
  } else if (!existsSync(testHostBin)) {
    console.error("No test host copy yet: run with --build first.");
    process.exit(1);
  }
}
const extra = process.argv.slice(2).filter((arg) => arg !== "--" && arg !== "--build");
// Spec paths passed on the command line run instead of the whole list.
const named = extra.some((arg) => /\.spec\.ts(:\d+)?$/.test(arg));
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "playwright",
    "test",
    "-c",
    "apps/desktop/playwright.testhost.config.ts",
    ...(named ? [] : entries),
    ...extra,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PI_APP_TEST_TARGET: "testhost",
      ...(testHostBin ? { PI_GUI_TESTHOST_BIN: testHostBin } : {}),
      PI_APP_TEST_LANE: "core",
      PI_APP_REAL_AUTH: "0",
    },
  },
);
process.exit(result.status ?? 1);
