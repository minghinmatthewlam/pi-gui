import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredPackages = ["chalk", "glob", "hosted-git-info", "minimatch"];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const asarPath = path.join(desktopDir, "release", "mac-arm64", "pi-gui.app", "Contents", "Resources", "app.asar");
const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (!existsSync(asarPath)) {
  throw new Error(`Packaged app.asar not found at ${asarPath}. Run the packaging step first.`);
}

const asarListing = execFileSync(pnpmBinary, ["exec", "asar", "list", asarPath], {
  cwd: desktopDir,
  encoding: "utf8",
});

const missingPackages = requiredPackages.filter((packageName) => {
  const escaped = packageName.replace("/", "\\/");
  const pattern = new RegExp(`^/node_modules/${escaped}(/|$)`, "m");
  return !pattern.test(asarListing);
});

if (missingPackages.length > 0) {
  throw new Error(`Packaged app is missing runtime dependencies: ${missingPackages.join(", ")}`);
}

console.log(`Verified packaged runtime dependencies in ${asarPath}`);
