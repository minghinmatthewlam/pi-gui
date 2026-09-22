import { fileURLToPath } from "node:url";

export const browserBuildOptions = {
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/frame-bridge.ts"],
  outfile: "dist/frame-bridge.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
};
