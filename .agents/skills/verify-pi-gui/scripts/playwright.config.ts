import { defineConfig } from "@playwright/test";
import base from "../../../../apps/desktop/playwright.config";
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: ["proof.spec.ts", "conversation.spec.ts", "maintenance.spec.ts"],
  retries: 0,
});
