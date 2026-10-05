import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Specs against `pi-gui-testhost` (the Rust app-state kernel) with the built renderer in
 * Chromium. Build first: `pnpm --filter @pi-gui/desktop run build` and
 * `cargo build -p pi-gui-testhost`.
 */
export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  testDir: resolve(__dirname, "tests/testhost"),
  timeout: 60_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  workers: Number(process.env.PI_APP_TEST_WORKERS) || 1,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
