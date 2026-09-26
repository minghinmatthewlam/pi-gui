import { defineConfig } from "@playwright/test";

// Demo recordings run one at a time, on demand, outside CI discovery.
export default defineConfig({
  testDir: __dirname,
  timeout: 600_000,
  workers: 1,
  retries: 0,
});
