// Builds the Rust `pi-gui-core` process and copies it to build/native, where the app and
// electron-builder pick it up.
import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const binaryName = process.platform === "win32" ? "pi-gui-core.exe" : "pi-gui-core";
const outputDir = path.join(desktopDir, "build", "native");

await execFileAsync("cargo", ["build", "--release", "--locked", "-p", "pi-gui-core"], {
  cwd: repoRoot,
  maxBuffer: 16 * 1024 * 1024,
});
await mkdir(outputDir, { recursive: true });
await copyFile(
  path.join(repoRoot, "target", "release", binaryName),
  path.join(outputDir, binaryName),
);
console.log(`Built pi-gui-core at ${path.join(outputDir, binaryName)}`);
