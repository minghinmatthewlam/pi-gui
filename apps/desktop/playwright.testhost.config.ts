import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * The core specs against `pi-gui-testhost` (the Rust app-state kernel) with the built renderer
 * in Chromium. Run through `pnpm test:e2e:testhost`, which builds both and passes the specs
 * listed in tests/testhost-ready.txt.
 */
export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  testDir: resolve(__dirname, "tests/core"),
  timeout: 60_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  workers: Number(process.env.PI_APP_TEST_WORKERS) || 1,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
