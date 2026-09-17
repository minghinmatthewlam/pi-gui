import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const outputDir = path.join(desktopDir, "build", "native");
const helpers = [
  {
    sourcePath: path.join(desktopDir, "resources", "notification-status-helper.swift"),
    outputPath: path.join(outputDir, "pi-gui-notification-status-helper"),
  },
];

if (process.platform !== "darwin") {
  console.log("Skipping notification status helper build outside macOS.");
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
for (const helper of helpers) {
  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const slicePath = `${helper.outputPath}-${arch}`;
    slices.push(slicePath);
    await execFileAsync(
      "xcrun",
      ["swiftc", helper.sourcePath, "-O", "-target", `${arch}-apple-macosx12.0`, "-o", slicePath],
      { cwd: desktopDir },
    );
  }
  await execFileAsync("lipo", ["-create", ...slices, "-o", helper.outputPath], { cwd: desktopDir });
  await Promise.all(slices.map((slicePath) => rm(slicePath, { force: true })));
  console.log(`Built native helper at ${helper.outputPath}`);
}
