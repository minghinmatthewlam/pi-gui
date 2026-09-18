import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/desktop/tests",
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
