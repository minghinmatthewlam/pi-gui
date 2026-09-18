import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  testDir: resolve(__dirname, "tests"),
  // Demo specs record marketing videos on demand; keep them out of default/CI discovery.
  testIgnore: "**/demo/**",
  timeout: 60_000,
  // CI runners are routinely 2-3x slower than dev machines; the default 5s
  // expect timeout flakes on UI convergence that is sub-second locally.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  // Electron user-surface tests are materially more reliable when one app owns the input loop at a time.
  workers: 1,
  retries: process.env.PI_APP_TEST_MODE === "foreground" ? 1 : 0,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
