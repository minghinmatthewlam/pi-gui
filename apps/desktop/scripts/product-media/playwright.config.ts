import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: ["capture.media.ts"],
  retries: 0,
  timeout: 900_000,
});
